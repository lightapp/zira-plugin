#!/usr/bin/env python3
"""A frozen-input ablation: separate radial troughs from adjoining dark halos."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import html
import json
import math
from pathlib import Path
import sys

import cv2
import numpy as np

import inspect_rings as rings

METHOD = 'opencv-ring-trough-halo-ablation-v1'
RULES = {'union': 'ringFraction', 'trough': 'troughFraction', 'halo': 'darkHaloFraction'}
DERIVED_REASONS = {'mixed_ring_evidence', 'sensitive_to_one_pixel_boundary_change'}


def same_measurements(a, b):
    """Permit only tiny numeric replay drift, never different labels or structure."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_measurements(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same_measurements(x, y) for x, y in zip(a, b))
    if isinstance(a, float):
        return math.isfinite(a) and math.isfinite(b) and abs(a-b) <= 1e-5
    return a == b


def classify(fraction, rule):
    bucket = rings.appearance_bucket(fraction)
    return bucket if rule == 'union' else bucket.replace('ring', rule)


def compare(bgr, analysis):
    """Use the frozen ellipse and gates; labels never enter this measurement."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    excluded = rings.ink_mask(bgr)
    cx, cy, ax, ay, angle = analysis['head']['ellipse']
    ellipses = [(cx, cy, ax, ay, angle), (cx+1, cy, ax, ay, angle),
                (cx-1, cy, ax, ay, angle), (cx, cy+1, ax, ay, angle),
                (cx, cy-1, ax, ay, angle), (cx, cy, max(2, ax-1), max(2, ay-1), angle),
                (cx, cy, ax+1, ay+1, angle)]
    measurements = [rings.profile(gray, excluded, ellipse)[0] for ellipse in ellipses]
    base_reasons = [r for r in analysis['reasons'] if r not in DERIVED_REASONS]
    results = {}
    for rule, key in RULES.items():
        variants = [dict(fraction=m[key], validSectors=m['validSectors']) for m in measurements]
        buckets = [classify(v['fraction'], rule) for v in variants]
        reasons = base_reasons.copy()
        if len(set(buckets)) > 1 or any(v['validSectors'] < rings.CONFIG['min_valid_sectors'] for v in variants):
            reasons.append('sensitive_to_one_pixel_boundary_change')
        raw = buckets[0]
        if raw.startswith('mixed_'):
            reasons.append(raw)
        results[rule] = dict(fraction=variants[0]['fraction'], rawAppearance=raw,
                             result='uncertain' if reasons else raw, reasons=reasons,
                             sensitivity=dict(minFraction=min(v['fraction'] for v in variants),
                                              maxFraction=max(v['fraction'] for v in variants), variants=variants))
    # The ablation must reproduce the old decision as well as its raw fraction.
    if (results['union']['rawAppearance'] != analysis['rawAppearance'] or
            results['union']['result'] != analysis['result'] or
            results['union']['reasons'] != analysis['reasons']):
        raise ValueError('Union replay differs from baseline decision')
    return results


def active_sectors(metrics, rule):
    if rule == 'union':
        return metrics['ringSectors']
    values = metrics['sectorDips'] if rule == 'trough' else metrics['darkHaloDeltas']
    return [v is not None and t is not None and v >= t
            for v, t in zip(values, metrics['sectorDipThresholds'])]


def write_assets(bgr, analysis, output, prefix):
    excluded = rings.ink_mask(bgr)
    ellipse = analysis['head']['ellipse']
    metrics, bands, sectors = rings.profile(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), excluded, ellipse)
    paths = {'raw': f'images/{prefix}-raw.png'}
    rings.write_png(output/paths['raw'], bgr)
    cx, cy, ax, ay, angle = ellipse
    for rule in RULES:
        overlay = bgr.copy()
        overlay[excluded] = (.25*overlay[excluded]+.75*np.array([220, 40, 220])).astype(np.uint8)
        mask = np.zeros(excluded.shape, bool)
        for i, active in enumerate(active_sectors(metrics, rule)):
            if active:
                # Halos adjoin the head; trough overlay marks the two interior bands.
                zone = bands[0] if rule == 'halo' else (bands[1] | bands[2])
                mask |= zone & (sectors == i) & ~excluded
        overlay[mask] = (.4*overlay[mask]+.6*np.array([40, 160, 255])).astype(np.uint8)
        cv2.ellipse(overlay, (round(cx), round(cy)), (round(ax), round(ay)), angle,
                    0, 360, (0, 230, 255), 1, cv2.LINE_AA)
        paths[rule] = f'images/{prefix}-{rule}.png'
        rings.write_png(output/paths[rule], overlay)
    return paths


def summarize(items):
    cohorts = defaultdict(list)
    for row in items:
        cohorts[row.get('cohort', 'unspecified')].append(row)
    return {cohort: dict(count=len(rows), groups=len({r['group'] for r in rows}), rules={
        rule: dict(rawAppearance=dict(Counter(r['rules'][rule]['rawAppearance'] for r in rows)),
                   results=dict(Counter(r['rules'][rule]['result'] for r in rows)),
                   reasons=dict(Counter(reason for r in rows for reason in r['rules'][rule]['reasons'])))
        for rule in RULES}) for cohort, rows in cohorts.items()}


def profile_svg(metrics):
    """All sector profiles, not a selected best-looking radial slice."""
    paths = []
    for i, values in enumerate(metrics['profiles']):
        if any(v is None for v in values):
            continue
        points = ' '.join(f'{40+90*j},{185-v/255*160:.2f}' for j, v in enumerate(values))
        valid = metrics['sectorDipThresholds'][i] is not None
        paths.append(f'<polyline points="{points}" fill="none" stroke="hsl({i*30},65%,45%)" '
                     f'opacity="{1 if valid else .25}" stroke-width="2"><title>Sector {i+1}</title></polyline>')
    return ('<svg viewBox="0 0 360 220" role="img" aria-label="Luminance across all twelve wood sectors">'
            '<path d="M40 20V185H330" stroke="#999" fill="none"/>'
            '<text x="2" y="25">255</text><text x="16" y="185">0</text>' + ''.join(paths) +
            ''.join(f'<text x="{40+90*i}" y="210" text-anchor="middle">{lo}–{hi}r</text>'
                    for i, (lo, hi) in enumerate(rings.CONFIG['bands'])) + '</svg>')


def render_report(output, report):
    esc = lambda value: html.escape(str(value), quote=True)
    summary = []
    for cohort, row in report['cohorts'].items():
        cells = [esc(cohort), str(row['count']), str(row['groups'])]
        for rule in ('union', 'trough'):
            key = 'no_clear_ring' if rule == 'union' else 'no_clear_trough'
            cells += [str(row['rules'][rule]['rawAppearance'].get(key, 0)),
                      str(row['rules'][rule]['results'].get(key, 0)),
                      str(row['rules'][rule]['results'].get('uncertain', 0))]
        summary.append('<tr>'+''.join(f'<td>{v}</td>' for v in cells)+'</tr>')
    cards = []
    for item in report['items']:
        rules = item['rules']
        figures = []
        for rule, title in [('raw', 'Native pixels'), ('union', 'Old: trough OR halo'),
                            ('trough', 'Trough only'), ('halo', 'Halo only')]:
            score = '' if rule == 'raw' else f" — {rules[rule]['fraction']:.0%} sectors"
            figures.append(f'<figure><figcaption>{title}{score}</figcaption>'
                           f'<img loading="lazy" src="{esc(item["images"][rule])}" alt="{title}"></figure>')
        measurements = []
        for rule, value in rules.items():
            s = value['sensitivity']
            measurements.append(f'<li><b>{esc(rule)}</b>: {esc(value["result"])} '
                                f'(raw: {esc(value["rawAppearance"])}; ±1 px: {s["minFraction"]:.0%}–{s["maxFraction"]:.0%}). '
                                f'{esc(", ".join(value["reasons"]))}</li>')
        cards.append(f'<article data-cohort="{esc(item.get("cohort", "unspecified"))}" '
                     f'data-no-trough="{str(rules["trough"]["rawAppearance"] == "no_clear_trough").lower()}">'
                     f'<h2>{esc(item["id"])}</h2><p>{esc(item.get("cohort", ""))} · '
                     f'{esc(item.get("label", ""))} · {esc(item.get("reviewNote", ""))}</p>'
                     f'<div class="images">{"".join(figures)}</div><ul>{"".join(measurements)}</ul>'
                     f'<details><summary>Radial profiles / measurement boundary</summary>'
                     f'{profile_svg(item["analysis"]["metrics"])}'
                     f'<p>Head minor diameter: {item["analysis"]["head"]["minorDiameterPx"]:.1f} native pixels. '
                     'Profiles run outward from the yellow head boundary; orange highlights active sectors. '
                     'Magenta marks excluded blue pixels. A trough is a contrast profile, not a depth measurement.</p></details></article>')
    options = ''.join(f'<option>{esc(c)}</option>' for c in report['cohorts'])
    page = '''<!doctype html><html><head><meta charset="utf-8"><title>Dark ring retry — trough vs halo</title>
<style>body{font:16px system-ui;background:#f4f3ee;color:#222;margin:25px auto;max-width:1450px;padding:0 18px}
h1{font-size:30px}p,li{line-height:1.5}table{border-collapse:collapse;width:100%;background:white;font-size:14px}
td,th{border:1px solid #ccc;padding:9px;text-align:left}article{background:white;border:1px solid #ddd;border-radius:10px;margin:22px 0;padding:20px}
.images{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0}figcaption{margin:8px 0;font-size:14px}img{width:100%;height:260px;object-fit:contain;image-rendering:pixelated;background:#ddd}
svg{max-width:420px;width:100%;font-size:12px}select{padding:8px}nav{position:sticky;top:0;background:#f4f3ee;padding:12px 0;z-index:1}
@media(max-width:800px){.images{grid-template-columns:repeat(2,1fr)}table{font-size:11px}}</style></head><body>
<h1>Dark ring retry: separate troughs from shadows</h1>
<p>The old score counted either an interior dark trough or a dark halo adjoining the nail head. A raised head can also have a halo.
This ablation keeps the same native pixels, head boundaries, thresholds and quality gates, but reports the two signals separately.
All input hashes and baseline analyses were replay-verified before writing this report.</p>
<p><b>“No clear trough” means no trough measured by these bands, not proven absence of indentation or proof of a raised nail.</b>
Labels were not used to select thresholds. All cohorts and failures remain visible. Reviewed indentation/crushed examples are appearance controls,
not measured negative-height ground truth. This reused dataset is exploratory, not an independent validation set. No production settings or PN decisions changed.</p>
<p>Counts below use the full cohort as denominator. Raw counts ignore uncertainty; qualified counts retain all gates, including ±1 pixel stability.</p>
<table><thead><tr><th rowspan="2">Cohort</th><th rowspan="2">N</th><th rowspan="2">Groups</th><th colspan="3">Old: no clear ring</th><th colspan="3">Retry: no clear trough</th></tr>
<tr><th>Raw</th><th>Qualified</th><th>Uncertain</th><th>Raw</th><th>Qualified</th><th>Uncertain</th></tr></thead><tbody>__SUMMARY__</tbody></table>
<nav><select id="cohort"><option value="">All cohorts</option>__OPTIONS__</select>
<label><input type="checkbox" id="no-trough"> Show raw no-trough cases only</label> <span id="count"></span></nav>__CARDS__
<script>function filter(){let n=0;document.querySelectorAll('article').forEach(a=>{a.hidden=!!((document.querySelector('#cohort').value&&a.dataset.cohort!==document.querySelector('#cohort').value)||(document.querySelector('#no-trough').checked&&a.dataset.noTrough!=='true'));if(!a.hidden)n++});document.querySelector('#count').textContent=n+' cases'}document.querySelectorAll('nav input,nav select').forEach(e=>e.addEventListener('change',filter));filter();</script></body></html>'''
    (output/'review.html').write_text(page.replace('__SUMMARY__', ''.join(summary)).replace('__OPTIONS__', options).replace('__CARDS__', ''.join(cards)))


def verify_inputs(input_path, baseline_path):
    """Verify a frozen ring baseline without writing or changing inputs."""
    baseline = json.loads(baseline_path.read_text())
    if baseline.get('method') != rings.METHOD or baseline.get('config') != rings.CONFIG:
        raise ValueError('Baseline method/config mismatch')
    if baseline.get('manifestSha256') != rings.digest(input_path):
        raise ValueError('Baseline manifest hash mismatch')
    if baseline.get('algorithmSha256') != rings.digest(rings.__file__):
        raise ValueError('Baseline algorithm hash mismatch')
    manifest, loaded = rings.load_manifest(input_path)
    cached = {row['id']: row for row in baseline['items']}
    if len(cached) != len(baseline['items']) or set(cached) != {r[0]['id'] for r in loaded}:
        raise ValueError('Baseline item set mismatch')
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    # Complete validation before creating any output or accepting any new score.
    for row, source, bgr, roi, crop in loaded:
        old = cached[row['id']]
        if (old['sourceSha256'] != rings.digest(source) or old['roi'] != roi or
                old['originalRoi'] != row['views'][0]['roi'] or old['analysisCrop'] != crop):
            raise ValueError(f'Source/ROI mismatch: {row["id"]}')
        for key in ('group', 'label', 'cohort', 'reviewCategory', 'reviewNote'):
            if old.get(key) != row.get(key):
                raise ValueError(f'Baseline metadata mismatch: {row["id"]}')
        replay, *_ = rings.analyze(bgr, roi)
        if not same_measurements(replay, old['analysis']):
            raise ValueError(f'Baseline analysis replay mismatch: {row["id"]}')
    return manifest, loaded, cached


def run(input_path, baseline_path, output):
    if output.exists():
        raise ValueError('Output directory already exists; choose a new directory')
    manifest, loaded, cached = verify_inputs(input_path, baseline_path)
    items = [dict(cached[row['id']], rules=compare(bgr, cached[row['id']]['analysis']))
             for row, source, bgr, roi, crop in loaded]
    output.mkdir(parents=True)
    (output/'images').mkdir()
    for i, (item, data) in enumerate(zip(items, loaded)):
        item['images'] = write_assets(data[2], item['analysis'], output, f'{i+1:03d}')
    report = dict(schemaVersion=1, method=METHOD, generatedAt=datetime.now(timezone.utc).isoformat(),
                  baselineSha256=rings.digest(baseline_path), manifestSha256=rings.digest(input_path),
                  algorithmSha256=rings.digest(__file__), ringAlgorithmSha256=rings.digest(rings.__file__),
                  config=rings.CONFIG, baselineVerified=True, thresholdsChanged=False, headBoundariesChanged=False,
                  productionChanged=False, physicalHeight='not_measured', pnDecision='not_made',
                  runtime=dict(opencv=cv2.__version__, numpy=np.__version__, python=sys.version.split()[0], threads=1),
                  labelPolicy=manifest.get('labelPolicy', ''), items=items, cohorts=summarize(items))
    (output/'results.json').write_text(json.dumps(report, indent=2, allow_nan=False)+'\n')
    render_report(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True, help='Existing inspect_rings results.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        report = run(args.input, args.baseline, args.output)
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps(dict(report=str(args.output/'review.html'), count=len(report['items']), cohorts=report['cohorts']), indent=2))


if __name__ == '__main__':
    main()
