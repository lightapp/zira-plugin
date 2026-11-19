#!/usr/bin/env python3
"""Fixed OpenCV appearance measurements around supplied object boxes; no training."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import html
import json
import math
from pathlib import Path
import sys
import time

import cv2
import numpy as np

METHOD = 'opencv-ring-measurements-v3'
# Fixed before evaluation. These are exploratory image rules, not height thresholds.
CONFIG = dict(sectors=12, bands=[[1.12, 1.4], [1.4, 1.75], [1.75, 2.1], [2.1, 2.6]],
              min_sector_pixels=3, min_valid_sectors=10, min_head_diameter_px=10,
              min_contour_support=.55, min_wood_luma=30, min_wood_texture=2,
              dip_luma=5, dip_noise_multiplier=.7, ring_sector_fraction=.4,
              clear_sector_fraction=.15, ink_hue_min=90, ink_hue_max=135,
              ink_saturation_min=55, ink_core_limit=.18, sensitivity_px=1)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ink_mask(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    b, g, r = [channel.astype(float) for channel in cv2.split(bgr)]
    # Color exclusion only; blue metal/reflections can also satisfy this rule.
    mask = ((hsv[..., 0] >= CONFIG['ink_hue_min']) & (hsv[..., 0] <= CONFIG['ink_hue_max'])
            & (hsv[..., 1] >= CONFIG['ink_saturation_min']) & (b > r + 8) & (b > g + 3))
    return cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)


def coordinates(shape, ellipse):
    cx, cy, ax, ay, angle = ellipse
    y, x = np.indices(shape, dtype=float)
    # Integer coordinates are pixel centers, consistent with OpenCV contours.
    dx, dy = x - cx, y - cy
    theta = math.radians(angle)
    u = (dx * math.cos(theta) + dy * math.sin(theta)) / ax
    v = (-dx * math.sin(theta) + dy * math.cos(theta)) / ay
    rho = np.hypot(u, v)
    sector = np.minimum(((np.arctan2(v, u) + np.pi) * CONFIG['sectors'] / (2 * np.pi)).astype(int), CONFIG['sectors'] - 1)
    return rho, sector


def boundary(gray, roi, excluded):
    x1, y1, x2, y2 = roi
    cx, cy = (x1+x2)/2, (y1+y2)/2
    ax, ay = (x2-x1)/2, (y2-y1)/2
    seed = (cx, cy, ax, ay, 0.)
    smooth = cv2.GaussianBlur(gray, (3, 3), .6)
    edges = cv2.Canny(smooth, 20, 60)
    edges[excluded] = 0
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    candidates = []
    for contour in contours:
        if len(contour) < 8:
            continue
        area = cv2.contourArea(contour)
        ratio = area / (np.pi*ax*ay)
        if not .4 <= ratio <= 1.5:
            continue
        (ex, ey), (diam1, diam2), angle = cv2.fitEllipse(contour)
        if min(diam1, diam2) < 4 or max(diam1, diam2) > 2.7*max(ax, ay):
            continue
        if math.hypot((ex-cx)/ax, (ey-cy)/ay) > .4:
            continue
        ellipse = (float(ex), float(ey), float(diam1/2), float(diam2/2), float(angle))
        points = contour[:, 0, :].astype(float)
        theta = math.radians(angle)
        du, dv = points[:, 0]-ex, points[:, 1]-ey
        pu = (du*np.cos(theta)+dv*np.sin(theta))/(diam1/2)
        pv = (-du*np.sin(theta)+dv*np.cos(theta))/(diam2/2)
        residual = float(np.median(np.abs(np.hypot(pu, pv)-1)))
        if residual > .15:
            continue
        sectors = np.unique(((np.arctan2(pv, pu)+np.pi)*24/(2*np.pi)).astype(int).clip(0, 23))
        coverage = len(sectors)/24
        perimeter = cv2.arcLength(contour, True)
        circularity = float(4*np.pi*area/max(perimeter**2, 1))
        objective = abs(math.log(max(ratio, .001))) + math.hypot((ex-cx)/ax, (ey-cy)/ay) + residual*4
        candidates.append((objective, ellipse, coverage, residual, circularity))
    if candidates:
        _, ellipse, coverage, residual, circularity = min(candidates, key=lambda row: row[0])
        if coverage >= CONFIG['min_contour_support'] and residual < .10 and circularity >= .4:
            return ellipse, dict(method='opencv_contour_ellipse', accepted=True,
                                 contourSupport=coverage, circularity=circularity, fitResidual=residual)
    # A head outline can be interrupted by glare. Sample only edge pixels close
    # to the supplied box boundary, one per angular bin, then validate the fit.
    yy, xx = np.where(edges > 0)
    u, v = (xx-cx)/ax, (yy-cy)/ay
    radius = np.hypot(u, v)
    gx=cv2.Sobel(smooth.astype(np.float32),cv2.CV_32F,1,0,ksize=3)
    gy=cv2.Sobel(smooth.astype(np.float32),cv2.CV_32F,0,1,ksize=3)
    nx,ny=u/ax,v/ay
    alignment=np.abs(gx[yy,xx]*nx+gy[yy,xx]*ny)/np.maximum(
        np.hypot(gx[yy,xx],gy[yy,xx])*np.hypot(nx,ny),1e-6)
    bins = (((np.arctan2(v,u)+np.pi)*24/(2*np.pi)).astype(int)).clip(0,23)
    points=[]
    for index in range(24):
        selected=np.where((bins==index)&(radius>=.75)&(radius<=1.25)&(alignment>=.8))[0]
        if len(selected):
            point=selected[np.argmin(np.abs(radius[selected]-1))]
            points.append([xx[point], yy[point]])
    if len(points) >= 16:
        points=np.array(points,np.float32)
        (ex,ey),(dx,dy),angle=cv2.fitEllipse(points)
        if min(dx,dy) > 4:
            t=math.radians(angle);px,py=points[:,0]-ex,points[:,1]-ey
            rho=np.hypot((px*np.cos(t)+py*np.sin(t))/(dx/2),(-px*np.sin(t)+py*np.cos(t))/(dy/2))
            residual=float(np.median(np.abs(rho-1)))
            if (.6 <= dx*dy/(4*ax*ay) <= 1.4 and max(dx,dy) <= 2.7*max(ax,ay)
                    and math.hypot((ex-cx)/ax,(ey-cy)/ay) <= .3 and residual < .10
                    and float(np.quantile(np.abs(rho-1),.9)) < .22):
                return (float(ex),float(ey),float(dx/2),float(dy/2),float(angle)), dict(
                    method='opencv_radial_edge_ellipse', accepted=True, contourSupport=len(points)/24,
                    circularity=None, fitResidual=residual)
    return seed, dict(method='supplied_box_ellipse', accepted=False, contourSupport=0., circularity=None, fitResidual=None)


def profile(gray, excluded, ellipse):
    radius, sectors = coordinates(gray.shape, ellipse)
    bands = [(radius >= lo) & (radius < hi) for lo, hi in CONFIG['bands']]
    profiles, valid, dips, dip_thresholds, halos = [], [], [], [], []
    for index in range(CONFIG['sectors']):
        masks = [band & (sectors == index) & ~excluded for band in bands]
        okay = all(int(mask.sum()) >= CONFIG['min_sector_pixels'] for mask in masks)
        vals = [float(np.median(gray[mask])) if mask.any() else None for mask in masks]
        profiles.append(vals)
        valid.append(okay)
        if not okay:
            dips.append(None); dip_thresholds.append(None); halos.append(None); continue
        far_values = gray[masks[-1]].astype(float)
        noise = float(np.median(np.abs(far_values-np.median(far_values)))) * 1.4826
        threshold = max(CONFIG['dip_luma'], CONFIG['dip_noise_multiplier']*noise)
        # Interior trough, recovered on both sides, excludes a monotone shadow edge.
        dip = max(min(vals[0], vals[2])-vals[1], min(vals[1], vals[3])-vals[2], 0.)
        dips.append(dip); dip_thresholds.append(threshold)
        # Also retain a dark lip adjoining the head. This can be a raised-head
        # shadow, so it must never be interpreted as confirmed indentation.
        halos.append(max(min(vals[2], vals[3])-vals[0], 0.))
    trough_ring = [bool(okay and dip >= threshold) for okay, dip, threshold in zip(valid, dips, dip_thresholds)]
    halo_ring = [bool(okay and halo >= threshold) for okay, halo, threshold in zip(valid, halos, dip_thresholds)]
    ring = [a or b for a,b in zip(trough_ring,halo_ring)]
    count = sum(valid)
    # Direct native-pixel texture/grain measurements, with no contrast enhancement.
    near, far = (bands[0] | bands[1]) & ~excluded, bands[-1] & ~excluded
    gx = cv2.Sobel(gray.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)/8
    gy = cv2.Sobel(gray.astype(np.float32), cv2.CV_32F, 0, 1, ksize=3)/8
    # Exclude a 1 px neighborhood of masked pixels from gradient calculations.
    safe = ~cv2.dilate(excluded.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    def structure(mask):
        mask = mask & safe
        if int(mask.sum()) < 8:
            return None, None, None
        a, b, c = float(np.mean(gx[mask]**2)), float(np.mean(gy[mask]**2)), float(np.mean(gx[mask]*gy[mask]))
        strength = math.sqrt(max(a+b, 0))
        coherence = math.hypot(a-b, 2*c)/max(a+b, 1e-9)
        angle = .5*math.atan2(2*c, a-b)
        return strength, coherence, angle
    ns, nc, na = structure(near)
    fs, fc, fa = structure(far)
    agreement = None if na is None or fa is None else float(math.cos(2*(na-fa)))
    return dict(validSectors=count, profiles=profiles, sectorDips=dips, sectorDipThresholds=dip_thresholds,
                ringSectors=ring, ringFraction=sum(ring)/max(count, 1),
                troughFraction=sum(trough_ring)/max(count,1), darkHaloFraction=sum(halo_ring)/max(count,1),
                darkHaloDeltas=halos,
                medianDip=float(np.median([d for d in dips if d is not None])) if count else None,
                nearGradient=ns, farGradient=fs, nearCoherence=nc, farCoherence=fc,
                grainOrientationAgreement=agreement,
                gradientRatio=ns/max(fs, 1e-6) if ns is not None and fs is not None else None,
                farMedian=float(np.median(gray[far])) if far.any() else None,
                farStd=float(np.std(gray[far])) if far.any() else None), bands, sectors


def appearance_bucket(fraction):
    if fraction >= CONFIG['ring_sector_fraction']:
        return 'ring_like_contrast'
    if fraction <= CONFIG['clear_sector_fraction']:
        return 'no_clear_ring'
    return 'mixed_ring_evidence'


def analyze(bgr, roi):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    excluded = ink_mask(bgr)
    ellipse, head = boundary(gray, roi, excluded)
    metrics, bands, sectors = profile(gray, excluded, ellipse)
    radius, _ = coordinates(gray.shape, ellipse)
    core = radius <= 1
    core_ink = float(excluded[core].mean()) if core.any() else 0.
    wood = (radius >= CONFIG['bands'][0][0]) & (radius < CONFIG['bands'][-1][1])
    metrics['inkCoreFraction'] = core_ink
    metrics['inkWoodFraction'] = float(excluded[wood].mean()) if wood.any() else 0.
    cx, cy, ax, ay, angle = ellipse
    # Rotated ellipse bounding extents at the outer radius.
    theta = math.radians(angle)
    ex = math.hypot(ax*math.cos(theta), ay*math.sin(theta))*2.6
    ey = math.hypot(ax*math.sin(theta), ay*math.cos(theta))*2.6
    reasons = []
    if min(x for x in [roi[2]-roi[0], roi[3]-roi[1]]) < CONFIG['min_head_diameter_px']:
        reasons.append('head_too_small')
    if not head['accepted']:
        reasons.append('boundary_not_established')
    if cx-ex < 0 or cy-ey < 0 or cx+ex >= gray.shape[1] or cy+ey >= gray.shape[0]:
        reasons.append('surrounding_ring_clipped')
    if core_ink >= CONFIG['ink_core_limit']:
        reasons.append('blue_ink_or_reflection_overlaps_head')
    if metrics['validSectors'] < CONFIG['min_valid_sectors']:
        reasons.append('insufficient_unmasked_wood')
    if metrics['farMedian'] is None or metrics['farMedian'] < CONFIG['min_wood_luma']:
        reasons.append('dark_surrounding_wood')
    if metrics['farStd'] is None or metrics['farStd'] < CONFIG['min_wood_texture']:
        reasons.append('weak_wood_texture')
    # A one-pixel head-boundary error is significant at small resolutions.
    variants = [ellipse, (cx+1, cy, ax, ay, angle), (cx-1, cy, ax, ay, angle),
                (cx, cy+1, ax, ay, angle), (cx, cy-1, ax, ay, angle),
                (cx, cy, max(2, ax-1), max(2, ay-1), angle), (cx, cy, ax+1, ay+1, angle)]
    sensitivity = []
    for variant in variants:
        m, _, _ = profile(gray, excluded, variant)
        sensitivity.append(dict(ringFraction=m['ringFraction'], validSectors=m['validSectors']))
    buckets = [appearance_bucket(row['ringFraction']) for row in sensitivity]
    if len(set(buckets)) > 1 or any(row['validSectors'] < CONFIG['min_valid_sectors'] for row in sensitivity):
        reasons.append('sensitive_to_one_pixel_boundary_change')
    raw_bucket = appearance_bucket(metrics['ringFraction'])
    decision = 'uncertain' if reasons or raw_bucket == 'mixed_ring_evidence' else raw_bucket
    if raw_bucket == 'mixed_ring_evidence':
        reasons.append('mixed_ring_evidence')
    result = dict(head={**head, 'ellipse':list(ellipse), 'minorDiameterPx':float(2*min(ax, ay))}, metrics=metrics,
                  sensitivity=dict(minRingFraction=min(row['ringFraction'] for row in sensitivity),
                                   maxRingFraction=max(row['ringFraction'] for row in sensitivity),
                                   variants=sensitivity), rawAppearance=raw_bucket, result=decision, reasons=reasons,
                  physicalHeight='not_measured', pnDecision='not_made')
    return result, excluded, bands, sectors


def write_png(path, image):
    if not cv2.imwrite(str(path), image):
        raise OSError('Could not write image')


def assets(bgr, roi, result, excluded, bands, sectors, output, prefix):
    # Original pixels are preserved in raw.png; enlargement is for display only.
    overlay = bgr.copy()
    overlay[excluded] = (.25*overlay[excluded]+.75*np.array([220, 40, 220])).astype(np.uint8)
    ellipse = result['head']['ellipse']
    cx, cy, ax, ay, angle = ellipse
    for factor, color in [(1., (0, 230, 255)), (1.12, (255, 220, 0)), (2.1, (80, 220, 80)), (2.6, (80, 220, 80))]:
        cv2.ellipse(overlay, (round(cx), round(cy)), (round(ax*factor), round(ay*factor)), angle, 0, 360, color, 1, cv2.LINE_AA)
    # Sector tint marks only measured ring troughs, not asserted indentation.
    ring_mask = np.zeros(excluded.shape, bool)
    for i, active in enumerate(result['metrics']['ringSectors']):
        if active:
            ring_mask |= bands[1] & (sectors == i) & ~excluded
    overlay[ring_mask] = (.4*overlay[ring_mask]+.6*np.array([40, 160, 255])).astype(np.uint8)
    paths = {}
    for key, data in [('raw', bgr), ('overlay', overlay), ('ink', (excluded*255).astype(np.uint8))]:
        name = f'{prefix}-{key}.png'
        write_png(output/name, data)
        paths[key] = 'images/'+name
    return paths


def load_manifest(path):
    manifest = json.loads(path.read_text())
    rows = manifest.get('items')
    if not isinstance(rows, list) or not rows or len(rows) > 2000:
        raise ValueError('Expected 1–2000 items')
    ids = set(); loaded = []
    for row in rows:
        if not isinstance(row.get('id'), str) or not row['id'] or row['id'] in ids:
            raise ValueError('Items need unique nonempty string IDs')
        ids.add(row['id'])
        if not isinstance(row.get('group'), str) or not row['group']:
            raise ValueError('Each item needs its physical-source group')
        if not isinstance(row.get('views'), list) or len(row['views']) != 1:
            raise ValueError('This baseline requires exactly one view per item; no temporal claims')
        view = row['views'][0]
        source = (path.parent / view['path']).resolve()
        bgr = cv2.imread(str(source), cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError(f'Cannot read image for {row["id"]}')
        roi = view.get('roi')
        if not isinstance(roi, list) or len(roi) != 4 or any(type(x) not in (int, float) for x in roi) or not np.isfinite(roi).all():
            raise ValueError('ROI must be four finite pixel coordinates')
        x1,y1,x2,y2 = roi
        if not (0 <= x1 < x2 <= bgr.shape[1] and 0 <= y1 < y2 <= bgr.shape[0]) or min(x2-x1,y2-y1) < 3:
            raise ValueError('ROI must be inside its image and at least 3 pixels across')
        # Analysis remains at native resolution; retain a bounded context window.
        margin = 2*max(x2-x1, y2-y1)
        left, top = max(0, math.floor(x1-margin)), max(0, math.floor(y1-margin))
        right, bottom = min(bgr.shape[1], math.ceil(x2+margin)), min(bgr.shape[0], math.ceil(y2+margin))
        patch = bgr[top:bottom, left:right].copy()
        shifted = [x1-left,y1-top,x2-left,y2-top]
        loaded.append((row, source, patch, shifted, [left,top,right,bottom]))
    return manifest, loaded


def summary(items):
    cohorts = defaultdict(list)
    for item in items:
        cohorts[item.get('cohort', 'unspecified')].append(item)
    return {name: dict(count=len(rows), groups=len({row['group'] for row in rows}),
                      results=dict(Counter(row['analysis']['result'] for row in rows)),
                      rawAppearance=dict(Counter(row['analysis']['rawAppearance'] for row in rows)),
                      reasons=dict(Counter(reason for row in rows for reason in row['analysis']['reasons'])),
                      medians={key:float(np.median([row['analysis']['metrics'][key] for row in rows
                                                   if row['analysis']['metrics'][key] is not None]))
                               if any(row['analysis']['metrics'][key] is not None for row in rows) else None
                               for key in ['ringFraction','troughFraction','darkHaloFraction','gradientRatio','grainOrientationAgreement']})
            for name, rows in cohorts.items()}


def contact_sheets(output, items):
    pages=[]
    cohorts=list(dict.fromkeys(item.get('cohort','unspecified') for item in items))
    for group_index, cohort in enumerate(cohorts):
        rows=[item for item in items if item.get('cohort','unspecified')==cohort]
        for start in range(0,len(rows),16):
            subset=rows[start:start+16]
            canvas=np.full((math.ceil(len(subset)/4)*270+45,4*300,3),22,np.uint8)
            cv2.putText(canvas,cohort,(12,29),cv2.FONT_HERSHEY_SIMPLEX,.65,(235,235,235),1,cv2.LINE_AA)
            for i,item in enumerate(subset):
                x,y=(i%4)*300,(i//4)*270+45
                raw=cv2.imread(str(output/item['images']['raw']))
                overlay=cv2.imread(str(output/item['images']['overlay']))
                for j,image in enumerate([raw,overlay]):
                    factor=min(144/image.shape[1],180/image.shape[0])
                    width,height=round(image.shape[1]*factor),round(image.shape[0]*factor)
                    target=cv2.resize(image,(width,height),interpolation=cv2.INTER_NEAREST)
                    left,top=x+3+j*147+(144-width)//2,y+25+(180-height)//2
                    canvas[top:top+height,left:left+width]=target
                name=item['id']
                if len(name)>32: name='...'+name[-29:]
                # Display shortening is cosmetic; full IDs remain in HTML/JSON.
                cv2.putText(canvas,name[:32],(x+5,y+16),cv2.FONT_HERSHEY_SIMPLEX,.4,(230,230,230),1,cv2.LINE_AA)
                a=item['analysis'];m=a['metrics']
                cv2.putText(canvas,a['result'],(x+5,y+225),cv2.FONT_HERSHEY_SIMPLEX,.38,(220,190,130),1,cv2.LINE_AA)
                cv2.putText(canvas,f"ring {m['ringFraction']:.2f} / halo {m['darkHaloFraction']:.2f}",(x+5,y+247),cv2.FONT_HERSHEY_SIMPLEX,.38,(190,190,190),1,cv2.LINE_AA)
            name=f'contact-{group_index+1:02d}-{start//16+1:02d}.png'
            write_png(output/name,canvas);pages.append(dict(cohort=cohort,path=name))
    return pages


def render_report(output, result):
    data = json.dumps(result, allow_nan=False).replace('<', '\\u003c').replace('&', '\\u0026')
    title = html.escape(result['title'])
    page = REPORT.replace('__TITLE__', title).replace('__DATA__', data)
    (output/'review.html').write_text(page)


def run(input_path, output):
    if output.exists():
        raise ValueError('Output directory already exists; choose a new report directory')
    manifest, loaded = load_manifest(input_path)
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    output.mkdir(parents=True)
    (output/'images').mkdir()
    started = time.perf_counter()
    rows = []
    for index, (row, source, bgr, roi, crop) in enumerate(loaded):
        t0 = time.perf_counter()
        analysis, excluded, bands, sectors = analyze(bgr, roi)
        elapsed = (time.perf_counter()-t0)*1000
        images = assets(bgr, roi, analysis, excluded, bands, sectors, output/'images', f'{index+1:03d}')
        rows.append({key:value for key,value in row.items() if key != 'views'} | dict(
            sourceImage=str(source), sourceSha256=digest(source), originalRoi=row['views'][0]['roi'],
            analysisCrop=crop, roi=roi, size=[bgr.shape[1], bgr.shape[0]], analysis=analysis,
            images=images, measurementMs=elapsed))
    result = dict(schemaVersion=1, method=METHOD, title=manifest.get('title', 'OpenCV ring review'),
                  description=manifest.get('description', ''), generatedAt=datetime.now(timezone.utc).isoformat(),
                  config=CONFIG, manifestSha256=digest(input_path), algorithmSha256=digest(__file__), runtime=dict(python=sys.version.split()[0],
                  opencv=cv2.__version__, numpy=np.__version__, threads=1), items=rows, cohorts=summary(rows),
                  elapsedMs=(time.perf_counter()-started)*1000,
                  scope='Native-pixel appearance measurements only. No trained model, fitting to labels, height estimate, or production PN decision.',
                  labelPolicy=manifest.get('labelPolicy', ''), productionChanged=False)
    result['contactSheets']=contact_sheets(output,rows)
    (output/'results.json').write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    render_report(output, result)
    return result


REPORT = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>__TITLE__</title>
<style>
:root{color-scheme:dark;font:15px system-ui;background:#10151b;color:#e8edf4}body{margin:0}header,main{max-width:1450px;margin:auto;padding:24px}h1{font-size:28px;margin:0 0 12px}h2{font-size:19px}p{line-height:1.55;color:#c1ccd9;max-width:1100px}.bar{position:sticky;top:0;background:#17202cf5;z-index:2;padding:12px 24px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}select,input,button{background:#263243;color:#fff;border:1px solid #4b5c74;border-radius:6px;padding:8px}table{border-collapse:collapse;font-size:14px}th,td{text-align:left;border-bottom:1px solid #344155;padding:8px 16px 8px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(540px,1fr));gap:20px}.card{border:1px solid #354459;border-radius:12px;background:#18212d;padding:18px}.top{display:flex;align-items:start;justify-content:space-between;gap:10px}.id{font-size:18px;font-weight:650}.badge{border-radius:14px;padding:5px 10px;font-size:12px;background:#394359;color:white}.ring_like_contrast{background:#654927}.no_clear_ring{background:#284c68}.uncertain{background:#494050}.views{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:15px}.views figure{margin:0}.views img{width:100%;height:240px;object-fit:contain;background:#080b10;image-rendering:pixelated;cursor:zoom-in}figcaption{color:#9cacc1;font-size:12px;margin-top:5px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:16px 0}.metric{background:#111822;padding:10px;border-radius:6px}.metric b{font-size:19px;display:block}.metric span{font-size:11px;color:#9aadc5}.why{font-size:13px;color:#d3bade}.label{color:#afbdd0;margin:6px 0;font-size:13px}details{font-size:12px;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.plot{width:100%;height:140px}#zoom{max-width:95vw;background:#10151b;color:white;border:1px solid #64748b}#zoom img{max-width:85vw;max-height:80vh;min-width:440px;image-rendering:pixelated}#zoom::backdrop{background:#000b}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}a{color:#9ed8ff}.notice{border-left:3px solid #e9b35e;padding-left:15px}.hide-labels .label{display:none}@media(max-width:700px){.grid{grid-template-columns:1fr}.views img{height:175px}.metrics{grid-template-columns:1fr 1fr}header,main{padding:16px}}
</style>
<header><h1>__TITLE__</h1><p id="description"></p><p class="notice">OpenCV measurements only. “No clear ring” is a candidate appearance cue, not a PN verdict. A visible dark ring can be indentation, a nail shadow, dirt, or a head-boundary error. Uncertain measurements stay uncertain.</p><div id="summary"></div><p id="policy"></p><p id="sheets"></p><div class="legend"><span style="color:#ffe600">Yellow: estimated head boundary</span><span style="color:#00dcff">Cyan/green: wood measurement bands</span><span style="color:#ffa028">Orange: dark-ring sectors (trough or halo)</span><span style="color:#dd55dd">Magenta: excluded blue pixels</span></div></header>
<div class="bar"><select id="cohort"><option value="">All groups</option></select><select id="result"><option value="">All results</option><option>no_clear_ring</option><option>ring_like_contrast</option><option>uncertain</option></select><input id="search" placeholder="Find nail ID"><label><input type="checkbox" id="blind">Hide reference labels</label><span id="count"></span><a href="results.json">Measurements JSON</a></div><main><div id="cards" class="grid"></div><p>All measurements use original pixels. Enlarged images use nearest-neighbour display; they add no detail. No label is used by the measurement algorithm. Rules are fixed for this run; exploratory results require independent validation.</p></main><dialog id="zoom"><button onclick="document.getElementById('zoom').close()">Close</button><p id="zoomtitle"></p><img id="zoomimg"></dialog>
<script id="report-data" type="application/json">__DATA__</script><script>
const D=JSON.parse(document.getElementById('report-data').textContent),q=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={no_clear_ring:'No clear ring',ring_like_contrast:'Ring-like contrast',uncertain:'Uncertain'};const fmt=(n,d=1)=>n==null?'—':Number(n).toFixed(d),pct=n=>n==null?'—':Math.round(n*100)+'%';
q('description').textContent=D.description;q('policy').textContent=D.labelPolicy;
q('sheets').innerHTML=(D.contactSheets||[]).map((s,i)=>`<a href="${s.path}">${esc(s.cohort)} · sheet ${i+1}</a>`).join(' &nbsp; | &nbsp; ');
q('summary').innerHTML='<table><tr><th>Reference group</th><th>Items / pallets</th><th>No clear ring</th><th>Ring-like</th><th>Uncertain</th></tr>'+Object.entries(D.cohorts).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${v.count} / ${v.groups}</td><td>${v.results.no_clear_ring||0}</td><td>${v.results.ring_like_contrast||0}</td><td>${v.results.uncertain||0}</td></tr>`).join('')+'</table>';
for(const c of Object.keys(D.cohorts)){const o=document.createElement('option');o.value=c;o.textContent=c;q('cohort').append(o)}
function plot(m){return '<svg class="plot" viewBox="0 0 480 145" role="img" aria-label="Twelve wood-sector brightness profiles"><rect width="480" height="145" fill="#10151b"/>'+[0,64,128,192,255].map(y=>`<path d="M35 ${120-y/255*105}H455" stroke="#293547"/><text x="2" y="${123-y/255*105}" fill="#7c8da6" font-size="10">${y}</text>`).join('')+m.profiles.map((p,i)=>p.some(x=>x==null)?'':`<polyline points="${p.map((y,j)=>`${55+j*125},${120-y/255*105}`).join(' ')}" stroke="${m.ringSectors[i]?'#ffa028':'#779cbd'}" opacity=".7" fill="none"/>`).join('')+'<text x="45" y="139" fill="#b2c0d0" font-size="11">Near head</text><text x="380" y="139" fill="#b2c0d0" font-size="11">Outer wood</text></svg>'}
function render(){const rows=D.items.filter(r=>(!q('cohort').value||r.cohort===q('cohort').value)&&(!q('result').value||r.analysis.result===q('result').value)&&r.id.toLowerCase().includes(q('search').value.toLowerCase()));q('count').textContent=rows.length+' / '+D.items.length;
q('cards').innerHTML=rows.map(r=>{const a=r.analysis,m=a.metrics;return `<article class="card" id="${esc(r.id)}"><div class="top"><div><div class="id">${esc(r.id)}</div><div class="label">Reference: ${esc(r.reviewCategory||r.label||'unlabelled')} · ${esc(r.cohort)}</div></div><span class="badge ${a.result}">${names[a.result]}</span></div><div class="views"><figure><img loading="lazy" src="${r.images.raw}" data-id="${esc(r.id)}" alt="Native image crop ${esc(r.id)}"><figcaption>Original · ${r.size.join(' × ')} pixels</figcaption></figure><figure><img loading="lazy" src="${r.images.overlay}" data-id="${esc(r.id)}" alt="OpenCV measurements ${esc(r.id)}"><figcaption>OpenCV overlay · ${esc(a.head.method)}</figcaption></figure></div><div class="metrics"><div class="metric"><b>${pct(m.ringFraction)}</b><span>Ring sectors · ${m.validSectors}/12 usable</span></div><div class="metric"><b>${pct(a.sensitivity.minRingFraction)}–${pct(a.sensitivity.maxRingFraction)}</b><span>Range with ±1 pixel boundary change</span></div><div class="metric"><b>${fmt(a.head.minorDiameterPx)} px</b><span>Fitted head minor diameter</span></div><div class="metric"><b>${pct(m.inkCoreFraction)}</b><span>Blue-mask overlap with head</span></div><div class="metric"><b>${fmt(m.gradientRatio,2)}×</b><span>Near / far texture gradient</span></div><div class="metric"><b>${fmt(m.grainOrientationAgreement,2)}</b><span>Grain-direction agreement (−1 to 1)</span></div></div><div class="why">${a.reasons.length?esc(a.reasons.join(' · ')):'Measurement gates passed; physical height remains unknown.'}</div>${plot(m)}<details><summary>Full measurements and provenance</summary><pre>${esc(JSON.stringify({source:r.sourceImage,sha256:r.sourceSha256,roi:r.roi,analysis:a},null,2))}</pre></details></article>`}).join('');
q('cards').querySelectorAll('img').forEach(im=>im.onclick=()=>{q('zoomimg').src=im.src;q('zoomtitle').textContent=im.dataset.id;q('zoom').showModal()});}
for(const id of ['cohort','result','search'])q(id).addEventListener('input',render);q('blind').onchange=()=>document.body.classList.toggle('hide-labels',q('blind').checked);render();
</script></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = run(args.input.resolve(), args.output.resolve())
        print(json.dumps(dict(items=len(result['items']), cohorts=result['cohorts'], report=str(args.output/'review.html'))))
        return 0
    except (ValueError, OSError, KeyError, TypeError, cv2.error) as error:
        print(f'Analysis failed: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
