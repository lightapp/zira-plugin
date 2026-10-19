/* Native-pixel annotations; no requests, uploads, or source-image writes. */
'use strict';
const GrainMarks = (() => {
  const colors = {indentation:'#ffe050',crushed:'#ff8f45',intact:'#57eb88',boundary:'#81cfff',unclear:'#ed88ed'};
  const statuses = ['unreviewed','marked','none_visible','insufficient_detail','boundary_wrong'];
  function point(clientX,clientY,rect,width,height) {
    return [Math.max(0,Math.min(width,(clientX-rect.left)*width/rect.width)),
            Math.max(0,Math.min(height,(clientY-rect.top)*height/rect.height))];
  }
  function record(item) {
    return {id:item.id,sourceSha256:item.sourceSha256,analysisCrop:item.analysisCrop.slice(),
            size:item.size.slice(),status:'unreviewed',notes:'',strokes:[]};
  }
  function documentFor(report,records) {
    return {schemaVersion:1,method:report.method,manifestSha256:report.manifestSha256,
            coordinateSpace:'native_crop_pixel_edges',sourceCoordinateRule:'Add analysisCrop left/top to each point',
            updatedAt:new Date().toISOString(),items:report.items.map(i=>records[i.id]).filter(Boolean)};
  }
  function validate(data,report) {
    if(data.schemaVersion!==1||data.method!==report.method||data.manifestSha256!==report.manifestSha256||
       data.coordinateSpace!=='native_crop_pixel_edges'||!Array.isArray(data.items)) throw Error('Annotation provenance mismatch');
    const expected=new Map(report.items.map(i=>[i.id,i])),records=Object.create(null);
    for(const r of data.items) {
      const item=expected.get(r.id);
      if(!item||records[r.id]||r.sourceSha256!==item.sourceSha256||JSON.stringify(r.analysisCrop)!==JSON.stringify(item.analysisCrop)||
         JSON.stringify(r.size)!==JSON.stringify(item.size)||!statuses.includes(r.status)||typeof r.notes!=='string'||!Array.isArray(r.strokes)) throw Error('Annotation item mismatch');
      for(const stroke of r.strokes) {
        if(!Object.hasOwn(colors,stroke.kind)||![1,2,3].includes(stroke.width)||!Array.isArray(stroke.points)||!stroke.points.length) throw Error('Invalid stroke');
        for(const p of stroke.points) if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>item.size[0]||p[1]<0||p[1]>item.size[1]) throw Error('Invalid coordinates');
      }
      records[r.id]=r;
    }
    return records;
  }
  return {colors,statuses,point,record,documentFor,validate};
})();
if(typeof module!=='undefined') module.exports=GrainMarks;

if(typeof document!=='undefined') (() => {
  const D=JSON.parse(document.getElementById('data').textContent),q=id=>document.getElementById(id);
  const key='grain-evidence:'+D.method+':'+D.manifestSha256;
  let records=Object.create(null),ids=[],index=0,current=null,image=null,draft=null,serial=0,storageFailure='';
  const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=x=>x===null||x===undefined?'unavailable':Number(x).toFixed(3);
  try { const saved=localStorage.getItem(key); if(saved) records=GrainMarks.validate(JSON.parse(saved),D); }
  catch(error) { storageFailure='Could not load browser marks: '+error.message+'. Export JSON to keep new marks.'; }
  function snapshot() { return GrainMarks.documentFor(D,records); }
  function updateExport() {
    q('exportText').value=JSON.stringify(snapshot(),null,2);
    const reviewed=Object.values(records).filter(r=>r.status!=='unreviewed').length;
    q('progress').textContent=`${reviewed} / ${D.items.length} reviewed · ${Object.values(records).reduce((n,r)=>n+r.strokes.length,0)} strokes`;
  }
  function save() {
    updateExport();
    try { localStorage.setItem(key,q('exportText').value);q('saveStatus').textContent=storageFailure||'Saved in this browser'; }
    catch(error) { q('saveStatus').textContent='Browser saving failed. Download marks JSON before closing.'; }
  }
  function state() { if(!records[current.id]) records[current.id]=GrainMarks.record(current);return records[current.id]; }
  function paintStroke(ctx,stroke) {
    ctx.strokeStyle=GrainMarks.colors[stroke.kind];ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=stroke.width;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();stroke.points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();
    if(stroke.points.length===1){ctx.beginPath();ctx.arc(...stroke.points[0],stroke.width/2,0,Math.PI*2);ctx.fill();}
  }
  function draw() {
    const c=q('canvas'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);
    if(image)ctx.drawImage(image,0,0);
    if(q('showMarks').checked){for(const s of state().strokes)paintStroke(ctx,s);if(draft)paintStroke(ctx,draft);}
    q('undo').disabled=!state().strokes.length;
  }
  function zoom() {
    const scale=Number(q('zoom').value),[w,h]=current.size;
    q('canvas').style.width=w*scale+'px';q('canvas').style.height=h*scale+'px';
    q('overlay').style.width=w*scale+'px';q('overlay').style.height=h*scale+'px';
  }
  function render() {
    draft=null;current=D.items.find(i=>i.id===ids[index]);if(!current)return;
    const token=++serial,s=state(),g=current.grain,p=g.primary;
    q('status').disabled=q('notes').disabled=false;
    q('heading').textContent=current.id;q('label').textContent=`${current.cohort} · ${current.reviewCategory||current.label||''} · ${current.size.join(' × ')} native crop pixels`;
    q('position').textContent=`${index+1} / ${ids.length}`;q('case').value=current.id;
    q('previous').disabled=index===0;q('next').disabled=index===ids.length-1;
    q('status').value=s.status;q('notes').value=s.notes;
    q('canvas').width=current.size[0];q('canvas').height=current.size[1];image=null;zoom();draw();
    const img=new Image();img.onload=()=>{if(serial===token){image=img;draw();}};img.onerror=()=>{q('saveStatus').textContent='Source crop failed to load; do not annotate.';};img.src=current.images.raw;
    q('overlay').src=current.images.overlay;
    q('measurements').innerHTML=`<p>Score: ${fmt(p.score)} · usable sections ${p.validSectors}/8 · quality: ${esc(p.reasons.join(', ')||'usable')}<br>±1 pixel range: ${fmt(g.sensitivity.minScore)}–${fmt(g.sensitivity.maxScore)} · all variants usable: ${g.allVariantsUsable}</p><table><tr><th>Section</th><th>Near / reference pixels</th><th>Off-grain excess</th><th>Coherence loss</th><th>Direction change</th><th>Reason</th></tr>${p.sectors.map(r=>`<tr><td>${r.index+1}</td><td>${r.nearPixels} / ${r.referencePixels}</td><td>${fmt(r.offGrainExcess)}</td><td>${fmt(r.coherenceLoss)}</td><td>${fmt(r.directionChangeDeg)}</td><td>${esc(r.reasons.join(', '))}</td></tr>`).join('')}</table>`;
    updateExport();
  }
  function filter() {
    const old=current?.id,cohort=q('cohort').value;
    const allowed=q('scope').value==='first'&&D.firstReviewIds.length?D.firstReviewIds:D.items.map(i=>i.id);
    ids=allowed.filter(id=>!cohort||D.items.find(i=>i.id===id).cohort===cohort);
    q('case').replaceChildren(...ids.map(id=>{const option=document.createElement('option');option.value=id;option.textContent=id;return option;}));
    index=Math.max(0,ids.indexOf(old));
    if(!ids.length){serial++;draft=null;q('heading').textContent='No cases in this filter';q('position').textContent='0 cases';q('previous').disabled=q('next').disabled=true;q('status').disabled=q('notes').disabled=q('undo').disabled=true;current=null;image=null;q('canvas').getContext('2d').clearRect(0,0,q('canvas').width,q('canvas').height);q('overlay').removeAttribute('src');q('label').textContent='';q('measurements').textContent='';return;}
    render();
  }
  for(const c of Object.keys(D.summary.cohorts)){const option=document.createElement('option');option.textContent=c;q('cohort').append(option);}
  q('summary').innerHTML='<table><tr><th>Cohort</th><th>All / groups</th><th>Usable</th><th>Usable at all boundaries</th><th>Median score [25–75%]</th></tr>'+Object.entries(D.summary.cohorts).map(([c,s])=>`<tr><td>${esc(c)}</td><td>${s.total} / ${s.groups}</td><td>${s.usable}</td><td>${s.usableAllVariants}</td><td>${fmt(s.median)} [${fmt(s.q25)}–${fmt(s.q75)}]</td></tr>`).join('')+'</table>';
  if(D.summary.comparison){const c=D.summary.comparison;q('summary').innerHTML+=`<p>${esc(c.referenceCohort)} scored higher than ${esc(c.comparisonCohort)} in ${c.referenceRanksHigher===undefined?'unavailable':(100*c.referenceRanksHigher).toFixed(1)+'%'} of pairs on the fixed usable subset (${c.referenceCount} × ${c.comparisonCount} cases). Equal scores count half. This is an exploratory ordering statistic, not detection accuracy.</p><pre>${esc(JSON.stringify(c,null,2))}</pre>`;}
  if(D.controls){q('summary').innerHTML+='<h3>Constructed texture / lighting controls</h3><table><tr><th>Input</th><th>Known change</th><th>Score</th><th>Usable sections</th></tr>'+D.controls.map(c=>`<tr><td><a href="${esc(c.image)}">${esc(c.name)}</a></td><td>${esc(c.constructedTruth)}</td><td>${fmt(c.measurement.score)}</td><td>${c.measurement.validSectors}/8</td></tr>`).join('')+'</table><p>These controls test the measurement response, not physical protrusion. Shading can change gradients even when the grain pattern is unchanged.</p>';}
  q('scope').onchange=q('cohort').onchange=filter;
  q('case').onchange=()=>{index=ids.indexOf(q('case').value);render();};
  q('previous').onclick=()=>{if(index>0){index--;render();}};q('next').onclick=()=>{if(index<ids.length-1){index++;render();}};
  q('zoom').onchange=()=>{if(current)zoom();};q('showMarks').onchange=()=>{if(current)draw();};
  q('status').onchange=()=>{if(current){state().status=q('status').value;save();}};
  q('notes').oninput=()=>{if(current){state().notes=q('notes').value;save();}};
  q('undo').onclick=()=>{if(current){state().strokes.pop();save();draw();}};
  const c=q('canvas');
  c.onpointerdown=e=>{if(!current||!image||e.button!==0)return;q('showMarks').checked=true;c.setPointerCapture(e.pointerId);draft={kind:q('kind').value,width:Number(q('brush').value),points:[GrainMarks.point(e.clientX,e.clientY,c.getBoundingClientRect(),c.width,c.height)]};draw();};
  c.onpointermove=e=>{if(!draft)return;const p=GrainMarks.point(e.clientX,e.clientY,c.getBoundingClientRect(),c.width,c.height),last=draft.points.at(-1);if(Math.hypot(p[0]-last[0],p[1]-last[1])>=.2){draft.points.push(p);draw();}};
  c.onpointerup=e=>{if(!draft)return;state().strokes.push(draft);draft=null;if(state().status==='unreviewed')state().status='marked';q('status').value=state().status;if(c.hasPointerCapture(e.pointerId))c.releasePointerCapture(e.pointerId);save();draw();};
  c.onpointercancel=()=>{draft=null;if(current)draw();};
  q('download').onclick=()=>{save();const blob=new Blob([q('exportText').value],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='wood-grain-marks.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  q('saveStatus').textContent=storageFailure||'Marks will save in this browser';filter();
})();
