#!/usr/bin/env python3
"""Offline sector-level wood texture comparison and native-pixel evidence marking."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import sys

import cv2
import numpy as np

import compare_ring_rules as replay
import inspect_rings as rings

METHOD = 'opencv-sector-grain-v1'
CONFIG = dict(sectors=8, nearBand=[1.12, 1.75], referenceBand=[2.1, 2.6],
              minPixels=12, minReferenceRms=3., minReferenceCoherence=.25,
              minValidSectors=6, topSectors=2, edgeNoiseMultiplier=1.5,
              minEdgeGradient=3., sensitivityPx=1)


def tensor(gx, gy, mask):
    if int(mask.sum()) < CONFIG['minPixels']:
        return None
    x, y = gx[mask], gy[mask]
    a, b, c = float(np.mean(x*x)), float(np.mean(y*y)), float(np.mean(x*y))
    energy = a+b
    return dict(rms=math.sqrt(energy), coherence=math.hypot(a-b, 2*c)/max(energy, 1e-9),
                angle=.5*math.atan2(2*c, a-b))


def measure(bgr, ellipse):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    rho, _ = rings.coordinates(gray.shape, ellipse)
    # coordinates() uses equal angular sectors in ellipse-normalized space.
    cx, cy, ax, ay, angle = ellipse
    theta = math.radians(angle)
    yy, xx = np.indices(gray.shape)
    x, y = xx-cx, yy-cy
    phi = np.arctan2((-x*math.sin(theta)+y*math.cos(theta))/ay,
                     (x*math.cos(theta)+y*math.sin(theta))/ax)
    sectors = np.floor((phi+np.pi)/(2*np.pi)*CONFIG['sectors']).astype(int) % CONFIG['sectors']
    # A full Sobel footprint must contain wood, not the metal core, ink or border.
    wood = (rho > 1) & ~rings.ink_mask(bgr)
    safe = cv2.erode(wood.astype(np.uint8), np.ones((3, 3), np.uint8),
                     borderType=cv2.BORDER_CONSTANT, borderValue=0).astype(bool)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)/8
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)/8
    magnitude = np.hypot(gx, gy)
    near = safe & (rho >= CONFIG['nearBand'][0]) & (rho < CONFIG['nearBand'][1])
    far = safe & (rho >= CONFIG['referenceBand'][0]) & (rho < CONFIG['referenceBand'][1])
    rows = []
    for index in range(CONFIG['sectors']):
        n, f = near & (sectors == index), far & (sectors == index)
        nt, ft = tensor(gx, gy, n), tensor(gx, gy, f)
        row = dict(index=index, nearPixels=int(n.sum()), referencePixels=int(f.sum()),
                   near=nt, reference=ft, valid=False, reasons=[])
        if nt is None or ft is None:
            row['reasons'].append('insufficient_wood_pixels')
        elif ft['rms'] < CONFIG['minReferenceRms']:
            row['reasons'].append('weak_reference_texture')
        elif ft['coherence'] < CONFIG['minReferenceCoherence']:
            row['reasons'].append('reference_grain_direction_ambiguous')
        elif nt['rms'] < 1e-6:
            row['reasons'].append('no_resolved_near_texture')
        else:
            angle = ft['angle']
            def off_grain(mask):
                perpendicular = -gx[mask]*math.sin(angle)+gy[mask]*math.cos(angle)
                return float(np.sum(perpendicular**2)/max(float(np.sum(gx[mask]**2+gy[mask]**2)), 1e-9))
            med = float(np.median(magnitude[f]))
            mad = float(np.median(np.abs(magnitude[f]-med)))*1.4826
            threshold = max(CONFIG['minEdgeGradient'], med+CONFIG['edgeNoiseMultiplier']*mad)
            row.update(valid=True, offGrainExcess=off_grain(n)-off_grain(f),
                       coherenceLoss=ft['coherence']-nt['coherence'],
                       directionChangeDeg=math.degrees(.5*math.acos(float(np.clip(math.cos(2*(nt['angle']-angle)), -1, 1)))),
                       edgeDensityExcess=float(np.mean(magnitude[n] >= threshold)-np.mean(magnitude[f] >= threshold)),
                       edgeGradientThreshold=threshold)
        rows.append(row)
    valid = [row for row in rows if row['valid']]
    score = None
    if len(valid) >= CONFIG['minValidSectors']:
        score = float(np.mean(sorted((r['offGrainExcess'] for r in valid), reverse=True)[:CONFIG['topSectors']]))
    outer = CONFIG['referenceBand'][1]
    ex = math.hypot(ax*math.cos(theta), ay*math.sin(theta))*outer
    ey = math.hypot(ax*math.sin(theta), ay*math.cos(theta))*outer
    clipped = cx-ex < 0 or cy-ey < 0 or cx+ex >= gray.shape[1] or cy+ey >= gray.shape[0]
    return dict(sectors=rows, validSectors=len(valid), score=score, contextClipped=clipped), (near, far, sectors)


def analyze(bgr, old):
    cx, cy, ax, ay, angle = old['head']['ellipse']
    ellipses = [(cx, cy, ax, ay, angle), (cx+1, cy, ax, ay, angle), (cx-1, cy, ax, ay, angle),
                (cx, cy+1, ax, ay, angle), (cx, cy-1, ax, ay, angle),
                (cx, cy, max(2, ax-1), max(2, ay-1), angle), (cx, cy, ax+1, ay+1, angle)]
    variants = [measure(bgr, e)[0] for e in ellipses]
    # Preserve source/head quality gates, not the previous brightness-rule gates.
    quality = [r for r in old['reasons'] if r not in replay.DERIVED_REASONS]
    for v in variants:
        v['reasons'] = quality.copy()
        if v['contextClipped'] and 'surrounding_ring_clipped' not in v['reasons']:
            v['reasons'].append('surrounding_ring_clipped')
        if v['score'] is None:
            v['reasons'].append('insufficient_directional_wood_support')
        v['usable'] = not v['reasons']
    scores = [v['score'] for v in variants if v['score'] is not None]
    return dict(primary=variants[0], variants=variants, allVariantsUsable=all(v['usable'] for v in variants),
                sensitivity=dict(minScore=min(scores) if scores else None, maxScore=max(scores) if scores else None),
                physicalHeight='not_measured', pnDecision='not_made',
                interpretation='Local gradient disruption only; no claim of detected fibers, cracks, indentation or height.')


def overlay(bgr, ellipse, measurement):
    _, (near, far, sectors) = measure(bgr, ellipse)
    image = bgr.copy()
    # Outer reference wood is cyan; inner sectors fade from gray to orange as
    # off-grain gradient excess increases. Invalid sectors are magenta.
    image[far] = (.55*image[far]+.45*np.array([220, 200, 40])).astype(np.uint8)
    cx, cy, ax, ay, angle = ellipse
    for row in measurement['sectors']:
        mask = near & (sectors == row['index'])
        color = np.array([190, 50, 190])
        if row['valid']:
            strength = float(np.clip(row['offGrainExcess'], 0, 1))
            color = np.array([150, 150, 150])*(1-strength)+np.array([20, 130, 255])*strength
        image[mask] = (.3*image[mask]+.7*color).astype(np.uint8)
    cv2.ellipse(image, (round(cx), round(cy)), (round(ax), round(ay)), angle, 0, 360, (0, 255, 255), 1)
    return image


def summarize(items, reference_cohort, comparison_cohort):
    cohorts = defaultdict(list)
    for r in items:
        cohorts[r.get('cohort', 'unspecified')].append(r)
    summaries = {}
    for cohort, rows in cohorts.items():
        usable = [r for r in rows if r['grain']['primary']['usable']]
        fixed = [r for r in rows if r['grain']['allVariantsUsable']]
        scores = [r['grain']['primary']['score'] for r in usable]
        summaries[cohort] = dict(total=len(rows), groups=len({r['group'] for r in rows}),
                                 usable=len(usable), usableAllVariants=len(fixed),
                                 median=float(np.median(scores)) if scores else None,
                                 q25=float(np.quantile(scores, .25)) if scores else None,
                                 q75=float(np.quantile(scores, .75)) if scores else None,
                                 reasons=dict(Counter(reason for r in rows for reason in r['grain']['primary']['reasons'])))
    comparison = None
    if reference_cohort and comparison_cohort:
        a = [r for r in cohorts[reference_cohort] if r['grain']['allVariantsUsable']]
        b = [r for r in cohorts[comparison_cohort] if r['grain']['allVariantsUsable']]
        comparison = dict(referenceCohort=reference_cohort, comparisonCohort=comparison_cohort,
                          referenceCount=len(a), comparisonCount=len(b), pairs=len(a)*len(b),
                          interpretation='Exploratory pair ordering, not independent accuracy or a PN threshold.')
        if a and b:
            values = []
            for v in range(7):
                pairs = [(x['grain']['variants'][v]['score'], y['grain']['variants'][v]['score']) for x in a for y in b]
                values.append(float(np.mean([1 if x > y else .5 if x == y else 0 for x, y in pairs])))
            definite = sum(x['grain']['sensitivity']['minScore'] > y['grain']['sensitivity']['maxScore'] for x in a for y in b)
            reversed_pairs = sum(x['grain']['sensitivity']['maxScore'] < y['grain']['sensitivity']['minScore'] for x in a for y in b)
            comparison.update(referenceRanksHigher=values[0], boundaryVariantOrdering=values,
                              separatedAcrossAllPerturbations=definite, reversedAcrossAllPerturbations=reversed_pairs,
                              overlappingRanges=len(a)*len(b)-definite-reversed_pairs)
    return dict(cohorts=summaries, comparison=comparison)


def synthetic_controls(output):
    """Known texture changes and shading confounds, not physical-height simulations."""
    y, x = np.indices((160, 160), dtype=float)
    radius = np.hypot(x-80, y-80)
    base = 145+25*np.sin(x/2.5)
    rotated = base.copy()
    region = (radius > 16) & (radius < 27)
    rotated[region] = (145+25*np.sin(y/2.5))[region]
    cases = [('Continuous parallel texture', base, 'unchanged grain'),
             ('Additive brightness +10', base+10, 'unchanged grain, changed brightness'),
             ('Smooth illumination ramp', base+.3*(x-80), 'unchanged grain, illumination gradient'),
             ('Dark radial halo over intact grain', base-45*np.exp(-((radius-17)/4)**2), 'unchanged grain, radial shading confound'),
             ('Near-head texture rotated 90 degrees', rotated, 'constructed texture-direction change')]
    controls = []
    for index, (name, gray, truth) in enumerate(cases):
        gray = gray.copy();gray[radius <= 15] = 75
        bgr = cv2.cvtColor(gray.clip(0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
        measured, _ = measure(bgr, (80, 80, 15, 15, 0))
        path = f'images/control-{index+1}.png'
        rings.write_png(output/path, bgr)
        controls.append(dict(name=name, constructedTruth=truth, measurement=measured, image=path))
    return controls


def run(input_path, baseline_path, output, reference_cohort=None, comparison_cohort=None, review_ids=None):
    if output.exists():
        raise ValueError('Output directory already exists; choose a new directory')
    manifest, loaded, cached = replay.verify_inputs(input_path, baseline_path)
    review_ids = review_ids or []
    if len(set(review_ids)) != len(review_ids) or any(i not in cached for i in review_ids):
        raise ValueError('Review IDs must be unique and present in the manifest')
    if bool(reference_cohort) != bool(comparison_cohort) or reference_cohort == comparison_cohort and reference_cohort:
        raise ValueError('Supply two different cohort names, or neither')
    cohorts = {r.get('cohort', 'unspecified') for r in cached.values()}
    if reference_cohort and (reference_cohort not in cohorts or comparison_cohort not in cohorts):
        raise ValueError('Unknown comparison cohort')
    output.mkdir(parents=True)
    (output/'images').mkdir()
    items = []
    for index, (row, source, bgr, roi, crop) in enumerate(loaded):
        old = cached[row['id']]
        grain = analyze(bgr, old['analysis'])
        images = dict(raw=f'images/{index+1:03d}-raw.png', overlay=f'images/{index+1:03d}-grain.png')
        rings.write_png(output/images['raw'], bgr)
        rings.write_png(output/images['overlay'], overlay(bgr, old['analysis']['head']['ellipse'], grain['primary']))
        items.append(dict(old, images=images, grain=grain))
    root = Path(__file__).resolve().parent
    hashes = {name:rings.digest(root/name) for name in ['inspect_grain.py', 'grain_review.html', 'grain_review.js', 'compare_ring_rules.py', 'inspect_rings.py']}
    result = dict(schemaVersion=1, method=METHOD, generatedAt=datetime.now(timezone.utc).isoformat(),
                  manifestSha256=rings.digest(input_path), baselineSha256=rings.digest(baseline_path),
                  algorithms=hashes, config=CONFIG, items=items, firstReviewIds=review_ids,
                  summary=summarize(items, reference_cohort, comparison_cohort), controls=synthetic_controls(output),
                  baselineVerified=True, productionChanged=False, labelPolicy=manifest.get('labelPolicy', ''),
                  runtime=dict(opencv=cv2.__version__, numpy=np.__version__, python=sys.version.split()[0], threads=1))
    (output/'results.json').write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    data = json.dumps(result, allow_nan=False).replace('<', '\\u003c').replace('&', '\\u0026')
    (output/'review.html').write_text((root/'grain_review.html').read_text().replace('__DATA__', data))
    shutil.copyfile(root/'grain_review.js', output/'grain_review.js')
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--baseline', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--reference-cohort')
    p.add_argument('--comparison-cohort')
    p.add_argument('--review-id', action='append', default=[])
    a = p.parse_args()
    try:
        r = run(a.input, a.baseline, a.output, a.reference_cohort, a.comparison_cohort, a.review_id)
    except (ValueError, KeyError, OSError) as error:
        p.exit(1, str(error)+'\n')
    print(json.dumps(dict(report=str(a.output/'review.html'), summary=r['summary']), indent=2))


if __name__ == '__main__':
    main()
