#!/usr/bin/env python3
"""Compare fixed patches, adaptive patches and guarded masked ECC on local triplets."""
import argparse
from collections import Counter
import itertools
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

import inspect_motion as motion
import similarity_fit

METHOD = 'opencv-alignment-comparison-v1'
METHODS = ('fixed', 'adaptive', 'ecc', 'translation_first', 'similarity', 'direct_affine')
CONFIG = dict(candidateStep=8, packingStarts=8, templateGuard=10,
              eccGuard=13, eccMinPixels=1000, eccMinCorrelation=.8,
              eccMaxIterations=40, eccStepEpsilon=.001, eccMaxDisplacement=8.,
              eccentricityMin=.95, eccentricityMax=1.05,
              controlWoodShift=[2., -1.], controlHeadShifts=[0, 1, 2],
              controlAppearances=['clean', 'brightness', 'blur', 'brightness_blur'],
              eccValidationCoordinates='wood_aligned')
TRANSLATION_CONFIG = dict(search=8, minCorrelation=.8, minPeakMargin=.04,
                         minTextureStd=5., minGradientEigenRatio=.01,
                         minAffineEigenRatio=.001, minAffineScoreGain=.002,
                         affineStableCornerStepPx=.05, affineStableIterations=3,
                         gaussianSize=5,backgroundGaussianSize=9)


def center_of(box):
    return np.array([(box[0]+box[2])/2, (box[1]+box[3])/2])


def expanded(box, padding):
    return np.array(box)+[-padding, -padding, padding, padding]


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def clear_box(mask, box):
    l, t, r, b = np.rint(box).astype(int)
    mask[max(t, 0):min(b, mask.shape[0]), max(l, 0):min(r, mask.shape[1])] = 0


def safe_fit_mask(allowed, validators):
    reference_fit = allowed.copy()
    for row in validators:
        clear_box(reference_fit, expanded(row['box'], CONFIG['templateGuard']))
    guard = CONFIG['eccGuard']
    safe = cv2.erode(reference_fit, np.ones((2*guard+1, 2*guard+1), np.uint8),
                     borderType=cv2.BORDER_CONSTANT, borderValue=0)
    return safe


def mask_surrounds(mask, center):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    return motion.encloses(np.concatenate(contours).reshape(-1, 2), center)


def layout_eligible(layout, center):
    fit = [center_of(x['box']) for x in layout if x['role'] == 'fit']
    val = [center_of(x['box']) for x in layout if x['role'] == 'validation']
    return (len(fit) >= 6 and len(val) >= 3 and
            motion.encloses(fit, center) and motion.encloses(val, center))


def adaptive_layout(reference, roi, excluded, board):
    start = time.perf_counter()
    _, allowed = motion.mask_layout(reference, roi, excluded, board)
    image = motion.gray(reference)
    h, w = image.shape
    size, guard = motion.CONFIG['templateSize'], CONFIG['templateGuard']
    candidates = []
    # Self-match tests texture distinctness in A, never similarity to center or B.
    for y in range(guard, h-size-guard, CONFIG['candidateStep']):
        for x in range(guard, w-size-guard, CONFIG['candidateStep']):
            if not np.all(allowed[y-guard:y+size+guard, x-guard:x+size+guard]):
                continue
            box = [x, y, x+size, y+size]
            quality = motion.match(image, image, box)
            if quality['ok']:
                candidates.append(dict(box=box, quality=quality['peakMargin']))
    candidates.sort(key=lambda x: (-x['quality'], x['box'][1], x['box'][0]))
    center = center_of(roi)
    best, best_mask, best_score = [], np.zeros_like(allowed), None
    for seed in range(min(CONFIG['packingStarts'], len(candidates))):
        order = [candidates[seed]]+[c for i, c in enumerate(candidates) if i != seed]
        packed = []
        for row in order:
            if all(not overlaps(expanded(row['box'], guard), expanded(p['box'], guard)) for p in packed):
                packed.append(row)
        choices = []
        for indices in itertools.combinations(range(len(packed)), 3):
            val = [packed[i] for i in indices]
            if not motion.encloses([center_of(x['box']) for x in val], center):
                continue
            fit = [p for i, p in enumerate(packed) if i not in indices]
            eligible = len(fit) >= 6 and motion.encloses([center_of(x['box']) for x in fit], center)
            choices.append((bool(eligible), min(v['quality'] for v in val), indices))
        # Limit mask construction to the best reference-only choices for each packing.
        for eligible, quality, indices in sorted(choices, reverse=True)[:12]:
            val = [packed[i] for i in indices]
            fit_mask = safe_fit_mask(allowed, val)
            pixels = int(np.count_nonzero(fit_mask))
            dense_ok = pixels >= CONFIG['eccMinPixels'] and mask_surrounds(fit_mask, center)
            score = (bool(dense_ok), eligible, len(packed), quality, pixels)
            if best_score is None or score > best_score:
                best_score = score
                best = [dict(p, role='validation' if i in indices else 'fit') for i, p in enumerate(packed)]
                best_mask = fit_mask
    diagnostics = dict(candidates=len(candidates), selected=len(best),
                       templateEligible=layout_eligible(best, center),
                       eccEligible=int(np.count_nonzero(best_mask)) >= CONFIG['eccMinPixels'] and mask_surrounds(best_mask, center),
                       eccFitPixels=int(np.count_nonzero(best_mask)),
                       elapsedMs=(time.perf_counter()-start)*1000)
    if not best:
        diagnostics['reason'] = 'reference_cannot_supply_three_surrounding_validators'
    return best, best_mask, diagnostics


def bounded_warp(matrix, shape):
    if not np.isfinite(matrix).all():
        return False
    h, w = shape[:2]
    points = np.array([[0,0],[w-1,0],[w-1,h-1],[0,h-1]], float)
    singular = np.linalg.svd(matrix[:2, :2], compute_uv=False)
    return bool(np.isfinite(matrix).all() and np.linalg.det(matrix[:2, :2]) > 0 and
                np.min(singular) >= CONFIG['eccentricityMin'] and
                np.max(singular) <= CONFIG['eccentricityMax'] and
                np.max(np.linalg.norm(motion.project(matrix, points)-points, axis=1)) <= CONFIG['eccMaxDisplacement'])


def fit_ecc(a, b, safe_mask, seed=None, require_stable=False):
    """One guarded iteration per call prevents excursions into withheld pixels."""
    matrix = np.eye(3, dtype=np.float64) if seed is None else np.array(seed,dtype=np.float64).copy()
    if not bounded_warp(matrix,a.shape):
        return None, dict(reason='ecc_seed_outside_guard',iterations=0)
    previous = matrix.copy()
    correlation = None
    stable_steps=0
    h,w=a.shape
    corners=np.array([[0,0],[w-1,0],[w-1,h-1],[0,h-1]],float)
    for iteration in range(CONFIG['eccMaxIterations']):
        try:
            correlation, warp = cv2.findTransformECC(
                a/255., b/255., matrix[:2].astype(np.float32), cv2.MOTION_AFFINE,
                (cv2.TERM_CRITERIA_COUNT, 1, -1), safe_mask*255, 5)
        except cv2.error:
            return None, dict(reason='ecc_did_not_converge', iterations=iteration)
        matrix = np.vstack([warp, [0., 0., 1.]])
        # Reject immediately, before another iteration can use an out-of-bounds mask.
        if not bounded_warp(matrix, a.shape):
            return None, dict(reason='ecc_transform_outside_guard', iterations=iteration+1)
        change = float(np.max(np.abs(matrix-previous)))
        corner_step=float(np.max(np.linalg.norm(motion.project(matrix,corners)-motion.project(previous,corners),axis=1)))
        stable_steps=stable_steps+1 if corner_step <= TRANSLATION_CONFIG['affineStableCornerStepPx'] else 0
        if (stable_steps>=TRANSLATION_CONFIG['affineStableIterations'] if require_stable else change < CONFIG['eccStepEpsilon']):
            break
        previous = matrix.copy()
    if require_stable and stable_steps<TRANSLATION_CONFIG['affineStableIterations']:
        return None, dict(reason='ecc_affine_unstable',iterations=iteration+1,
                          lastCornerStepPx=corner_step,stableSteps=stable_steps)
    return matrix, dict(eccCorrelation=float(correlation), iterations=iteration+1,
                        reachedStepTolerance=change < CONFIG['eccStepEpsilon'],
                        stableCornerSteps=stable_steps,lastCornerStepPx=corner_step)


def masked_score(a_values,b_values):
    """Zero-mean correlation only on explicitly supplied fitting pixels."""
    av=a_values.astype(np.float64)-float(np.mean(a_values))
    bv=b_values.astype(np.float64)-float(np.mean(b_values))
    denominator=np.sqrt(np.sum(av*av)*np.sum(bv*bv))
    return float(np.sum(av*bv)/denominator) if denominator>1e-9 else -1.


def score_transform(a,b,mask,matrix):
    ys,xs=np.nonzero(mask)
    mapped=motion.project(matrix,np.column_stack([xs,ys]))
    xf,yf=mapped[:,0],mapped[:,1]
    x0,y0=np.floor(xf).astype(int),np.floor(yf).astype(int)
    if np.any(x0<0) or np.any(y0<0) or np.any(x0+1>=b.shape[1]) or np.any(y0+1>=b.shape[0]):
        return -1.
    dx,dy=xf-x0,yf-y0
    values=(b[y0,x0]*(1-dx)*(1-dy)+b[y0,x0+1]*dx*(1-dy)+
            b[y0+1,x0]*(1-dx)*dy+b[y0+1,x0+1]*dx*dy)
    return masked_score(a[ys,xs],values)


def fit_translation_first(a,b,safe_mask,refinement='affine'):
    """Fit without reading held-out scores; affine may only refine a safe seed."""
    cfg=TRANSLATION_CONFIG
    ys,xs=np.nonzero(safe_mask)
    if refinement not in ('affine','similarity','direct_affine'):
        raise ValueError('unknown refinement')
    diag=dict(registration=refinement if refinement!='affine' else 'translation_first',selectedModel='none')
    if len(xs)<CONFIG['eccMinPixels']:
        return None,dict(diag,reason='translation_insufficient_support')
    radius=cfg['search']
    if float(np.std(a[ys,xs]))<cfg['minTextureStd']:
        return None,dict(diag,reason='translation_weak_texture')
    if min(xs.min(),ys.min(),a.shape[1]-1-xs.max(),a.shape[0]-1-ys.max())<radius+1:
        return None,dict(diag,reason='translation_search_clipped')
    # Fit grain detail rather than a broad illumination ramp. Radius 4 plus
    # 8px motion and bilinear support fits the existing 13px erosion guard.
    # Held-out patches and head matching continue to use unfiltered pixels.
    kernel=cfg['gaussianSize']
    background=cfg['backgroundGaussianSize']
    smooth_a=cv2.GaussianBlur(a,(kernel,kernel),0)-cv2.GaussianBlur(a,(background,background),0)
    smooth_b=cv2.GaussianBlur(b,(kernel,kernel),0)-cv2.GaussianBlur(b,(background,background),0)
    reference=smooth_a[ys,xs]
    # Gradient and affine observability use reference fitting pixels only.
    gx=cv2.Sobel(smooth_a,cv2.CV_32F,1,0,ksize=3)[ys,xs].astype(float)
    gy=cv2.Sobel(smooth_a,cv2.CV_32F,0,1,ksize=3)[ys,xs].astype(float)
    gradients=np.column_stack([gx,gy]); eig=np.linalg.eigvalsh(gradients.T@gradients)
    ratio=float(eig[0]/max(eig[-1],1e-9))
    diag['gradientEigenRatio']=ratio
    if ratio<cfg['minGradientEigenRatio']:
        return None,dict(diag,reason='translation_aperture_ambiguous')
    response=np.full((2*radius+1,2*radius+1),-1.,float)
    for dy in range(-radius,radius+1):
        for dx in range(-radius,radius+1):
            if dx*dx+dy*dy<=radius*radius:
                response[dy+radius,dx+radius]=masked_score(reference,smooth_b[ys+dy,xs+dx])
    py,px=np.unravel_index(np.argmax(response),response.shape)
    score=float(response[py,px])
    others=response.copy();others[max(0,py-2):py+3,max(0,px-2):px+3]=-1
    margin=score-float(others.max())
    dx,dy=float(px-radius),float(py-radius)
    boundary=np.hypot(dx,dy)>=radius-1
    diag.update(translationIntegerScore=score,translationPeakMargin=margin,
                translationPeakBoundary=bool(boundary))
    if boundary or margin<cfg['minPeakMargin']:
        return None,dict(diag,reason='translation_ambiguous_match')
    for axis in (0,1):
        v=response[py,px-1:px+2] if axis==0 else response[py-1:py+2,px]
        curvature=float(v[0]-2*v[1]+v[2])
        delta=float(np.clip(.5*(v[0]-v[2])/curvature,-.5,.5)) if curvature < -1e-9 else 0.
        if axis==0:dx+=delta
        else:dy+=delta
    seed=motion.translation(dx,dy)
    if not bounded_warp(seed,a.shape):
        return None,dict(diag,reason='translation_outside_guard')
    seed_score=score_transform(smooth_a,smooth_b,safe_mask,seed)
    diag.update(translationScore=seed_score,translationVector=[dx,dy],
                selectedModel='translation',eccCorrelation=seed_score,
                reachedStepTolerance=False)
    def keep_translation(reason):
        result=dict(diag,**{refinement+'Reason':reason})
        if seed_score<cfg['minCorrelation']:
            return None,dict(result,reason='translation_refined_score_low')
        return seed,result
    if refinement in ('similarity','direct_affine'):
        kwargs={'model':'affine'} if refinement=='direct_affine' else {}
        candidate,details=similarity_fit.fit(smooth_a,smooth_b,safe_mask,seed,bounded_warp,**kwargs)
        diag[refinement+'Diagnostics']=details
        if candidate is None:
            return keep_translation(details['reason'])
        score=score_transform(smooth_a,smooth_b,safe_mask,candidate)
        diag[refinement+'Score']=score
        if score<seed_score+cfg['minAffineScoreGain']:
            return keep_translation(refinement+'_no_fit_improvement')
        if score<cfg['minCorrelation']:
            return None,dict(diag,reason=refinement+'_score_low')
        diag.update(selectedModel=refinement,eccCorrelation=score,
                    reachedStepTolerance=True,**{refinement+'Reason':'accepted'})
        return candidate,diag
    x=(xs-xs.mean())/max(a.shape); y=(ys-ys.mean())/max(a.shape)
    jac=np.column_stack([gx*x,gx*y,gy*x,gy*y,gx,gy])
    norms=np.linalg.norm(jac,axis=0)
    jac/=np.maximum(norms,1e-9)
    eig=np.linalg.eigvalsh(jac.T@jac)
    affine_ratio=float(max(eig[0],0)/max(eig[-1],1e-9))
    diag['affineEigenRatio']=affine_ratio
    if affine_ratio<cfg['minAffineEigenRatio']:
        return keep_translation('affine_underconstrained')
    affine,detail=fit_ecc(a,b,safe_mask,seed=seed,require_stable=True)
    diag['affineDiagnostics']=detail
    if affine is None:
        return keep_translation(detail['reason'])
    affine_score=score_transform(smooth_a,smooth_b,safe_mask,affine)
    diag['affineScore']=affine_score
    if affine_score<seed_score+cfg['minAffineScoreGain']:
        return keep_translation('affine_no_fit_improvement')
    if affine_score<cfg['minCorrelation']:
        return None,dict(diag,reason='translation_affine_score_low')
    diag.update(selectedModel='translation_affine',eccCorrelation=affine_score,
                reachedStepTolerance=detail['reachedStepTolerance'],affineReason='accepted')
    return affine,diag


def fit_registration(a,b,safe_mask,registration='ecc'):
    if registration=='ecc':
        return fit_ecc(a,b,safe_mask)
    if registration=='translation_first':
        return fit_translation_first(a,b,safe_mask)
    if registration in ('similarity','direct_affine'):
        return fit_translation_first(a,b,safe_mask,registration)
    raise ValueError('unknown registration method')


def measure_ecc(reference, target, roi, initial, layout, fit_mask,registration='ecc'):
    start = time.perf_counter()
    h, w = reference.shape[:2]
    coarse = cv2.warpPerspective(target, initial, (w, h),
                                 flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    valid = cv2.warpPerspective(np.ones(target.shape[:2], np.uint8), initial, (w, h),
                                flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    result = dict(status='uncertain', reasons=[], woodTemplates=[], physicalHeight='not_measured', pnDecision='not_made')
    def finish(reason=None, aligned=None):
        if reason:
            result['reasons'].append(reason)
        result['elapsedMs'] = (time.perf_counter()-start)*1000
        return result, coarse if aligned is None else aligned
    validators = [x for x in layout if x['role'] == 'validation']
    if len(validators) < 3:
        return finish('reference_cannot_supply_three_surrounding_validators')
    safe = fit_mask & cv2.erode(valid, np.ones((27,27), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
    if np.count_nonzero(safe) < CONFIG['eccMinPixels'] or not mask_surrounds(safe, center_of(roi)):
        return finish('insufficient_reserved_ecc_wood_support')
    result['fitPixels'] = int(np.count_nonzero(safe))
    a, b = motion.gray(reference), motion.gray(coarse)
    delta, diagnostics = fit_registration(a, b, safe,registration)
    result.update(diagnostics)
    if delta is None:
        return finish(diagnostics['reason'])
    result['woodTransform'] = delta.tolist()
    full = initial @ delta
    aligned = cv2.warpPerspective(target, full, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    if result['eccCorrelation'] < CONFIG['eccMinCorrelation']:
        return finish('ecc_fit_correlation_low', aligned)
    refined_valid = cv2.warpPerspective(np.ones(target.shape[:2], np.uint8), full, (w,h),
                                        flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    aligned_gray = motion.gray(aligned)
    residuals, passed = [], 0
    search = motion.CONFIG['search']
    for template in validators:
        x, y, r, bot = template['box']
        entry = dict(template, match=dict(ok=False, reason='validation_support_clipped'))
        # Validate on the wood-aligned image, so the held-out patch receives the
        # fitted rotation/scale as well as translation. The 23px reserved margin
        # covers the bounded 8px warp + 8px search + interpolation/filter support.
        if np.all(refined_valid[y-search:bot+search, x-search:r+search]):
            entry['match'] = motion.match(a, aligned_gray, template['box'])
        match = entry['match']
        if match['ok']:
            residual = float(np.hypot(match['xPx'], match['yPx']))
            entry['residualPx'] = residual
            residuals.append(residual)
            passed += residual <= motion.CONFIG['maxWoodResidualPx']
        result['woodTemplates'].append(entry)
    result.update(validationCount=len(residuals), validationPassed=int(passed), validationResidualsPx=residuals)
    if passed != len(validators):
        return finish('held_out_wood_does_not_validate_plane', aligned)
    result['woodAccepted'] = True
    result.update(motion.measure_head(reference, aligned, refined_valid, roi))
    return finish(aligned=aligned)


def run_method(method, reference, target, roi, initial, fixed, adaptive, fit_mask):
    if method in ('ecc','translation_first','similarity','direct_affine'):
        return measure_ecc(reference, target, roi, initial, adaptive, fit_mask,method)
    return motion.measure_pair(reference, target, roi, initial, fixed if method == 'fixed' else adaptive)


def controlled_target(reference, roi, relative_shift, appearance):
    """Known image-space patch shift, not a physical protrusion simulation."""
    image = reference.copy()
    if relative_shift:
        l, t, r, b = np.rint(expanded(roi, 3)).astype(int)
        if min(l,t) < 0 or r >= image.shape[1] or b+relative_shift >= image.shape[0]:
            raise ValueError('control head patch clipped')
        patch = image[t:b,l:r].copy()
        mask = np.zeros(image.shape[:2], np.uint8)
        mask[t:b,l:r] = 255
        image = cv2.inpaint(image, mask, 3, cv2.INPAINT_TELEA)
        image[t+relative_shift:b+relative_shift,l:r] = patch
    matrix = motion.translation(*CONFIG['controlWoodShift'])
    image = cv2.warpPerspective(image, matrix, (image.shape[1],image.shape[0]))
    if 'blur' in appearance:
        image = cv2.GaussianBlur(image, (5,5), .8)
    if 'brightness' in appearance:
        image = np.clip(image.astype(float)*.8+15,0,255).astype(np.uint8)
    return image


def summarize(rows, controls):
    summaries = {}
    for method in METHODS:
        pairs = [p for row in rows for p in row['methods'][method]['pairs'].values()]
        measured = [p for p in pairs if p['status'] == 'measured']
        c = [p for p in controls if p['method'] == method]
        cm = [p for p in c if p['measurement']['status'] == 'measured']
        zero = [p for p in c if p['relativeShiftPx'] == 0]
        zero_accepted = [p for p in zero if p['measurement']['status'] == 'measured']
        summaries[method] = dict(
            referenceEligible=sum(row['eligibility'][method] for row in rows),
            pairs=len(pairs), woodAccepted=sum(bool(p.get('woodAccepted')) for p in pairs),
            measuredPairs=len(measured), pairRejections=dict(Counter(r for p in pairs for r in p['reasons'])),
            trajectories=dict(Counter(row['methods'][method]['trajectory']['status'] for row in rows)),
            controls=dict(total=len(c), measured=len(cm), rejected=len(c)-len(cm),
                          medianVectorErrorPx=float(np.median([p['vectorErrorPx'] for p in cm])) if cm else None,
                          maxVectorErrorPx=max((p['vectorErrorPx'] for p in cm), default=None),
                          zeroShiftTotal=len(zero), zeroShiftMeasured=len(zero_accepted),
                          falseMotionOver075px=sum(p['measurement']['residualPx']>.75 for p in zero_accepted),
                          falseMotionAtLeast15px=sum(p['measurement']['residualPx']>=1.5 for p in zero_accepted)))
    return summaries


def render_comparison(data, output):
    import html
    esc = lambda s: html.escape(str(s), quote=True)
    table = '<table><tr><th>Method</th><th>Reference eligible</th><th>Wood accepted</th><th>Head measured</th><th>Control accepted</th><th>False movement ≥1.5px</th></tr>'
    for name, summary in data['summary'].items():
        c = summary['controls']
        table += f'<tr><td>{esc(name)}</td><td>{summary["referenceEligible"]}/{len(data["items"])}</td><td>{summary["woodAccepted"]}/{summary["pairs"]}</td><td>{summary["measuredPairs"]}/{summary["pairs"]}</td><td>{c["measured"]}/{c["total"]}</td><td>{c["falseMotionAtLeast15px"]}/{c["zeroShiftMeasured"]} accepted zero controls</td></tr>'
    table += '</table>'
    cards = []
    for item in data['items']:
        figures = ''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>' for name,path in item['images'].items())
        methods = ''
        for name, result in item['methods'].items():
            pairs = '; '.join(n+': '+p['status']+' ('+', '.join(p['reasons'])+')' for n,p in result['pairs'].items())
            methods += f'<p><b>{esc(name)}</b> — {esc(result["trajectory"]["status"])}<br>{esc(pairs)}</p>'
        cards.append(f'<article><h2>{esc(item["id"])} · <small>{esc(item.get("reviewCategory", "unreviewed"))}</small></h2><p>{esc(item["group"])}</p><div class="images">{figures}</div>{methods}<details><summary>Measurements / layout diagnostics</summary><pre>{esc(json.dumps(item,indent=2))}</pre></details></article>')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>Adaptive wood alignment comparison</title><style>
body{font:16px system-ui;background:#101a24;color:#e8f0f8;margin:28px;line-height:1.5}article,section{background:#1a2b3a;border-radius:12px;padding:20px;margin:20px 0}td,th{padding:12px;text-align:left;border-bottom:1px solid #405367}table{border-collapse:collapse}small{font-size:14px;font-weight:400}.images{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}img{width:224px;height:224px;object-fit:contain;image-rendering:pixelated;background:#000}figcaption{font-size:12px}pre{white-space:pre-wrap;max-height:450px;overflow:auto}input{padding:10px}a{color:#74caff}</style>
<h1>Adaptive wood selection and masked ECC</h1><p>Offline comparison on the same saved pixels. Reference labels are not inputs to alignment.</p>'''
    page += '<section><h2>Results</h2>'+table+'<p>Reference eligibility is checked before looking at the other views. Wood/head counts are image pairs (A→center and A→B). Failed pairs remain uncertain. A measured pair does not establish a PN.</p>'
    page += '<p>Controls reuse real A crops with known 0/1/2-pixel head-patch displacements, a 2/−1-pixel whole-image translation, brightness changes and blur. These are image-space controls, not simulations of physical nail height. All rejected controls remain in the denominator.</p>'
    page += '<p>ECC uses wood pixels excluding nails and held-out validation search footprints. Every solver step is bounded before the next step. Three reference-selected wood validators must still match independently. Preview images can be rejected; visual similarity alone is not sufficient.</p>'
    page += '<p><a href="results.json">Full results and controls</a></p></section><input id="filter" placeholder="Filter ID or reference label">'
    page += ''.join(cards)
    page += "<script>document.getElementById('filter').oninput=e=>document.querySelectorAll('article').forEach(a=>a.hidden=!a.innerText.toLowerCase().includes(e.target.value.toLowerCase()));</script></html>"
    (output/'review.html').write_text(page)


def run(manifests, output, control_groups=4):
    inputs = [(path, motion.load_manifest(path)) for path in manifests]
    seen = set()
    for _, data in inputs:
        for item in data['items']:
            if item['id'] in seen:
                raise ValueError('IDs must be unique across manifests')
            seen.add(item['id'])
    if output.exists():
        raise ValueError('output directory already exists')
    if not 0 <= control_groups <= 100:
        raise ValueError('control-groups must be 0..100 per manifest')
    output.mkdir(parents=True)
    (output/'images').mkdir()
    rows, controls, selected_controls = [], [], []
    for manifest, data in inputs:
        chosen_groups = set()
        for item in data['items']:
            index = len(rows)
            reference = cv2.imread(item['views']['A']['_path'])
            roi = item['roi']
            fixed, _ = motion.mask_layout(reference, roi, item.get('excludedBoxes', []), item.get('boardPolygon', []))
            adaptive, fit_mask, diagnostics = adaptive_layout(reference, roi, item.get('excludedBoxes', []), item.get('boardPolygon', []))
            row = {k:item[k] for k in ('id','group','reviewCategory','reviewNote') if k in item}
            row.update(methods={}, images={}, layout=diagnostics, adaptiveLayout=adaptive,
                       eligibility=dict(fixed=layout_eligible(fixed,center_of(roi)),adaptive=diagnostics['templateEligible'],ecc=diagnostics['eccEligible']),
                       sourceHashes={name:motion.digest(v['_path']) for name,v in item['views'].items()})
            row['eligibility']['translation_first']=diagnostics['eccEligible']
            row['eligibility']['similarity']=diagnostics['eccEligible']
            row['eligibility']['direct_affine']=diagnostics['eccEligible']
            cx,cy = np.rint(center_of(roi)).astype(int)
            def detail(image):
                return image[max(0,cy-48):min(image.shape[0],cy+48),max(0,cx-48):min(image.shape[1],cx+48)]
            def save(name, image):
                filename = f'images/{index:04d}-{name}.png'
                if not cv2.imwrite(str(output/filename),image):
                    raise OSError('image write failed')
                row['images'][name] = filename
            save('A-head',detail(reference))
            save('reference-layout',motion.overlay(reference,roi,adaptive,{}))
            mask_image = reference.copy()
            mask_image[fit_mask == 0] = (mask_image[fit_mask == 0]*.2).astype(np.uint8)
            save('ECC-fit-mask',mask_image)
            for method in METHODS:
                pairs = {}
                for name in ('center','B'):
                    view = item['views'][name]
                    target = cv2.imread(view['_path'])
                    initial = np.array(view['referenceToView'],float).reshape(3,3)
                    pair, aligned = run_method(method,reference,target,roi,initial,fixed,adaptive,fit_mask)
                    pairs[name] = pair
                    if method == 'ecc':
                        save(name+'-ECC-preview',detail(aligned))
                    if method == 'translation_first':
                        save(name+'-translation-first-preview',detail(aligned))
                    if method == 'similarity':
                        save(name+'-similarity-preview',detail(aligned))
                    if method == 'direct_affine':
                        save(name+'-direct-affine-preview',detail(aligned))
                    if method == 'adaptive' and name == 'B':
                        save('B-adaptive-preview',detail(aligned))
                row['methods'][method] = dict(pairs=pairs,trajectory=motion.classify_trajectory(pairs,item.get('baselines')))
            rows.append(row)
            # Select the first item per physical group, without considering labels or eligibility.
            if len(chosen_groups) < control_groups and item['group'] not in chosen_groups:
                chosen_groups.add(item['group'])
                selected_controls.append(dict(id=item['id'],group=item['group']))
                for shift,appearance in itertools.product(CONFIG['controlHeadShifts'],CONFIG['controlAppearances']):
                    target = controlled_target(reference,roi,shift,appearance)
                    for method in METHODS:
                        measurement, _ = run_method(method,reference,target,roi,np.eye(3),fixed,adaptive,fit_mask)
                        result = dict(id=item['id'],group=item['group'],method=method,relativeShiftPx=shift,appearance=appearance,measurement=measurement)
                        if 'woodTransform' in measurement:
                            actual=motion.project(np.array(measurement['woodTransform']),[center_of(roi)])[0]-center_of(roi)
                            result['woodErrorPx']=float(np.linalg.norm(actual-CONFIG['controlWoodShift']))
                        if measurement['status']=='measured':
                            result['vectorErrorPx']=float(np.linalg.norm(np.array(measurement['vectorPx'])-[0,shift]))
                        controls.append(result)
            print(f'Processed {len(rows)}/{len(seen)}: {item["id"]}',file=sys.stderr,flush=True)
    result = dict(method=METHOD,configuration=CONFIG,translationConfiguration=TRANSLATION_CONFIG,headAndTemplateGates=motion.CONFIG,
                  similarityConfiguration=similarity_fit.CONFIG,similarityAlgorithmSha256=motion.digest(similarity_fit.__file__),
                  sourceManifests=[dict(path=str(path),sha256=motion.digest(path)) for path,_ in inputs],
                  algorithmSha256=motion.digest(__file__),sharedAlgorithmSha256=motion.digest(motion.__file__),
                  opencvVersion=cv2.__version__,items=rows,controls=controls,controlSelection=selected_controls,
                  summary=summarize(rows,controls),pnDecision='not_made',physicalHeight='not_measured')
    (output/'results.json').write_text(json.dumps(result,indent=2,allow_nan=False))
    render_comparison(result,output)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,action='append',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--control-groups',type=int,default=4,help='First N distinct physical groups per input, 0 disables controls')
    args=parser.parse_args()
    try:
        result=run([p.resolve() for p in args.input],args.output.resolve(),args.control_groups)
        print(json.dumps(result['summary'],indent=2))
    except (ValueError,KeyError,TypeError,OSError,cv2.error) as error:
        print(str(error),file=sys.stderr);return 2
    return 0


if __name__=='__main__':
    raise SystemExit(main())
