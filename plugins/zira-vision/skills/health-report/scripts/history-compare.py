"""Bounded local still comparison. Uses the existing scene-drift registration.

One still cannot separate a moving pallet from a moving camera as reliably as a
median video scene. Every detected shift is a review candidate, never a verdict.
"""
import argparse
import base64
import importlib.util
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

source = Path(__file__).resolve().parents[2] / 'validate-trimsaw-sizes/scripts/scene_drift.py'
spec = importlib.util.spec_from_file_location('zira_scene_drift', source)
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)


def compare(before, after):
    row = {'from': before['atEpochMs'], 'to': after['atEpochMs'], 'state': 'inconclusive'}
    a, b = before.get('metadata'), after.get('metadata')
    geometry = ['streamWidth', 'streamHeight', 'sourceWidth', 'sourceHeight',
                'analysisRotationDegrees', 'representation']
    if a and b and any(a.get(k) != b.get(k) for k in geometry):
        return dict(row, state='camera_geometry_changed', reason='Resolution, orientation or source changed; inspect settings before attributing this to a bump')
    try:
        images = []
        for item in [before, after]:
            raw = base64.b64decode(item['data'], validate=True)
            if len(raw) > 65536:
                raise ValueError('image byte limit')
            image = Image.open(io.BytesIO(raw))
            if image.width > 320 or image.height > 320 or min(image.size) < 96:
                raise ValueError('image geometry limit')
            images.append(np.asarray(image.convert('L'), dtype=np.float64))
        if images[0].shape != images[1].shape:
            return dict(row, state='camera_geometry_changed', reason='Image dimensions differ')
        if before['sha256'] == after['sha256']:
            return dict(row, reason='Identical image bytes; unchanged view and stale image cannot be distinguished')
        gradients = [drift.gradmag(i) for i in images]
        t = drift.register(*gradients, np.ones(images[0].shape, dtype=bool), patch=64, step=32)
        if not t or t['patches'] < 8 or t['rmsPx'] > 0.8:
            return dict(row, reason='Insufficient consistent background texture; inspect images for occlusion, lighting or a large move')
        points = [p for p in t['patchList'] if p['kept']]
        h, w = images[0].shape
        if max(p['x'] for p in points)-min(p['x'] for p in points) < w*.4 or max(p['y'] for p in points)-min(p['y'] for p in points) < h*.4:
            return dict(row, reason='Matched texture is confined to one part of the image')
        shift = math.hypot(t['tx'], t['ty'])
        moved = shift >= 2 or abs(t['rotDeg']) >= .5 or abs(t['scale']-1) >= .02
        return dict(row, state='visual_shift_candidate' if moved else 'no_large_shift_detected',
                    reason='Review required: a single still cannot exclude moving objects or lens changes' +
                    ('; legacy capture geometry unavailable' if not (a and b) else ''),
                    shiftPx=round(shift, 2), rotationDegrees=round(t['rotDeg'], 2),
                    scale=round(t['scale'], 4), matchedPatches=t['patches'])
    except (ValueError, OSError, KeyError):
        return dict(row, reason='Image could not be compared safely')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    file = Path(args.evidence)
    if file.stat().st_size > 32*1024*1024:
        raise ValueError('evidence size limit')
    views = json.loads(file.read_text(encoding='utf-8'))['views']
    if len(views) > 400:
        raise ValueError('comparison count limit')
    print(json.dumps([compare(a, b) for a, b in zip(views, views[1:])], allow_nan=False))


if __name__ == '__main__':
    main()
