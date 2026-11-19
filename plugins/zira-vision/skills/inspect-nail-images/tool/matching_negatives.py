"""Deterministic wrong-correspondence controls; no labels, fitting or source writes."""
import cv2
import numpy as np

import inspect_motion as motion

CONFIG = dict(shiftPx=2,appearances=['clean','brightness_blur'],headPadding=3,
              woodPadding=10,donorPolicy='next_different_group_same_native_shape')


def donor_for(name,selected,sources,images):
    position=selected.index(name)
    for step in range(1,len(selected)):
        other=selected[(position+step)%len(selected)]
        if sources[other]['group']!=sources[name]['group'] and images[other]['A'].shape==images[name]['A'].shape:
            return other
    return None


def crop_inside(shape,box):
    l,t,r,b=box
    return 0<=l<r<=shape[1] and 0<=t<b<=shape[0]


def generate(reference,roi,layout,donor=None,donor_roi=None):
    """Return known wrong targets in A coordinates, plus explicitly skipped cases.

    Whole-image shifts deliberately have the wrong identity alignment. Local wood
    replacements move only one withheld footprint. Other-head replacement preserves
    the reference wood but removes the head's true correspondence. No case is a
    physical PN simulation, and acceptance must be reported even if unexpected.
    """
    height,width=reference.shape[:2];delta=CONFIG['shiftPx'];base=[];skipped=[]
    for dx,dy in [(delta,0),(0,delta)]:
        target=cv2.warpPerspective(reference,motion.translation(dx,dy),(width,height))
        base.append((dict(kind='wrong_alignment',shift=[dx,dy],expectedRejectStage='wood'),target))
    shifted=cv2.warpPerspective(reference,motion.translation(delta,0),(width,height))
    for index,template in enumerate(row for row in layout if row['role']=='validation'):
        box=np.array(template['box'])+[-CONFIG['woodPadding'],-CONFIG['woodPadding'],CONFIG['woodPadding'],CONFIG['woodPadding']]
        if not crop_inside(reference.shape,box):
            skipped.append(dict(kind='one_wrong_wood_patch',validator=index,reason='control_support_clipped'));continue
        l,t,r,b=box
        target=reference.copy();target[t:b,l:r]=shifted[t:b,l:r]
        base.append((dict(kind='one_wrong_wood_patch',validator=index,shift=[delta,0],
                          replacedBox=box.tolist(),expectedRejectStage='wood'),target))
    if donor is None:
        skipped.extend(dict(kind=kind,reason='no_different_group_with_same_native_shape') for kind in ('other_pallet','other_head'))
    else:
        if donor.shape!=reference.shape:raise ValueError('donor shape differs')
        base.append((dict(kind='other_pallet',expectedRejectStage='wood'),donor.copy()))
        box=np.array([int(np.floor(roi[0])),int(np.floor(roi[1])),int(np.ceil(roi[2])),int(np.ceil(roi[3]))])+[-CONFIG['headPadding'],-CONFIG['headPadding'],CONFIG['headPadding'],CONFIG['headPadding']]
        l,t,r,b=box;cx,cy=np.rint([(donor_roi[0]+donor_roi[2])/2,(donor_roi[1]+donor_roi[3])/2]).astype(int)
        dl,dt=cx-(r-l)//2,cy-(b-t)//2;donor_box=[int(v) for v in [dl,dt,dl+r-l,dt+b-t]]
        if not crop_inside(reference.shape,box) or not crop_inside(donor.shape,donor_box):
            skipped.append(dict(kind='other_head',reason='control_support_clipped'))
        else:
            target=reference.copy();target[t:b,l:r]=donor[dt:donor_box[3],dl:donor_box[2]]
            base.append((dict(kind='other_head',expectedRejectStage='head',replacedBox=box.tolist(),donorBox=donor_box),target))
    cases=[]
    for meta,target in base:
        for appearance in CONFIG['appearances']:
            image=target.copy()
            if appearance=='brightness_blur':
                image=cv2.GaussianBlur(image,(5,5),.8)
                image=np.clip(image.astype(float)*.8+15,0,255).astype(np.uint8)
            cases.append((dict(meta,appearance=appearance),image))
    return cases,skipped
