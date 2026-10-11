#!/usr/bin/env python3
"""Offline, label-independent motion relative to wood; never a height classifier."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np

METHOD = 'opencv-wood-relative-motion-v1'
CONFIG = dict(templateSize=24, gridSpacing=48, search=8, boardInset=8,
              nailExclusion=12, minTextureStd=5, minCorrelation=.80,
              minPeakMargin=.04, minFitTemplates=6, minValidationTemplates=3,
              ransacPx=.8, maxWoodResidualPx=.75, minInlierFraction=.65,
              maxChannelDisagreementPx=.75, maxRoundTripPx=.75,
              minRelativeMotionPx=1.5, maxRelativeMotionPx=6,
              maxCenterTrajectoryErrorPx=.75, minDirectionCosine=.8)
SMOOTHING_CONFIG = dict(kernelSize=3, sigma=.8, headGradientRadius=2)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def gray(image):
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)


def matching_gray(image, smoothing=False):
    """Optional fixed preprocessing for matching only; registration is unchanged."""
    result=gray(image)
    if smoothing:
        size=SMOOTHING_CONFIG['kernelSize']
        result=cv2.GaussianBlur(result,(size,size),SMOOTHING_CONFIG['sigma'])
    return result


def gradient(image):
    smooth = cv2.GaussianBlur(image, (3, 3), .6)
    return cv2.magnitude(cv2.Sobel(smooth, cv2.CV_32F, 1, 0),
                         cv2.Sobel(smooth, cv2.CV_32F, 0, 1))


def project(matrix, points):
    p = np.asarray(points, np.float64).reshape(-1, 2)
    matrix = np.asarray(matrix, np.float64)
    h = np.column_stack([matrix[i, 0]*p[:, 0]+matrix[i, 1]*p[:, 1]+matrix[i, 2]
                         for i in range(3)])
    if not np.isfinite(h).all() or np.any(np.abs(h[:, 2]) < 1e-10):
        raise ValueError('invalid projective mapping')
    return h[:, :2] / h[:, 2:3]


def translation(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1.]], np.float64)


def ink_mask(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    b, g, r = cv2.split(image.astype(np.int16))
    mask = ((hsv[:, :, 0] >= 90) & (hsv[:, :, 0] <= 135) &
            (hsv[:, :, 1] >= 55) & (b > r+8) & (b > g+3)).astype(np.uint8)
    return cv2.dilate(mask, np.ones((3, 3), np.uint8))


def match(reference, target, box):
    x, y, right, bottom = map(int, box)
    search = CONFIG['search']
    h, w = target.shape
    if x-search < 0 or y-search < 0 or right+search > w or bottom+search > h:
        return dict(ok=False, reason='search_clipped')
    template = reference[y:bottom, x:right]
    if template.size == 0 or float(template.std()) < CONFIG['minTextureStd']:
        return dict(ok=False, reason='weak_texture')
    response = cv2.matchTemplate(target[y-search:bottom+search, x-search:right+search],
                                 template, cv2.TM_CCOEFF_NORMED)
    _, score, _, (px, py) = cv2.minMaxLoc(response)
    others = response.copy()
    others[max(0, py-2):py+3, max(0, px-2):px+3] = -1
    margin = score-float(others.max())
    boundary = px == 0 or py == 0 or px == 2*search or py == 2*search
    dx, dy = float(px-search), float(py-search)
    if not boundary:
        for axis in (0, 1):
            v = response[py, px-1:px+2] if axis == 0 else response[py-1:py+2, px]
            curvature = float(v[0]-2*v[1]+v[2])
            delta = float(np.clip(.5*(v[0]-v[2])/curvature, -.5, .5)) if curvature < -1e-6 else 0.
            if axis == 0:
                dx += delta
            else:
                dy += delta
    ok = not boundary and score >= CONFIG['minCorrelation'] and margin >= CONFIG['minPeakMargin']
    return dict(ok=bool(ok), xPx=dx, yPx=dy, correlation=score, peakMargin=margin,
                boundary=boundary, reason='' if ok else 'ambiguous_template_match')


def mask_layout(reference, roi, excluded, board):
    """Fix disjoint fit/validation templates using reference pixels only."""
    h, w = reference.shape[:2]
    allowed = np.zeros((h, w), np.uint8)
    if board:
        cv2.fillPoly(allowed, [np.rint(board).astype(np.int32)], 1)
    inset = CONFIG['boardInset']
    allowed = cv2.erode(allowed, np.ones((2*inset+1, 2*inset+1), np.uint8),
                        borderType=cv2.BORDER_CONSTANT, borderValue=0)
    exclusion = CONFIG['nailExclusion']
    for box in [roi, *excluded]:
        l, t, r, b = box
        cv2.rectangle(allowed, (int(np.floor(l-exclusion)), int(np.floor(t-exclusion))),
                       (int(np.ceil(r+exclusion)), int(np.ceil(b+exclusion))), 0, -1)
    allowed[ink_mask(reference) > 0] = 0
    templates = []
    size, spacing, search = CONFIG['templateSize'], CONFIG['gridSpacing'], CONFIG['search']
    luminance = gray(reference)
    # Each support region includes the complete target search footprint (40 px).
    # 48 px spacing keeps both fitted and held-out templates disjoint.
    for iy, y in enumerate(range(search+2, h-size-search-1, spacing)):
        for ix, x in enumerate(range(search+2, w-size-search-1, spacing)):
            if not np.all(allowed[y-search:y+size+search, x-search:x+size+search]):
                continue
            if float(luminance[y:y+size, x:x+size].std()) < CONFIG['minTextureStd']:
                continue
            templates.append(dict(box=[x, y, x+size, y+size],
                                  role='validation' if (ix+2*iy) % 3 == 0 else 'fit'))
    return templates, allowed


def encloses(points, center):
    if len(points) < 3:
        return False
    hull = cv2.convexHull(np.asarray(points, np.float32))
    return cv2.pointPolygonTest(hull, tuple(map(float, center)), False) >= 0


def measure_pair(reference, target, roi, initial, layout):
    start = time.perf_counter()
    h, w = reference.shape[:2]
    warped = cv2.warpPerspective(target, initial, (w, h),
                                 flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    valid = cv2.warpPerspective(np.ones(target.shape[:2], np.uint8), initial, (w, h),
                                flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    a, b = gray(reference), gray(warped)
    result = dict(status='uncertain', reasons=[], woodTemplates=[], physicalHeight='not_measured',
                  pnDecision='not_made')

    def finish(reason=None, aligned=None):
        if reason:
            result['reasons'].append(reason)
        result['elapsedMs'] = (time.perf_counter()-start)*1000
        return result, warped if aligned is None else aligned

    fitted, held = [], []
    search = CONFIG['search']
    for template in layout:
        box = template['box']
        x, y, r, bot = box
        entry = dict(**template, match=dict(ok=False, reason='warped_support_clipped'))
        if np.all(valid[y-search:bot+search, x-search:r+search]):
            entry['match'] = match(a, b, box)
        result['woodTemplates'].append(entry)
        if entry['match']['ok']:
            center = np.array([(x+r)/2, (y+bot)/2])
            moved = center + [entry['match']['xPx'], entry['match']['yPx']]
            (fitted if template['role'] == 'fit' else held).append((center, moved, entry))
    result['fitCount'], result['validationCount'] = len(fitted), len(held)
    if len(fitted) < CONFIG['minFitTemplates']:
        return finish('insufficient_independent_wood_fit_templates')
    pa, pb = np.array([v[0] for v in fitted]), np.array([v[1] for v in fitted])
    cv2.setRNGSeed(137)
    affine, flags = cv2.estimateAffine2D(pa, pb, method=cv2.RANSAC,
                                       ransacReprojThreshold=CONFIG['ransacPx'],
                                       maxIters=2000, confidence=.99, refineIters=10)
    if affine is None:
        return finish('wood_transform_missing')
    delta = np.vstack([affine, [0, 0, 1]])
    inliers = flags.ravel().astype(bool)
    center = np.array([(roi[0]+roi[2])/2, (roi[1]+roi[3])/2])
    error = np.linalg.norm(project(delta, pa)-pb, axis=1)
    p90 = float(np.percentile(error[inliers], 90))
    singular = np.linalg.svd(delta[:2, :2], compute_uv=False)
    result.update(woodTransform=delta.tolist(), inliers=int(inliers.sum()), fitP90Px=p90,
                  fitSurroundsHead=encloses(pa[inliers], center),
                  singularValues=singular.tolist())
    for index, row in enumerate(fitted):
        row[2].update(inlier=bool(inliers[index]), residualPx=float(error[index]))
    if (int(inliers.sum()) < CONFIG['minFitTemplates'] or inliers.mean() < CONFIG['minInlierFraction']
            or p90 > CONFIG['maxWoodResidualPx'] or not result['fitSurroundsHead']):
        return finish('wood_fit_weak_or_does_not_surround_head')
    if (np.any(singular < .95) or np.any(singular > 1.05)
            or np.linalg.det(delta[:2, :2]) <= 0
            or np.linalg.norm(project(delta, [center])[0]-center) > search):
        return finish('implausible_local_wood_transform')
    aligned = cv2.warpPerspective(target, initial @ delta, (w, h),
                                  flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    validations = []
    for point, moved, entry in held:
        residual = float(np.linalg.norm(project(delta, [point])[0]-moved))
        entry['residualPx'] = residual
        validations.append(residual)
    result['validationResidualsPx'] = validations
    if (len(held) < CONFIG['minValidationTemplates'] or
            not encloses([v[0] for v in held], center) or
            any(v > CONFIG['maxWoodResidualPx'] for v in validations)):
        return finish('held_out_wood_does_not_validate_plane', aligned)
    result['woodAccepted'] = True
    refined_valid = cv2.warpPerspective(np.ones(target.shape[:2], np.uint8), initial @ delta,
                                        (w, h), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP)
    result.update(measure_head(reference, aligned, refined_valid, roi))
    return finish(aligned=aligned)


def measure_head(reference, aligned, refined_valid, roi, smoothing=False):
    """Shared head gates for all alignment methods; no wood fitting happens here."""
    h, w = reference.shape[:2]
    search = CONFIG['search']
    a = matching_gray(reference,smoothing)
    ga = gradient(a)
    result = dict(status='uncertain', reasons=[], physicalHeight='not_measured', pnDecision='not_made')
    def reject(reason):
        result['reasons'].append(reason)
        return result
    l, t, r, bot = roi
    box = [int(np.floor(l)), int(np.floor(t)), int(np.ceil(r)), int(np.ceil(bot))]
    if min(r-l, bot-t) < 8 or max(r-l, bot-t) > 80:
        return reject('head_size_outside_8_to_80px')
    core_ink = ink_mask(reference)[box[1]:box[3], box[0]:box[2]]
    if float(core_ink.mean()) > .18:
        return reject('blue_ink_or_reflection_overlaps_head')
    x, y, right, bottom = box
    # Preserve the raw baseline. The optional path checks the whole added filter
    # and existing Gaussian/Sobel footprint, so invalid warped pixels cannot leak in.
    support=search+(SMOOTHING_CONFIG['kernelSize']//2+SMOOTHING_CONFIG['headGradientRadius'] if smoothing else 0)
    if (x-support < 0 or y-support < 0 or right+support > w or bottom+support > h or
            not np.all(refined_valid[y-support:bottom+support, x-support:right+support])):
        return reject('head_search_clipped')
    aligned_gray = matching_gray(aligned,smoothing)
    head_gradient = match(ga, gradient(aligned_gray), box)
    head_gray = match(a, aligned_gray, box)
    result.update(headGradient=head_gradient, headGray=head_gray)
    if not head_gradient['ok'] or not head_gray['ok']:
        return reject('head_match_ambiguous')
    vector = np.array([head_gradient['xPx'], head_gradient['yPx']])
    grayscale_vector = np.array([head_gray['xPx'], head_gray['yPx']])
    result['channelDisagreementPx'] = float(np.linalg.norm(vector-grayscale_vector))
    shifted = np.array(box)+np.tile(np.rint(vector).astype(int), 2)
    reverse = match(gradient(aligned_gray), ga, shifted)
    result['reverseHead'] = reverse
    result['residualPx'] = float(np.linalg.norm(vector))
    result['vectorPx'] = vector.tolist()
    if not reverse['ok']:
        return reject('reverse_head_match_ambiguous')
    result['roundTripPx'] = float(np.linalg.norm(np.rint(vector)+[reverse['xPx'], reverse['yPx']]))
    if (result['channelDisagreementPx'] > CONFIG['maxChannelDisagreementPx'] or
            result['roundTripPx'] > CONFIG['maxRoundTripPx'] or
            result['residualPx'] > CONFIG['maxRelativeMotionPx']):
        return reject('head_match_inconsistent')
    result['status'] = 'measured'
    return result


def classify_trajectory(pairs, baselines):
    result = dict(status='uncertain', reasons=[], physicalHeight='not_measured', pnDecision='not_made')
    if any(p['status'] != 'measured' for p in pairs.values()):
        result['reasons'] = ['one_or_both_pairs_unreliable']
        return result
    center, end = (np.asarray(pairs[name]['vectorPx']) for name in ('center', 'B'))
    total = float(np.linalg.norm(end))
    result['abResidualPx'] = total
    if total < CONFIG['minRelativeMotionPx']:
        result.update(status='below_pixel_threshold', reasons=['does_not_exclude_raised_nail'])
        return result
    if baselines is None:
        result['reasons'] = ['motion_baseline_missing']
        return result
    bc, bb = np.array(baselines['center']), np.array(baselines['B'])
    length = float(np.linalg.norm(bb))
    if length < 40:
        result['reasons'] = ['motion_baseline_too_short']
        return result
    fraction = float(np.dot(bc, bb)/np.dot(bb, bb))
    perpendicular = float(np.linalg.norm(bc-fraction*bb))
    error = float(np.linalg.norm(center-fraction*end))
    cosine = float(abs(np.dot(end, bb)/(total*length)))
    result.update(centerBaselineFraction=fraction, centerTrajectoryErrorPx=error,
                  directionCosine=cosine, baselinePx=length)
    if not .1 <= fraction <= .9 or perpendicular > .1*length:
        result['reasons'].append('baseline_not_ordered_or_straight')
    if error > CONFIG['maxCenterTrajectoryErrorPx']:
        result['reasons'].append('center_does_not_confirm_trajectory')
    if cosine < CONFIG['minDirectionCosine']:
        result['reasons'].append('residual_not_along_conveyor_motion')
    if not result['reasons']:
        result['status'] = 'repeatable_relative_motion'
    return result


def load_manifest(path):
    data = json.loads(path.read_text())
    items = data.get('items', [])
    if not isinstance(items, list) or not 1 <= len(items) <= 2000:
        raise ValueError('items must contain 1..2000 entries')
    ids = set()
    for item in items:
        if not isinstance(item.get('id'), str) or not item['id'] or item['id'] in ids or not item.get('group'):
            raise ValueError('unique nonempty id and physical-source group required')
        ids.add(item['id'])
        if set(item.get('views', {})) != {'A', 'center', 'B'}:
            raise ValueError('views must contain A, center and B')
        for name, view in item['views'].items():
            image_path = (path.parent / view['path']).resolve()
            image = cv2.imread(str(image_path))
            if image is None:
                raise ValueError(f'unreadable image: {image_path}')
            if max(image.shape[:2]) > 512:
                raise ValueError('supply native-pixel context crops no larger than 512px')
            view['_path'] = str(image_path)
            if name != 'A':
                matrix = np.asarray(view.get('referenceToView'), float)
                if matrix.size != 9 or not np.isfinite(matrix).all() or abs(np.linalg.det(matrix.reshape(3, 3))) < 1e-10:
                    raise ValueError('finite nonsingular referenceToView 3x3 required')
        roi = np.asarray(item.get('roi'), float)
        a = cv2.imread(item['views']['A']['_path'])
        if (roi.shape != (4,) or not np.isfinite(roi).all() or
                not 0 <= roi[0] < roi[2] <= a.shape[1] or not 0 <= roi[1] < roi[3] <= a.shape[0]):
            raise ValueError('roi must be a finite xyxy box inside A')
        polygon = np.asarray(item.get('boardPolygon', []), float)
        if polygon.size and (polygon.ndim != 2 or polygon.shape[1] != 2 or len(polygon) < 3 or not np.isfinite(polygon).all()):
            raise ValueError('boardPolygon must contain finite xy points')
        for box in item.get('excludedBoxes', []):
            box = np.asarray(box, float)
            if box.shape != (4,) or not np.isfinite(box).all() or box[2] <= box[0] or box[3] <= box[1]:
                raise ValueError('excludedBoxes must contain finite ordered xyxy boxes')
        if item.get('baselines') is not None:
            for name in ('center', 'B'):
                vector = np.asarray(item['baselines'].get(name), float)
                if vector.shape != (2,) or not np.isfinite(vector).all():
                    raise ValueError('baselines must contain finite center and B vectors')
    return data


def overlay(reference, roi, layout, pair):
    image = reference.copy()
    for entry in pair.get('woodTemplates', layout):
        x, y, r, b = entry['box']
        color = (220, 170, 0) if entry['role'] == 'validation' else (40, 190, 40)
        if not entry.get('match', {}).get('ok', True):
            color = (90, 90, 190)
        cv2.rectangle(image, (x, y), (r, b), color, 1)
    l, t, r, b = map(lambda x: int(round(x)), roi)
    cv2.rectangle(image, (l, t), (r, b), (0, 230, 255), 1)
    return image


def render_report(data, output):
    esc = lambda value: html.escape(str(value), quote=True)
    cards = []
    for item in data['items']:
        images = ''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>'
                         for name, path in item['images'].items())
        metrics = []
        for name, pair in item['pairs'].items():
            metrics.append(f'{name}: {pair["status"]}; fit {pair.get("inliers", 0)}; '
                           f'held-out {pair.get("validationCount", 0)}; '
                           f'head {pair.get("residualPx", "—")} px; '+', '.join(pair['reasons']))
        cards.append(f'<article data-status="{esc(item["trajectory"]["status"])}"><h2>{esc(item["id"])} '
                     f'<small>{esc(item.get("reviewCategory", "unreviewed"))}</small></h2>'
                     f'<p><strong>{esc(item["trajectory"]["status"])}</strong> · {esc(item["group"])}</p>'
                     f'<div class="images">{images}</div><p>{esc(metrics[0])}<br>{esc(metrics[1])}</p>'
                     f'<details><summary>Measurements and rejection reasons</summary><pre>{esc(json.dumps(item, indent=2))}</pre></details></article>')
    page = '''<!doctype html><html lang="en"><meta charset="utf-8"><title>Wood-relative nail motion</title>
<style>body{font:16px system-ui;background:#101821;color:#e5eef6;margin:24px;line-height:1.5}h1{margin-bottom:8px}
article{background:#1a2835;padding:20px;margin:20px 0;border-radius:12px}small{font-size:14px;font-weight:400;color:#abc}
.images{display:flex;flex-wrap:wrap;gap:14px}figure{margin:0;flex:0 0 256px}img{width:256px;height:256px;object-fit:contain;image-rendering:pixelated;background:#000}
figcaption{font-size:13px}pre{white-space:pre-wrap;font-size:12px;max-height:500px;overflow:auto}select,input{padding:8px;margin-right:8px}aside{max-width:1100px;color:#bfd0df}
</style><h1>Wood-relative nail motion · offline OpenCV</h1>'''
    page += f'<aside>{esc(data.get("description", ""))}<p>A is the reference. Center and B are aligned to A using wood only. '
    page += 'Green boxes fit the wood transform; cyan boxes validate it independently. Red boxes failed matching. '
    page += 'An alignment preview may still be rejected; it is not evidence of successful alignment. '
    page += 'Yellow boxes locate the supplied nail. Display uses nearest-neighbor enlargement; measurements use native pixels. '
    page += '<strong>Relative image motion is not a measured height or a PN verdict. Low motion does not prove a nail is seated.</strong></p>'
    page += f'<p>{esc(json.dumps(data["summary"]))}</p></aside>'
    page += '<input id="search" placeholder="Filter nail ID or label"><select id="status"><option value="">All results</option>'
    for status in ('repeatable_relative_motion', 'below_pixel_threshold', 'uncertain'):
        page += f'<option>{status}</option>'
    page += '</select><label>Zoom <input type="range" id="zoom" min="128" max="512" value="256"></label>'
    page += ''.join(cards)
    page += '''<script>
const search=document.getElementById('search'),status=document.getElementById('status');
function filter(){document.querySelectorAll('article').forEach(a=>a.hidden=!(a.innerText.toLowerCase().includes(search.value.toLowerCase())&&(!status.value||a.dataset.status===status.value)));}
search.oninput=filter;status.onchange=filter;document.getElementById('zoom').oninput=e=>document.querySelectorAll('img').forEach(i=>{i.style.width=e.target.value+'px';i.style.height=e.target.value+'px';});
</script></html>'''
    (output/'review.html').write_text(page)


def run(manifest, output):
    data = load_manifest(manifest)
    if output.exists():
        raise ValueError('output directory already exists')
    output.mkdir(parents=True)
    (output/'images').mkdir()
    results = []
    for index, item in enumerate(data['items']):
        sources = {name: cv2.imread(view['_path']) for name, view in item['views'].items()}
        a, roi = sources['A'], item['roi']
        layout, _ = mask_layout(a, roi, item.get('excludedBoxes', []), item.get('boardPolygon', []))
        row = {key: item[key] for key in ('id', 'group', 'reviewCategory', 'reviewNote') if key in item}
        row.update(pairs={}, images={}, sourceHashes={n: digest(v['_path']) for n, v in item['views'].items()},
                   referenceRoi=roi, boardPolygon=item.get('boardPolygon'), layout=layout)
        def save(name, image):
            file = f'images/{index:04d}-{name}.png'
            if not cv2.imwrite(str(output/file), image):
                raise OSError('image write failed')
            row['images'][name] = file
        cx, cy = int(round((roi[0]+roi[2])/2)), int(round((roi[1]+roi[3])/2))
        def detail(image):
            return image[max(0,cy-48):min(image.shape[0],cy+48),max(0,cx-48):min(image.shape[1],cx+48)]
        save('A-head', detail(a))
        saved_pairs = {}
        for name in ('center', 'B'):
            matrix = np.array(item['views'][name]['referenceToView'], float).reshape(3, 3)
            pair, aligned = measure_pair(a, sources[name], roi, matrix, layout)
            if not item.get('boardPolygon'):
                pair['reasons'].insert(0, 'same_board_polygon_missing')
            row['pairs'][name] = pair
            save(name+'-head-preview', detail(aligned))
            saved_pairs[name] = aligned
        save('A-original', a)
        for name, aligned in saved_pairs.items():
            save(name+'-alignment-preview', aligned)
            save(name+'-wood-check', overlay(a, roi, layout, row['pairs'][name]))
            # Retain original pixels alongside every interpolated alignment.
            save(name+'-original', sources[name])
        row['trajectory'] = classify_trajectory(row['pairs'], item.get('baselines'))
        results.append(row)
    summary = dict(items=len(results), groups=len({r['group'] for r in results}),
                   trajectories=dict(Counter(r['trajectory']['status'] for r in results)),
                   pairs=dict(Counter(p['status'] for r in results for p in r['pairs'].values())),
                   pairRejections=dict(Counter(reason for r in results for p in r['pairs'].values() for reason in p['reasons'])))
    result = dict(method=METHOD, configuration=CONFIG, manifestSha256=digest(manifest),
                  algorithmSha256=digest(__file__), createdAtUtc=datetime.now(timezone.utc).isoformat(),
                  opencvVersion=cv2.__version__, numpyVersion=np.__version__,
                  description=data.get('description', ''), labelPolicy=data.get('labelPolicy', ''),
                  physicalHeight='not_measured', pnDecision='not_made', summary=summary, items=results)
    (output/'results.json').write_text(json.dumps(result, indent=2, allow_nan=False))
    render_report(result, output)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = run(args.input.resolve(), args.output.resolve())
        print(json.dumps(result['summary'], indent=2))
    except (ValueError, KeyError, TypeError, OSError, cv2.error) as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
