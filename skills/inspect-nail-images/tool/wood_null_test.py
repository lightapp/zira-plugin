#!/usr/bin/env python3
"""Held-out wood null test: identical registration, nested 24/48/64px probes."""
import argparse
from collections import Counter
import html
import json
from pathlib import Path
import sys

import cv2
import numpy as np

import compare_alignment as alignment
import inspect_motion as motion

METHOD = 'opencv-held-out-wood-null-v1'
CONFIG = dict(sizes=[24,48,64], candidateStep=8, maxProbesPerItem=2,
              minimumProbeSeparation=96, controlGroupsPerInput=4,
              controlShifts=[[2.,-1.],[2.35,-1.65]],
              controlAppearances=['clean','brightness','blur','brightness_blur'])
SIMILARITY_CONTROLS = [dict(shift=[2.,-1.],rotationDegrees=.6,scale=1.006),
                      dict(shift=[2.35,-1.65],rotationDegrees=-.6,scale=.994)]
AFFINE_CONTROLS = [dict(shift=[2.,-1.],linear=[[1.008,.010],[-.006,.993]]),
                   dict(shift=[2.35,-1.65],linear=[[.993,-.009],[.007,1.007]])]


def control_configuration(geometry):
    if geometry=='similarity':return SIMILARITY_CONTROLS
    if geometry=='affine':return AFFINE_CONTROLS
    if geometry=='translation':
        return [dict(shift=shift,rotationDegrees=0.,scale=1.) for shift in CONFIG['controlShifts']]
    raise ValueError('unknown control geometry')


def control_transforms(shape,geometry):
    for case in control_configuration(geometry):
        radius=max(shape)
        if geometry=='affine':
            parameters=[*case['shift'],*((np.array(case['linear'])-np.eye(2))*radius).ravel()]
            matrix=alignment.similarity_fit.matrix_for(parameters,shape,'affine')
        else:
            theta=np.radians(case['rotationDegrees']);scale=case['scale']
            p=[*case['shift'],(scale*np.cos(theta)-1)*radius,scale*np.sin(theta)*radius]
            matrix=alignment.similarity_fit.matrix_for(p,shape)
        yield dict(case,matrix=matrix.tolist())


def box_at(center, size):
    x,y = center
    return [int(x-size//2),int(y-size//2),int(x+size//2),int(y+size//2)]


def select_probes(reference, roi, excluded, board):
    """Choose using A only. Reserve the largest footprint for every patch size."""
    _, allowed = motion.mask_layout(reference,roi,excluded,board)
    a = motion.gray(reference)
    h,w = a.shape
    maximum = max(CONFIG['sizes'])
    guard = alignment.CONFIG['templateGuard']
    radius = maximum//2+guard
    candidates = []
    for y in range(radius,h-radius,CONFIG['candidateStep']):
        for x in range(radius,w-radius,CONFIG['candidateStep']):
            if not np.all(allowed[y-radius:y+radius,x-radius:x+radius]):
                continue
            box = box_at([x,y],maximum)
            quality = motion.match(a,a,box)
            if quality['ok']:
                candidates.append(dict(center=[x,y],box=box,referenceQuality=quality))
    candidates.sort(key=lambda p:(-p['referenceQuality']['peakMargin'],p['center'][1],p['center'][0]))
    probes = []
    no_support = 0
    for candidate in candidates:
        center = candidate['center']
        if any(np.linalg.norm(np.array(center)-p['center'])<CONFIG['minimumProbeSeparation'] for p in probes):
            continue
        mask = alignment.safe_fit_mask(allowed,[dict(box=candidate['box'])])
        count = int(np.count_nonzero(mask))
        if count < alignment.CONFIG['eccMinPixels'] or not alignment.mask_surrounds(mask,center):
            no_support += 1
            continue
        probes.append(dict(candidate,fitMask=mask,fitPixels=count,
                           selfMatches={str(s):motion.match(a,a,box_at(center,s)) for s in CONFIG['sizes']}))
        if len(probes)==CONFIG['maxProbesPerItem']:
            break
    return probes, dict(candidateCount=len(candidates),selected=len(probes),
                        insufficientFitSupport=no_support,
                        reason='' if probes else 'no_distinct_64px_wood_probe_with_independent_fit_support')


def appearance_metrics(a,b):
    a,b = a.astype(np.float32),b.astype(np.float32)
    va,vb = float(a.var()),float(b.var())
    la = float(cv2.Laplacian(a,cv2.CV_32F).var())
    lb = float(cv2.Laplacian(b,cv2.CV_32F).var())
    # Relative high-frequency energy, normalized against local contrast. It is
    # affected by blur, JPEG, sampling, material and interpolation, not just focus.
    sharp_a,sharp_b = la/max(va,1e-6),lb/max(vb,1e-6)
    return dict(meanA=float(a.mean()),meanOther=float(b.mean()),
                brightnessDelta=float(b.mean()-a.mean()),contrastRatio=float(np.sqrt(vb/max(va,1e-6))),
                normalizedSharpnessA=sharp_a,normalizedSharpnessOther=sharp_b,
                normalizedSharpnessRatio=sharp_b/max(sharp_a,1e-6))


def evaluate_probe(reference,target,initial,probe,registration='ecc'):
    h,w = reference.shape[:2]
    coarse = cv2.warpPerspective(target,initial,(w,h),flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP)
    valid = cv2.warpPerspective(np.ones(target.shape[:2],np.uint8),initial,(w,h),
                               flags=cv2.INTER_NEAREST|cv2.WARP_INVERSE_MAP)
    safe = probe['fitMask'] & cv2.erode(valid,np.ones((27,27),np.uint8),
                                      borderType=cv2.BORDER_CONSTANT,borderValue=0)
    fit = dict(accepted=False,fitPixels=int(np.count_nonzero(safe)))
    result = dict(fit=fit,patches={},expectedResidualPx=0.,pnDecision='not_made')
    if fit['fitPixels'] < alignment.CONFIG['eccMinPixels'] or not alignment.mask_surrounds(safe,probe['center']):
        fit['reason']='insufficient_reserved_wood_support'
        return result,coarse
    delta,diagnostics = alignment.fit_registration(motion.gray(reference),motion.gray(coarse),safe,registration)
    fit.update(diagnostics)
    if delta is None:
        return result,coarse
    fit['woodTransform']=delta.tolist()
    full = initial @ delta
    aligned = cv2.warpPerspective(target,full,(w,h),flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP)
    if fit['eccCorrelation'] < alignment.CONFIG['eccMinCorrelation']:
        fit['reason']='ecc_fit_correlation_low'
        return result,aligned
    fit.update(accepted=True,reason='')
    result['patches'],aligned=measure_patches(reference,target,full,probe)
    return result,aligned


def measure_patches(reference,target,full,probe):
    """Measure a supplied transform; also used for known-transform controls."""
    h,w=reference.shape[:2]
    aligned=cv2.warpPerspective(target,full,(w,h),flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP)
    patches={}
    good = cv2.warpPerspective(np.ones(target.shape[:2],np.uint8),full,(w,h),
                               flags=cv2.INTER_NEAREST|cv2.WARP_INVERSE_MAP)
    a,b = motion.gray(reference),motion.gray(aligned)
    search = motion.CONFIG['search']
    for size in CONFIG['sizes']:
        box = box_at(probe['center'],size)
        l,t,r,bot = box
        row = dict(box=box,matchAccepted=False,nearZero=False)
        if not np.all(good[t-search:bot+search,l-search:r+search]):
            row['reason']='held_out_search_clipped'
        else:
            match = motion.match(a,b,box)
            row.update(match=match,appearance=appearance_metrics(a[t:bot,l:r],b[t:bot,l:r]))
            # Also examine untouched target pixels: inverse warping can itself
            # lower high-frequency energy. This bounding box is approximate and
            # intentionally reported separately from same-grid measurements.
            corners = motion.project(full,[[l,t],[r,t],[r,bot],[l,bot]])
            nl,nt = np.floor(corners.min(axis=0)).astype(int)
            nr,nb = np.ceil(corners.max(axis=0)).astype(int)
            if 0 <= nl < nr <= target.shape[1] and 0 <= nt < nb <= target.shape[0]:
                row['nativeTargetRect']=[int(nl),int(nt),int(nr),int(nb)]
                row['nativeBoundingBoxAppearance']=appearance_metrics(a[t:bot,l:r],motion.gray(target)[nt:nb,nl:nr])
            if match['ok']:
                residual=float(np.hypot(match['xPx'],match['yPx']))
                row.update(matchAccepted=True,residualPx=residual,
                           nearZero=residual<=motion.CONFIG['maxWoodResidualPx'],
                           apparentMotionAtLeast15px=residual>=1.5,
                           reason='' if residual<=motion.CONFIG['maxWoodResidualPx'] else 'wood_residual_above_075px')
            else:
                row['reason']=match['reason']
        patches[str(size)] = row
    return patches,aligned


def summarize(rows):
    summary = {}
    for size in CONFIG['sizes']:
        patches = [r['patches'].get(str(size)) for r in rows]
        measured = [p for p in patches if p and p['matchAccepted']]
        summary[str(size)] = dict(total=len(rows),fitAccepted=sum(r['fit']['accepted'] for r in rows),
            matchAccepted=len(measured),nearZero=sum(p['nearZero'] for p in measured),
            apparentMotionAtLeast15px=sum(p['apparentMotionAtLeast15px'] for p in measured),
            medianResidualPx=float(np.median([p['residualPx'] for p in measured])) if measured else None,
            p90ResidualPx=float(np.percentile([p['residualPx'] for p in measured],90)) if measured else None,
            unmatchedOrFitRejected=len(rows)-len(measured),
            reasons=dict(Counter(r['fit'].get('reason','fit_rejected') if not r['fit']['accepted'] else r['patches'][str(size)]['reason'] for r in rows)))
    return summary


def diagnostic_summary(rows):
    patches=[r['patches']['64'] for r in rows if '64' in r['patches']]
    failed=[p for p in patches if not p['matchAccepted']]
    def appearance_summary(ps):
        result={}
        for field in ('appearance','nativeBoundingBoxAppearance'):
            metrics=[p[field] for p in ps if field in p]
            result[field]=dict(count=len(metrics),
                medianAbsoluteBrightnessDelta=float(np.median([abs(m['brightnessDelta']) for m in metrics])) if metrics else None,
                medianNormalizedSharpnessRatio=float(np.median([m['normalizedSharpnessRatio'] for m in metrics])) if metrics else None)
        return result
    return dict(at64px=dict(
        failedCorrelation=sum(p.get('match',{}).get('correlation',1)<motion.CONFIG['minCorrelation'] for p in failed),
        failedPeakMargin=sum(p.get('match',{}).get('peakMargin',1)<motion.CONFIG['minPeakMargin'] for p in failed),
        boundaryPeak=sum(p.get('match',{}).get('boundary',False) for p in failed),
        matched=appearance_summary([p for p in patches if p['matchAccepted']]),
        unmatched=appearance_summary(failed)),
        fitReachedStepTolerance=sum(r['fit'].get('reachedStepTolerance',False) for r in rows),
        fitAcceptedWithoutStepTolerance=sum(r['fit']['accepted'] and r['fit'].get('registration') not in ('translation_first','similarity','direct_affine') and not r['fit'].get('reachedStepTolerance',False) for r in rows),
        selectedModels=dict(Counter(r['fit'].get('selectedModel','legacy_ecc') for r in rows)),
        affineReasons=dict(Counter(r['fit'].get('affineReason','not_attempted') for r in rows)),
        similarityReasons=dict(Counter(r['fit'].get('similarityReason','not_attempted') for r in rows)),
        directAffineReasons=dict(Counter(r['fit'].get('direct_affineReason','not_attempted') for r in rows)))


def render_report(result,output):
    esc=lambda s:html.escape(str(s),quote=True)
    table='<table><tr><th>Patch</th><th>Real matches</th><th>Near zero ≤0.75px</th><th>Apparent wood motion ≥1.5px</th><th>Median residual</th><th>Control near-zero</th></tr>'
    for size,s in result['summary']['real'].items():
        c=result['summary']['controls'][size]
        median='—' if s['medianResidualPx'] is None else f'{s["medianResidualPx"]:.3f}px'
        table+=f'<tr><td>{size}px</td><td>{s["matchAccepted"]}/{s["total"]}</td><td>{s["nearZero"]}/{s["total"]}</td><td>{s["apparentMotionAtLeast15px"]}/{s["matchAccepted"]} matched</td><td>{median}</td><td>{c["nearZero"]}/{c["total"]}</td></tr>'
    table+='</table>'
    controls_table='<table><tr><th>Patch</th><th>Estimated transform near zero</th><th>Known transform near zero</th><th>Estimated wood motion ≥1.5px</th><th>Known transform wood motion ≥1.5px</th></tr>'
    for size,c in result['summary']['controls'].items():
        oracle=result['summary']['knownTransformControls'][size]
        controls_table+=f'<tr><td>{size}px</td><td>{c["nearZero"]}/{c["total"]}</td><td>{oracle["nearZero"]}/{oracle["total"]}</td><td>{c["apparentMotionAtLeast15px"]}</td><td>{oracle["apparentMotionAtLeast15px"]}</td></tr>'
    controls_table+='</table>'
    cards=[]
    for item in result['items']:
        if not item['probes']:
            continue
        probes=[]
        for probe in item['probes']:
            figures=''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>' for name,path in probe['images'].items())
            metrics=''
            for view,pair in probe['pairs'].items():
                line=f'{view}: fit '+('accepted' if pair['fit']['accepted'] else pair['fit'].get('reason','rejected'))
                for size,p in pair['patches'].items():
                    line+=f'; {size}px '+(f'{p["residualPx"]:.2f}px residual' if p['matchAccepted'] else 'ambiguous')
                metrics+=f'<p>{esc(line)}</p>'
            probes.append(f'<h3>Wood probe {probe["ordinal"]}</h3><div class="images">{figures}</div>{metrics}<details><summary>Matching, brightness and sharpness metrics</summary><pre>{esc(json.dumps(probe,indent=2))}</pre></details>')
        cards.append(f'<article id="{esc(item["id"])}"><h2>{esc(item["id"])} · <small>{esc(item["group"])}</small></h2>'+''.join(probes)+'</article>')
    control_cards=[]
    for control in result['controls']:
        if control['fit']['accepted'] and all(p['nearZero'] or not p['matchAccepted'] for p in control['patches'].values()):
            continue
        figures=''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>' for name,path in control['images'].items())
        geometry=control.get('geometry',{})
        geometry_label=('linear '+str(geometry['linear']) if 'linear' in geometry else
                        str(geometry.get('rotationDegrees',0))+'° / scale '+str(geometry.get('scale',1)))
        control_cards.append(f'<article><h2>Known-zero control · {esc(control["id"])} · {esc(control["shift"])} · {esc(geometry_label)} · {esc(control["appearance"])}</h2><div class="images">{figures}</div><details><summary>Control measurements</summary><pre>{esc(json.dumps(control,indent=2))}</pre></details></article>')
    page='''<!doctype html><html lang="en"><meta charset="utf-8"><title>Wood-only null test</title><style>
body{font:16px system-ui;background:#101a24;color:#e7eef7;margin:28px;line-height:1.5}article,section{background:#1b2a38;padding:22px;border-radius:14px;margin:20px 0}table{border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #456}.images{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0}img{width:224px;height:224px;object-fit:contain;image-rendering:pixelated;background:#000}figcaption,small{font-size:12px}pre{white-space:pre-wrap;max-height:450px;overflow:auto}a{color:#7dcaff}input{padding:10px}</style><h1>Wood-only null test · 24 / 48 / 64 pixels</h1>
<p>The same wood should have approximately zero residual after alignment to its plane. These are diagnostics, not PN decisions.</p>'''
    page+='<section><p>Registration: <strong>'+esc(result['registration'])+'</strong></p>'+table+f'<p>{result["summary"]["itemsWithProbes"]}/{len(result["items"])} source neighborhoods supplied eligible probes. Selection uses A only, excludes known nails, board margins and blue pixels, and requires a full 64px wood footprint. Smaller-only locations are not included. Undetected nails or incorrect board annotations remain possible; inspect context images.</p>'
    page+='<p>Every size uses the same center and fitted transform. The largest probe, search region and motion/filter guards are withheld from fitting for all sizes. Rejected fits and ambiguous matches remain in denominators. Near-zero wood movement validates that probe only; it does not establish reliable nail motion.</p>'
    page+='<p>Normalized sharpness is a relative high-frequency proxy; it is affected by blur, JPEG, resampling and material, and cannot identify camera focus or shutter settings by itself. Native target bounding boxes are approximate footprints. Normalized correlation already compensates for uniform gain/offset changes.</p><details><summary>64px rejection and appearance diagnostics</summary><pre>'+esc(json.dumps(result['diagnostics'],indent=2))+'</pre></details><a href="results.json">Full measurements</a></section>'
    page+='<section><h2>Known-zero controls</h2>'+controls_table+f'<p>{len(result["controlSources"])} source crops, reused across two {esc(result["controlGeometry"])} transforms and four appearance conditions. These are not independent specimens. All controls contain zero relative motion. The known-transform comparison bypasses registration using the exact generated transform; it diagnoses interpolation and matching separately from fitting.</p><details><summary>Control geometry</summary><pre>'+esc(json.dumps(result['controlGeometryConfiguration'],indent=2))+'</pre></details><p>A high fitting score and a transform within guards are fit diagnostics, not validation. Controls with false residuals or rejected fitting are shown below.</p></section><input id="filter" placeholder="Filter sample ID">'
    page+=''.join(control_cards)+''.join(cards)+"<script>document.getElementById('filter').oninput=e=>document.querySelectorAll('article').forEach(a=>a.hidden=!a.innerText.toLowerCase().includes(e.target.value.toLowerCase()));</script></html>"
    (output/'review.html').write_text(page)


def run(manifests,output,registration='ecc',control_geometry='translation'):
    if registration not in ('ecc','translation_first','similarity','direct_affine'):
        raise ValueError('unknown registration method')
    if control_geometry not in ('translation','similarity','affine'):
        raise ValueError('unknown control geometry')
    inputs=[(path,motion.load_manifest(path)) for path in manifests]
    ids=[i['id'] for _,d in inputs for i in d['items']]
    if len(set(ids))!=len(ids):
        raise ValueError('IDs must be unique across inputs')
    if output.exists():
        raise ValueError('output directory already exists')
    output.mkdir(parents=True)
    (output/'images').mkdir()
    items,real,controls,control_sources=[],[],[],[]
    for path,data in inputs:
        selected_groups=set()
        for item in data['items']:
            a=cv2.imread(item['views']['A']['_path'])
            probes,diag=select_probes(a,item['roi'],item.get('excludedBoxes',[]),item.get('boardPolygon',[]))
            row=dict(id=item['id'],group=item['group'],selection=diag,probes=[],
                     sourceHashes={n:motion.digest(v['_path']) for n,v in item['views'].items()})
            for pi,probe in enumerate(probes):
                entry={k:v for k,v in probe.items() if k!='fitMask'}
                entry.update(ordinal=pi+1,pairs={},images={})
                def save(name,image):
                    filename=f'images/{len(items):04d}-{pi}-{name}.png'
                    if not cv2.imwrite(str(output/filename),image):
                        raise OSError('image write failed')
                    entry['images'][name]=filename
                l,t,r,b=probe['box']
                context=motion.overlay(a,item['roi'],[dict(box=probe['box'],role='validation')],{})
                for excluded in item.get('excludedBoxes',[]):
                    x0,y0,x1,y1=np.rint(excluded).astype(int)
                    cv2.rectangle(context,(x0,y0),(x1,y1),(70,70,220),1)
                save('context-known-nails-excluded',context)
                save('A-wood',a[t:b,l:r])
                masked=a.copy();masked[probe['fitMask']==0]=(masked[probe['fitMask']==0]*.2).astype(np.uint8)
                save('independent-fit-mask',masked)
                for name in ('center','B'):
                    view=item['views'][name];target=cv2.imread(view['_path'])
                    measurement,aligned=evaluate_probe(a,target,np.array(view['referenceToView'],float).reshape(3,3),probe,registration)
                    measurement.update(id=item['id'],group=item['group'],probe=pi+1,view=name)
                    entry['pairs'][name]=measurement;real.append(measurement)
                    save(name+'-wood-preview',aligned[t:b,l:r])
                    native=measurement['patches'].get('64',{}).get('nativeTargetRect')
                    if native:
                        nl,nt,nr,nb=native
                        save(name+'-native-approximate-wood',target[nt:nb,nl:nr])
                if pi==0 and len(selected_groups)<CONFIG['controlGroupsPerInput'] and item['group'] not in selected_groups:
                    selected_groups.add(item['group']);control_sources.append(dict(id=item['id'],group=item['group']))
                    for geometry in control_transforms(a.shape[:2],control_geometry):
                        shift=geometry['shift'];known_transform=np.array(geometry['matrix'])
                        for appearance in CONFIG['controlAppearances']:
                            target=cv2.warpPerspective(a,known_transform,(a.shape[1],a.shape[0]))
                            if 'blur' in appearance:target=cv2.GaussianBlur(target,(5,5),.8)
                            if 'brightness' in appearance:target=np.clip(target.astype(float)*.8+15,0,255).astype(np.uint8)
                            measurement,aligned=evaluate_probe(a,target,np.eye(3),probe,registration)
                            oracle,known_aligned=measure_patches(a,target,known_transform,probe)
                            measurement.update(id=item['id'],group=item['group'],appearance=appearance,shift=shift,geometry=geometry,
                                knownTransform=dict(fit=dict(accepted=True,reason='known_generated_transform'),patches=oracle),
                                images={'A-wood':entry['images']['A-wood'],
                                        'independent-fit-mask':entry['images']['independent-fit-mask']})
                            if measurement['fit']['accepted']:
                                estimated=np.array(measurement['fit']['woodTransform'])
                                error=motion.project(estimated,[probe['center']])-motion.project(known_transform,[probe['center']])
                                measurement['fitErrorAtProbePx']=float(np.linalg.norm(error))
                            for name,image in [('fit-preview',aligned[t:b,l:r]),('known-transform-preview',known_aligned[t:b,l:r])]:
                                filename=f'images/control-{len(controls):03d}-{name}.png'
                                if not cv2.imwrite(str(output/filename),image):raise OSError('control image write failed')
                                measurement['images'][name]=filename
                            controls.append(measurement)
                row['probes'].append(entry)
            items.append(row)
            print(f'Processed {len(items)}/{len(ids)}: {item["id"]} ({len(probes)} wood probes)',file=sys.stderr,flush=True)
    summary=dict(itemsWithProbes=sum(bool(i['probes']) for i in items),probes=sum(len(i['probes']) for i in items),
                 real=summarize(real),controls=summarize(controls),
                 knownTransformControls=summarize([r['knownTransform'] for r in controls]))
    result=dict(method=METHOD,registration=registration,configuration=CONFIG,matchingGates=motion.CONFIG,eccGates=alignment.CONFIG,
                controlGeometry=control_geometry,
                controlGeometryConfiguration=control_configuration(control_geometry),
                translationConfiguration=alignment.TRANSLATION_CONFIG,
                similarityConfiguration=alignment.similarity_fit.CONFIG,
                sourceManifests=[dict(path=str(p),sha256=motion.digest(p)) for p,_ in inputs],
                algorithmHashes={Path(p).name:motion.digest(p) for p in [__file__,motion.__file__,alignment.__file__,alignment.similarity_fit.__file__]},
                opencvVersion=cv2.__version__,items=items,controls=controls,controlSources=control_sources,
                summary=summary,diagnostics=diagnostic_summary(real),pnDecision='not_made',physicalHeight='not_measured')
    (output/'results.json').write_text(json.dumps(result,indent=2,allow_nan=False))
    render_report(result,output)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,action='append',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--registration',choices=['ecc','translation_first','similarity','direct_affine'],default='ecc')
    parser.add_argument('--control-geometry',choices=['translation','similarity','affine'],default='translation')
    args=parser.parse_args()
    try:
        result=run([p.resolve() for p in args.input],args.output.resolve(),args.registration,args.control_geometry)
        print(json.dumps(result['summary'],indent=2))
    except (ValueError,KeyError,TypeError,OSError,cv2.error) as error:
        print(str(error),file=sys.stderr);return 2
    return 0


if __name__=='__main__':raise SystemExit(main())
