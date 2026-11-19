#!/usr/bin/env python3
"""Compare fixed matching smoothing with frozen direct-affine replay transforms."""
import argparse
from collections import Counter
import copy
import html
import json
from pathlib import Path
import sys

import cv2
import numpy as np

import compare_alignment as alignment
import inspect_motion as motion
import wood_null_test as wood
import matching_negatives

MODES = dict(raw=(False,False), wood_only=(True,False),
             head_only=(False,True), wood_and_head=(True,True), raw_first=('fallback',True))
WOOD_MODES = ('raw','smoothed','raw_first')
METHOD = 'opencv-frozen-affine-smoothing-v1'
REPLAY_ABSOLUTE_TOLERANCE = 1e-5


def align(reference,target,full):
    height,width=reference.shape[:2]
    flags=cv2.WARP_INVERSE_MAP
    image=cv2.warpPerspective(target,full,(width,height),flags=cv2.INTER_LINEAR|flags)
    valid=cv2.warpPerspective(np.ones(target.shape[:2],np.uint8),full,(width,height),
                              flags=cv2.INTER_NEAREST|flags)
    return image,valid


def supported(valid,box,padding):
    l,t,r,b=np.asarray(box,int)+[-padding,-padding,padding,padding]
    return (0<=l<r<=valid.shape[1] and 0<=t<b<=valid.shape[0]
            and bool(np.all(valid[t:b,l:r])))


def frozen_delta(fit,shape):
    matrix=np.asarray(fit['woodTransform'],float)
    if matrix.shape!=(3,3) or not np.allclose(matrix[2],[0,0,1]):
        raise ValueError('cached transform must be affine')
    if not alignment.bounded_warp(matrix,shape):
        raise ValueError('cached transform exceeds registration bounds')
    return matrix


def patch_measurement(a,b,valid,box,smoothing):
    result=dict(box=list(box),matchAccepted=False,nearZero=False)
    support=motion.CONFIG['search']+(motion.SMOOTHING_CONFIG['kernelSize']//2 if smoothing else 0)
    if not supported(valid,box,support):
        return dict(result,reason='held_out_search_clipped')
    match=motion.match(a,b,box)
    result['match']=match
    if not match['ok']:return dict(result,reason=match['reason'])
    residual=float(np.hypot(match['xPx'],match['yPx']))
    return dict(result,matchAccepted=True,residualPx=residual,
                nearZero=residual<=motion.CONFIG['maxWoodResidualPx'],
                apparentMotionAtLeast15px=residual>=1.5,
                reason='' if residual<=motion.CONFIG['maxWoodResidualPx'] else 'wood_residual_above_075px')


def fallback_patch(raw,smoothed):
    """Preserve passing raw checks and confident geometric contradictions."""
    if raw['nearZero'] or raw['matchAccepted'] or raw.get('reason') not in ('weak_texture','ambiguous_template_match'):
        return dict(copy.deepcopy(raw),matchingPath='raw',fallbackAttempted=False)
    result=copy.deepcopy(smoothed())
    result.update(matchingPath='smoothed',fallbackAttempted=True,rawAttempt=copy.deepcopy(raw))
    return result


def frozen_probe(reference,target,initial,probe,cached):
    """Two matching paths sharing exactly one cached fit, including rejections."""
    if not cached['fit']['accepted']:
        return {mode:dict(fit=copy.deepcopy(cached['fit']),patches={}) for mode in WOOD_MODES}
    delta=frozen_delta(cached['fit'],reference.shape[:2])
    aligned,valid=align(reference,target,initial@delta)
    variants={}
    for name,smooth in [('raw',False),('smoothed',True)]:
        a,b=motion.matching_gray(reference,smooth),motion.matching_gray(aligned,smooth)
        patches={str(size):patch_measurement(a,b,valid,wood.box_at(probe['center'],size),smooth)
                 for size in wood.CONFIG['sizes']}
        variants[name]=dict(fit=copy.deepcopy(cached['fit']),patches=patches)
    variants['raw_first']=dict(fit=copy.deepcopy(cached['fit']),patches={
        size:fallback_patch(raw,lambda size=size:variants['smoothed']['patches'][size])
        for size,raw in variants['raw']['patches'].items()})
    return variants


def frozen_pair(reference,target,roi,initial,layout,cached):
    """Recheck held-out wood/head gates, never rerun registration or choose a fit."""
    if 'woodTransform' not in cached or cached.get('eccCorrelation',-1)<alignment.CONFIG['eccMinCorrelation']:
        return {name:copy.deepcopy(cached) for name in MODES},None
    delta=frozen_delta(cached,reference.shape[:2])
    aligned,valid=align(reference,target,initial@delta)
    return aligned_pair(reference,aligned,valid,roi,layout,cached['woodTransform']),aligned


def aligned_pair(reference,aligned,valid,roi,layout,wood_transform):
    """Shared validation for frozen real pairs and deliberately wrong controls."""
    validators=[row for row in layout if row['role']=='validation']
    if len(validators)!=3:
        raise ValueError('cached successful fit needs exactly three validators')
    variants={}
    for name,(smooth_wood,smooth_head) in MODES.items():
        fallback=smooth_wood=='fallback'
        a,b=motion.matching_gray(reference,False if fallback else smooth_wood),motion.matching_gray(aligned,False if fallback else smooth_wood)
        if fallback:
            sa,sb=motion.matching_gray(reference,True),motion.matching_gray(aligned,True)
        result=dict(status='uncertain',reasons=[],woodTemplates=[],physicalHeight='not_measured',
                    pnDecision='not_made',woodTransform=copy.deepcopy(wood_transform))
        residuals=[];passed=0
        for template in validators:
            row=patch_measurement(a,b,valid,template['box'],False if fallback else smooth_wood)
            if fallback:
                row=fallback_patch(row,lambda:patch_measurement(sa,sb,valid,template['box'],True))
            match=row.get('match',dict(ok=False,reason='validation_support_clipped'))
            entry=dict(template,match=match)
            if fallback:
                entry.update({k:row[k] for k in ('matchingPath','fallbackAttempted','rawAttempt') if k in row})
            if row['matchAccepted']:
                entry['residualPx']=row['residualPx'];residuals.append(row['residualPx'])
                passed+=row['nearZero']
            result['woodTemplates'].append(entry)
        result.update(validationCount=len(residuals),validationPassed=int(passed),validationResidualsPx=residuals)
        if passed!=len(validators):result['reasons']=['held_out_wood_does_not_validate_plane']
        else:
            result['woodAccepted']=True
            result.update(motion.measure_head(reference,aligned,valid,roi,smooth_head))
        variants[name]=result
    return variants


def replay_difference(new,cached,path='measurement'):
    """Allow floating-point replay noise only; decisions and structure are exact."""
    if isinstance(new,dict) and isinstance(cached,dict) and new.keys()==cached.keys():
        return max((replay_difference(new[k],cached[k],path+'.'+k) for k in new),default=0.)
    if isinstance(new,list) and isinstance(cached,list) and len(new)==len(cached):
        return max((replay_difference(a,b,path+f'[{i}]') for i,(a,b) in enumerate(zip(new,cached))),default=0.)
    if (isinstance(new,(int,float)) and not isinstance(new,bool)
            and isinstance(cached,(int,float)) and not isinstance(cached,bool)):
        error=abs(new-cached)
        if np.isfinite(error) and error<=REPLAY_ABSOLUTE_TOLERANCE:return float(error)
    elif type(new) is type(cached) and new==cached:return 0.
    raise ValueError(f'raw replay differs at {path}: new={new!r}, baseline={cached!r}')


def check_raw_probe(new,cached):
    if new['fit']!=cached['fit']:raise ValueError('cached fit changed')
    if new['patches'].keys()!=cached['patches'].keys():raise ValueError('raw probe set differs from baseline')
    errors=[]
    for size,row in new['patches'].items():
        prior=cached['patches'][size]
        for field in ('matchAccepted','nearZero','match','residualPx','reason'):
            errors.append(replay_difference(row.get(field),prior.get(field),'wood.'+size+'.'+field))
    return max(errors,default=0.)


def check_raw_pair(new,cached):
    errors=[]
    for key in ('status','reasons','woodAccepted','validationPassed','validationResidualsPx',
                'headGray','headGradient','reverseHead','vectorPx','residualPx',
                'channelDisagreementPx','roundTripPx'):
        errors.append(replay_difference(new.get(key),cached.get(key),'nail.'+key))
    return max(errors,default=0.)


def validate_sources(manifests,reports):
    inputs=[(path,motion.load_manifest(path)) for path in manifests]
    items={item['id']:item for _,data in inputs for item in data['items']}
    if len(items)!=sum(len(data['items']) for _,data in inputs):raise ValueError('duplicate source IDs')
    expected=[dict(path=str(path),sha256=motion.digest(path)) for path,_ in inputs]
    hashes={name:{v:motion.digest(view['_path']) for v,view in item['views'].items()} for name,item in items.items()}
    for report in reports:
        if report['sourceManifests']!=expected:raise ValueError('baseline manifests differ from supplied inputs')
        if len(report['items'])!=len(items) or {row['id'] for row in report['items']}!=set(items):
            raise ValueError('baseline item set differs from sources')
        for row in report['items']:
            if row['sourceHashes']!=hashes[row['id']]:raise ValueError('source image changed: '+row['id'])
        gates=report.get('matchingGates',report.get('headAndTemplateGates'))
        if gates!=motion.CONFIG:raise ValueError('baseline matching gates differ from current gates')
        if report.get('eccGates',report.get('configuration'))!=alignment.CONFIG:
            raise ValueError('baseline registration gates differ from current gates')
    return items


def head_summary(rows,controls):
    output={}
    for name in MODES:
        pairs=[p[name] for row in rows for p in row['pairs'].values()]
        cs=[c['variants'][name] for c in controls]
        measured=[(c,p) for c,p in zip(controls,cs) if p['status']=='measured']
        zero=[p for c,p in measured if c['relativeShiftPx']==0]
        errors=[float(np.linalg.norm(np.array(p['vectorPx'])-[0,c['relativeShiftPx']])) for c,p in measured]
        output[name]=dict(pairs=len(pairs),woodAccepted=sum(bool(p.get('woodAccepted')) for p in pairs),
            measuredPairs=sum(p['status']=='measured' for p in pairs),
            rejections=dict(Counter(reason for p in pairs for reason in p['reasons'])),
            trajectories=dict(Counter(row['trajectories'][name]['status'] for row in rows)),
            controls=dict(total=len(cs),measured=len(measured),rejected=len(cs)-len(measured),
                zeroTotal=sum(c['relativeShiftPx']==0 for c in controls),zeroMeasured=len(zero),
                falseMotionOver075px=sum(p['residualPx']>.75 for p in zero),
                medianVectorErrorPx=float(np.median(errors)) if errors else None,maxVectorErrorPx=max(errors,default=None)))
    return output


def negative_summary(rows):
    result={}
    for kind in sorted({r['kind'] for r in rows}):
        cases=[r for r in rows if r['kind']==kind]
        result[kind]={}
        for mode in MODES:
            pairs=[r['variants'][mode] for r in cases]
            head_stage=cases[0]['expectedRejectStage']=='head'
            result[kind][mode]=dict(total=len(cases),
                eligibleAtExpectedStage=sum(bool(p.get('woodAccepted')) for p in pairs) if head_stage else len(cases),
                falseAcceptanceAtExpectedStage=sum(p['status']=='measured' if head_stage else bool(p.get('woodAccepted')) for p in pairs),
                acceptedPairs=sum(p['status']=='measured' for p in pairs),
                rejections=dict(Counter(reason for p in pairs for reason in p['reasons'])))
    return result


def render(result,output):
    esc=lambda value:html.escape(str(value),quote=True)
    table='<table><tr><th>Wood patch</th><th>Raw near-zero</th><th>Smoothed near-zero</th><th>Raw-first fallback near-zero</th></tr>'
    for size,raw in result['summary']['wood']['raw'].items():
        smooth=result['summary']['wood']['smoothed'][size]
        fallback=result['summary']['wood']['raw_first'][size]
        table+=f'<tr><td>{size}px</td><td>{raw["nearZero"]}/{raw["total"]}</td><td>{smooth["nearZero"]}/{smooth["total"]}</td><td>{fallback["nearZero"]}/{fallback["total"]}</td></tr>'
    table+='</table><table><tr><th>Pipeline</th><th>Wood accepted</th><th>Head measured</th><th>Controls measured</th><th>False zero-control movement &gt;0.75px</th></tr>'
    for name,row in result['summary']['heads'].items():
        c=row['controls']
        table+=f'<tr><td>{esc(name)}</td><td>{row["woodAccepted"]}/{row["pairs"]}</td><td>{row["measuredPairs"]}/{row["pairs"]}</td><td>{c["measured"]}/{c["total"]}</td><td>{c["falseMotionOver075px"]}/{c["zeroMeasured"]} measurable</td></tr>'
    table+='</table>'
    cards=[]
    for row in result['headItems']:
        figures=''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>' for name,path in row['images'].items())
        lines=''.join('<p><b>'+esc(mode)+'</b>: '+'; '.join(esc(view)+': '+esc(pair[mode]['status'])+' · '+esc(', '.join(pair[mode]['reasons'])) for view,pair in row['pairs'].items())+'</p>' for mode in MODES)
        measured=any(p[mode]['status']=='measured' for p in row['pairs'].values() for mode in MODES)
        cards.append(f'<article data-measured="{str(measured).lower()}"><h2>{esc(row["id"])}</h2><div class="images">{figures}</div>{lines}<details><summary>Measurements and rejection reasons</summary><pre>{esc(json.dumps(row,indent=2))}</pre></details></article>')
    page='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Frozen affine matching smoothing</title><style>
body{font:16px/1.5 system-ui;background:#111b25;color:#e8eef6;margin:28px}section,article{padding:22px;background:#1b2b3a;border-radius:14px;margin:20px 0}table{border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #456;text-align:left}.images{display:flex;gap:16px;flex-wrap:wrap}figure{margin:0}img{width:224px;height:224px;object-fit:contain;image-rendering:pixelated}figcaption{font-size:13px}pre{white-space:pre-wrap;max-height:400px;overflow:auto}a{color:#8cf}input{padding:8px}</style><h1>Fixed smoothing · frozen affine transforms</h1>
<p>A fixed 3×3 Gaussian filter, σ=0.8, is applied equally to reference and aligned target before matching. Wood and head smoothing are compared separately and together. No transform is refitted, source location reselected or threshold lowered. Smoothed wood matching needs one extra pixel of valid support; head matching checks three extra pixels to also cover the existing gradient filter. Grayscale matching and gradient, reverse, channel-consistency and trajectory gates remain in place.</p>
<p>Rejected controls remain in denominators. Generated shifts are image-space checks, not physical nail height. A measured displacement is not a PN decision; a small displacement does not establish that a nail is seated.</p>'''
    page+='<p>Raw-first fallback keeps successful raw wood checks and vetoes confident residuals above 0.75px. Only weak or ambiguous raw matches can retry with smoothing; heads use the fixed smoothing. Every template records its selected path and raw rejection. This adds an acceptance path that requires separate wrong-correspondence controls.</p>'
    page+='<section>'+table+'<p><a href="results.json">Full results, controls and provenance</a></p><details><summary>Control summaries</summary><pre>'+esc(json.dumps(result['summary']['woodControls'],indent=2))+'</pre></details></section>'
    negative_table='<table><tr><th>Wrong correspondence</th><th>Raw accepted pairs</th><th>Head-only accepted pairs</th><th>Fallback accepted pairs</th></tr>'
    for kind,stats in result['summary']['negativeControls'].items():
        negative_table+='<tr><td>'+esc(kind)+'</td>'+''.join(f'<td>{stats[m]["acceptedPairs"]}/{stats[m]["total"]}</td>' for m in ('raw','head_only','raw_first'))+'</tr>'
    negative_table+='</table>'
    page+='<section><h2>Deliberately wrong matches</h2><p>Known identity alignment bypasses fitting to test the validation/matching stages. Sources are the same preselected control groups, with native-sized donors from a different group. Whole-frame errors, one misplaced validator, another pallet and another nail head are tested clean and with brightness/blur. These manipulated cases are not a production false-positive estimate.</p>'+negative_table+'<details><summary>Stage-specific counts, skipped sources and rejected cases</summary><pre>'+esc(json.dumps(dict(summary=result['summary']['negativeControls'],skipped=result['negativeSkipped']),indent=2))+'</pre></details>'
    for row in result['negativeControls']:
        if any(p.get('woodAccepted') if row['expectedRejectStage']=='wood' else p['status']=='measured' for p in row['variants'].values()):
            figures=''.join(f'<figure><img src="{esc(path)}"><figcaption>{esc(name)}</figcaption></figure>' for name,path in row['images'].items())
            page+='<article><h3>'+esc(row['id'])+' · '+esc(row['kind'])+' · '+esc(row['appearance'])+'</h3><div class="images">'+figures+'</div><details><summary>False-acceptance diagnostics</summary><pre>'+esc(json.dumps(row,indent=2))+'</pre></details></article>'
    page+='</section>'
    page+='<input id="filter" placeholder="Filter nail ID"><label><input id="measured" type="checkbox">Show measured pairs only</label>'+''.join(cards)
    page+='''<script>function applyFilter(){let q=document.getElementById('filter').value.toLowerCase(),m=document.getElementById('measured').checked;document.querySelectorAll('article').forEach(a=>a.hidden=!(a.innerText.toLowerCase().includes(q)&&(!m||a.dataset.measured==='true')))}document.getElementById('filter').oninput=applyFilter;document.getElementById('measured').onchange=applyFilter;</script></html>'''
    (output/'review.html').write_text(page)


def run(manifests,wood_paths,head_path,output):
    if output.exists():raise ValueError('output directory already exists')
    woods=[json.loads(path.read_text()) for path in wood_paths]
    heads=json.loads(head_path.read_text())
    if not woods or any(r.get('registration')!='direct_affine' for r in woods):
        raise ValueError('supply at least one direct_affine wood report')
    if len({r['controlGeometry'] for r in woods})!=len(woods):raise ValueError('duplicate control geometry')
    sources=validate_sources(manifests,woods+[heads])
    if any('direct_affine' not in row['methods'] for row in heads['items']):raise ValueError('head report lacks direct_affine')
    # Multiple control reports may reuse the real data, but must freeze identical fits.
    for report in woods[1:]:
        if report['items']!=woods[0]['items']:raise ValueError('wood reports differ in real measurements')
    output.mkdir(parents=True);(output/'images').mkdir()
    real=[];control_rows={};head_rows=[];head_controls=[];max_replay_difference=0.
    images={key:{view:cv2.imread(v['_path']) for view,v in item['views'].items()} for key,item in sources.items()}
    for item in woods[0]['items']:
        source=sources[item['id']];ref=images[item['id']]['A']
        for probe in item['probes']:
            for view,cached in probe['pairs'].items():
                initial=np.asarray(source['views'][view]['referenceToView'],float).reshape(3,3)
                variants=frozen_probe(ref,images[item['id']][view],initial,probe,cached)
                max_replay_difference=max(max_replay_difference,check_raw_probe(variants['raw'],cached))
                real.append(dict(id=item['id'],group=item['group'],probe=probe['ordinal'],view=view,variants=variants))
    for report in woods:
        geometry=report['controlGeometry'];rows=[]
        probes={item['id']:item['probes'][0] for item in report['items'] if item['probes']}
        for cached in report['controls']:
            ref=images[cached['id']]['A'];height,width=ref.shape[:2]
            target=cv2.warpPerspective(ref,np.asarray(cached['geometry']['matrix']),(width,height))
            if 'blur' in cached['appearance']:target=cv2.GaussianBlur(target,(5,5),.8)
            if 'brightness' in cached['appearance']:target=np.clip(target.astype(float)*.8+15,0,255).astype(np.uint8)
            variants=frozen_probe(ref,target,np.eye(3),probes[cached['id']],cached)
            max_replay_difference=max(max_replay_difference,check_raw_probe(variants['raw'],cached))
            oracle=copy.deepcopy(cached);oracle['fit']=dict(accepted=True,woodTransform=cached['geometry']['matrix'])
            exact=frozen_probe(ref,target,np.eye(3),probes[cached['id']],oracle)
            rows.append(dict(id=cached['id'],group=cached['group'],appearance=cached['appearance'],
                geometry=cached['geometry'],variants=variants,knownTransform=exact))
        control_rows[geometry]=rows
    for index,cached_row in enumerate(heads['items']):
        name=cached_row['id'];source=sources[name];ref=images[name]['A'];roi=source['roi']
        row={k:cached_row[k] for k in ('id','group','reviewCategory','reviewNote') if k in cached_row}
        row.update(pairs={},trajectories={},images={})
        cx,cy=np.rint(alignment.center_of(roi)).astype(int)
        def save(label,image):
            filename=f'images/{index:04d}-{label}.png'
            crop=image[max(0,cy-48):cy+48,max(0,cx-48):cx+48]
            if crop.dtype!=np.uint8:crop=np.clip(crop,0,255).astype(np.uint8)
            if not cv2.imwrite(str(output/filename),crop):raise OSError('image write failed')
            row['images'][label]=filename
        save('A-native',ref)
        save('A-smoothed',motion.matching_gray(ref,True))
        for view,cached in cached_row['methods']['direct_affine']['pairs'].items():
            initial=np.asarray(source['views'][view]['referenceToView'],float).reshape(3,3)
            variants,aligned=frozen_pair(ref,images[name][view],roi,initial,cached_row['adaptiveLayout'],cached)
            max_replay_difference=max(max_replay_difference,check_raw_pair(variants['raw'],cached));row['pairs'][view]=variants
            if aligned is not None:
                save(view+'-aligned',aligned);save(view+'-smoothed',motion.matching_gray(aligned,True))
        for mode in MODES:row['trajectories'][mode]=motion.classify_trajectory({v:p[mode] for v,p in row['pairs'].items()},source.get('baselines'))
        head_rows.append(row)
        print(f'Processed {index+1}/{len(heads["items"])}: {name}',file=sys.stderr,flush=True)
    layouts={row['id']:row['adaptiveLayout'] for row in heads['items']}
    for control in heads['controls']:
        if control['method']!='direct_affine':continue
        ref=images[control['id']]['A'];roi=sources[control['id']]['roi']
        target=alignment.controlled_target(ref,roi,control['relativeShiftPx'],control['appearance'])
        variants,_=frozen_pair(ref,target,roi,np.eye(3),layouts[control['id']],control['measurement'])
        max_replay_difference=max(max_replay_difference,check_raw_pair(variants['raw'],control['measurement']))
        head_controls.append({**{key:control[key] for key in ('id','group','relativeShiftPx','appearance')},'variants':variants})
    negative_rows=[];negative_skipped=[];selected=[row['id'] for row in heads['controlSelection']]
    for name in selected:
        source=sources[name];ref=images[name]['A'];layout=layouts[name]
        if sum(r['role']=='validation' for r in layout)!=3:
            negative_skipped.append(dict(id=name,reason='reference_cannot_supply_three_validators'));continue
        donor=matching_negatives.donor_for(name,selected,sources,images)
        cases,skipped=matching_negatives.generate(ref,source['roi'],layout,
            images[donor]['A'] if donor else None,sources[donor]['roi'] if donor else None)
        negative_skipped.extend(dict(row,id=name) for row in skipped)
        for metadata,target in cases:
            variants=aligned_pair(ref,target,np.ones(ref.shape[:2],np.uint8),source['roi'],layout,np.eye(3).tolist())
            row=dict(metadata,id=name,group=source['group'],donorId=donor,variants=variants,images={})
            if any(p.get('woodAccepted') if row['expectedRejectStage']=='wood' else p['status']=='measured' for p in variants.values()):
                for label,img in [('reference',ref),('wrong-target',target)]:
                    filename=f'images/negative-{len(negative_rows):03d}-{label}.png'
                    if not cv2.imwrite(str(output/filename),img):raise OSError('negative preview write failed')
                    row['images'][label]=filename
            negative_rows.append(row)
    summary=dict(wood={name:wood.summarize([row['variants'][name] for row in real]) for name in WOOD_MODES},
        woodControls={geometry:{name:wood.summarize([row['variants'][name] for row in rows]) for name in WOOD_MODES} for geometry,rows in control_rows.items()},
        knownTransformControls={geometry:{name:wood.summarize([row['knownTransform'][name] for row in rows]) for name in WOOD_MODES} for geometry,rows in control_rows.items()},
        heads=head_summary(head_rows,head_controls),negativeControls=negative_summary(negative_rows))
    result=dict(method=METHOD,matchingConfiguration=motion.CONFIG,smoothingConfiguration=motion.SMOOTHING_CONFIG,modes=MODES,
        registration='frozen_direct_affine',sourceManifests=woods[0]['sourceManifests'],
        baselines=[dict(path=str(p),sha256=motion.digest(p)) for p in wood_paths+[head_path]],
        algorithmHashes={Path(p).name:motion.digest(p) for p in [__file__,motion.__file__,alignment.__file__,wood.__file__,matching_negatives.__file__]},
        opencvVersion=cv2.__version__,sourceHashes={row['id']:row['sourceHashes'] for row in heads['items']},
        verification=dict(sourceHashesChecked=True,rawWoodMeasurementsReproduced=True,rawHeadMeasurementsReproduced=True,
                          rawReplayAbsoluteTolerance=REPLAY_ABSOLUTE_TOLERANCE,maxRawReplayDifference=max_replay_difference,
                          fittingRerun=False,thresholdsChanged=False,locationsReselected=False),
        woodReal=real,woodControls=control_rows,headItems=head_rows,headControls=head_controls,
        negativeControls=negative_rows,negativeSkipped=negative_skipped,negativeConfiguration=matching_negatives.CONFIG,summary=summary,
        physicalHeight='not_measured',pnDecision='not_made')
    (output/'results.json').write_text(json.dumps(result,indent=2,allow_nan=False));render(result,output)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,action='append',required=True)
    parser.add_argument('--wood-report',type=Path,action='append',required=True)
    parser.add_argument('--head-report',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:
        result=run([p.resolve() for p in args.input],[p.resolve() for p in args.wood_report],args.head_report.resolve(),args.output.resolve())
        print(json.dumps(result['summary'],indent=2))
    except (ValueError,KeyError,TypeError,OSError,cv2.error) as error:
        print(str(error),file=sys.stderr);return 2
    return 0


if __name__=='__main__':raise SystemExit(main())
