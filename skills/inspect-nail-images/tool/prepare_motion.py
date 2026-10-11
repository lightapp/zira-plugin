#!/usr/bin/env python3
"""Prepare native context crops from local A/center/B scenes for inspect_motion.py."""
import argparse
import json
from pathlib import Path
import sys

import cv2
import numpy as np

from inspect_motion import digest, project, translation


def register(reference, target, mask=None):
    """Coarse SIFT mapping only. Local wood checks remain mandatory."""
    scale = min(1., 1536/max(reference.shape[:2]))
    scale_b = min(1., 1536/max(target.shape[:2]))
    a = cv2.resize(cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), None, fx=scale, fy=scale)
    b = cv2.resize(cv2.cvtColor(target, cv2.COLOR_BGR2GRAY), None, fx=scale_b, fy=scale_b)
    if mask is not None:
        mask = cv2.resize(mask, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_NEAREST)
    sift = cv2.SIFT_create(nfeatures=5000, contrastThreshold=.02)
    ka, da = sift.detectAndCompute(a, mask)
    kb, db = sift.detectAndCompute(b, None)
    if da is None or db is None or len(db) < 2:
        raise ValueError('coarse registration: descriptors missing')
    pairs = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .7*pair[1].distance]
    if len(good) < 40:
        raise ValueError('coarse registration: fewer than 40 distinct matches')
    source = np.float32([ka[m.queryIdx].pt for m in good])/scale
    dest = np.float32([kb[m.trainIdx].pt for m in good])/scale_b
    cv2.setRNGSeed(137)
    matrix, flags = cv2.findHomography(source, dest, cv2.RANSAC, 3., maxIters=4000, confidence=.995)
    if matrix is None:
        raise ValueError('coarse registration: no homography')
    inliers = flags.ravel().astype(bool)
    if inliers.sum() < 40 or inliers.mean() < .4:
        raise ValueError('coarse registration: weak inlier consensus')
    span = np.ptp(source[inliers], axis=0)/[reference.shape[1], reference.shape[0]]
    if min(span) < .35:
        raise ValueError('coarse registration: insufficient spatial coverage')
    errors = np.linalg.norm(project(matrix, source[inliers])-dest[inliers], axis=1)
    return matrix, dict(matches=len(good), inliers=int(inliers.sum()),
                        medianErrorPx=float(np.median(errors)), spanFraction=span.tolist())


def extract(image, bounds):
    l, t, r, b = np.rint(bounds).astype(int)
    if l < 0 or t < 0 or r > image.shape[1] or b > image.shape[0] or r <= l or b <= t:
        raise ValueError('native_context_clipped')
    if max(r-l, b-t) > 512:
        raise ValueError('native_context_distorted')
    return image[t:b, l:r].copy(), (l, t)


def run(source, output):
    data = json.loads(source.read_text())
    scenes = data.get('scenes', [])
    if not 1 <= len(scenes) <= 100:
        raise ValueError('1..100 scenes required')
    if output.exists():
        raise ValueError('output directory already exists')
    output.mkdir(parents=True)
    items, audits, rejected = [], [], []
    for scene_index, scene in enumerate(scenes):
        paths = {name: (source.parent/scene['views'][name]).resolve() for name in ('A', 'center', 'B')}
        images = {name: cv2.imread(str(path)) for name, path in paths.items()}
        if any(im is None for im in images.values()):
            raise ValueError('scene image unreadable')
        center = images['center']
        mask = np.zeros(center.shape[:2], np.uint8)
        for polygon in scene['boardPolygons']:
            cv2.fillPoly(mask, [np.rint(polygon).astype(np.int32)], 255)
        for box in scene['excludedBoxes']:
            l, t, r, b = box
            cv2.rectangle(mask, (int(l)-24, int(t)-24), (int(r)+24, int(b)+24), 0, -1)
        transforms, audit = {'center': np.eye(3)}, {}
        for name in ('A', 'B'):
            transforms[name], audit[name] = register(center, images[name], mask)
        inverse_a = np.linalg.inv(transforms['A'])
        global_maps = {name: transform @ inverse_a for name, transform in transforms.items()}
        audits.append(dict(group=scene['group'], mappings=audit, centerToViews={k:v.tolist() for k,v in transforms.items()},
                           sourceHashes={name:digest(path) for name,path in paths.items()}))
        for index, head in enumerate(scene['heads']):
            l, t, r, b = head['roi']
            polygon = np.array([[l,t],[r,t],[r,b],[l,b]], float)
            a_box = project(transforms['A'], polygon)
            point = a_box.mean(axis=0)
            board_matches = [p for p in scene['boardPolygons'] if cv2.pointPolygonTest(np.asarray(p,np.float32),((l+r)/2,(t+b)/2),False)>=0]
            if not board_matches:
                rejected.append(dict(id=head['id'], reason='same_board_missing')); continue
            # The smallest containing board avoids accidentally selecting overlapping lower layers.
            board = min(board_matches, key=lambda p:cv2.contourArea(np.asarray(p,np.float32)))
            bounds = np.array([*np.rint(point-192), *np.rint(point+192)])
            prefix = f'{scene_index:03d}-{index:03d}'
            crops, origins, views = {}, {}, {}
            try:
                crops['A'], origins['A'] = extract(images['A'], bounds)
                corners = np.array([[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]]])
                for name in ('center','B'):
                    mapped = project(global_maps[name], corners)
                    other = [*np.floor(mapped.min(axis=0)-16), *np.ceil(mapped.max(axis=0)+16)]
                    crops[name], origins[name] = extract(images[name], other)
            except ValueError as error:
                rejected.append(dict(id=head['id'], reason=str(error))); continue
            origin = np.array(origins['A'])
            baselines = {}
            for name in ('A','center','B'):
                filename = f'{prefix}-{name}.png'
                if not cv2.imwrite(str(output/filename), crops[name]):
                    raise OSError('crop write failed')
                views[name] = dict(path=filename)
                if name != 'A':
                    views[name]['referenceToView'] = (translation(*-np.array(origins[name])) @ global_maps[name] @ translation(*origin)).tolist()
                    baselines[name] = (project(global_maps[name], [point])[0]-point).tolist()
            excluded = []
            for x0,y0,x1,y1 in scene['excludedBoxes']:
                mapped = project(transforms['A'], [[x0,y0],[x1,y0],[x1,y1],[x0,y1]])-origin
                excluded.append([*mapped.min(axis=0), *mapped.max(axis=0)])
            item = dict(id=head['id'],group=scene['group'],views=views,roi=[*(a_box-origin).min(axis=0),*(a_box-origin).max(axis=0)],
                        boardPolygon=(project(transforms['A'], board)-origin).tolist(),excludedBoxes=excluded,baselines=baselines,
                        reviewCategory=head.get('reviewCategory','unreviewed'),reviewNote=head.get('reviewNote',''))
            items.append(item)
    manifest = dict(description=data.get('description',''),labelPolicy=data.get('labelPolicy',''),items=items)
    (output/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False))
    result = dict(sourceManifestSha256=digest(source),algorithmSha256=digest(__file__),mappings=audits,rejected=rejected,prepared=len(items))
    (output/'preparation.json').write_text(json.dumps(result,indent=2,allow_nan=False))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        result=run(args.input.resolve(),args.output.resolve())
        print(json.dumps(dict(prepared=result['prepared'],rejected=len(result['rejected'])),indent=2))
    except (ValueError,KeyError,TypeError,OSError,cv2.error) as error:
        print(str(error),file=sys.stderr);return 2
    return 0


if __name__=='__main__':
    raise SystemExit(main())
