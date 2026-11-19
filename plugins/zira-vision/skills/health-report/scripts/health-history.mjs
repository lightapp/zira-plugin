import path from 'node:path';
import {readFileSync} from 'node:fs';
import {runtimeStatus,scenePaths,runtimePython} from '../../validate-trimsaw-sizes/scripts/scene.mjs';
const logo=readFileSync(new URL('../../../assets/zira-logo-light.svg',import.meta.url)).toString('base64');
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { writePrivate } from './storage.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudHealthHistory, healthCloudClient } from './health-cloud.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
// Check decoded dimensions before embedding untrusted archive bytes in a browser.
// A small compressed JPEG can otherwise claim an enormous pixel allocation.
function boundedJpeg(bytes) {
  if(bytes.length<15 || bytes.readUInt16BE(0)!==0xffd8 || bytes.readUInt16BE(bytes.length-2)!==0xffd9)throw new Error('Invalid JPEG');
  let at=2;
  const frames=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while(at<bytes.length-2) {
    if(bytes[at++]!==0xff)break;
    while(bytes[at]===0xff)at++;
    const marker=bytes[at++];
    if(marker===0xda || marker===0xd9 || at+2>bytes.length)break;
    const size=bytes.readUInt16BE(at);
    if(size<2 || at+size>bytes.length)break;
    if(frames.has(marker)) {
      if(size<8)break;
      const height=bytes.readUInt16BE(at+3),width=bytes.readUInt16BE(at+5);
      if(width<1 || height<1 || width>320 || height>320)throw new Error('JPEG dimensions exceed capture limit');
      return;
    }
    at+=size;
  }
  throw new Error('Invalid JPEG frame header');
}
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function readHealthArchive(data, expectedHash, scope) {
  if (!Buffer.isBuffer(data) || data.length > 2 * 1024 * 1024 || data.length < 22 || hash(data) !== expectedHash) throw new Error('Archive size/hash mismatch');
  // Android ZipOutputStream uses ordinary stored/deflated members. Parse the central directory
  // into bounded buffers; never extract paths, follow symlinks or execute archived content.
  let end = -1;
  for (let n = data.length - 22; n >= Math.max(0, data.length - 65557); n--) if (data.readUInt32LE(n) === 0x06054b50 && n + 22 + data.readUInt16LE(n + 20) === data.length) { end = n; break; }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP archive');
  const count = data.readUInt16LE(end + 10), directorySize = data.readUInt32LE(end + 12), directory = data.readUInt32LE(end + 16);
  if (!count || count > 112 || directory + directorySize !== end || data.readUInt16LE(end + 8) !== count) throw new Error('Archive directory limit');
  const files = new Map(); let at = directory, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP directory');
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), offset = data.readUInt32LE(at + 42);
    if (at + 46 + nameLength + extra + comment > end) throw new Error('Truncated ZIP directory');
    const name = data.subarray(at + 46, at + 46 + nameLength).toString('utf8'); at += 46 + nameLength + extra + comment;
    expanded += size;
    if (flags & 1 || ![0, 8].includes(method) || size > 65536 || expanded > 8 * 1024 * 1024 || files.has(name) ||
      !/^(manifest\.json|settings-\d{13}\.json|view-\d{13}\.(jpg|json))$/.test(name)) throw new Error('Unexpected archive member');
    if (offset + 30 > directory || data.readUInt32LE(offset) !== 0x04034b50 || data.readUInt16LE(offset + 8) !== method) throw new Error('Invalid ZIP member header');
    const localName = data.readUInt16LE(offset + 26), localExtra = data.readUInt16LE(offset + 28), start = offset + 30 + localName + localExtra;
    if (start + compressed > directory || data.subarray(offset + 30, offset + 30 + localName).toString('utf8') !== name) throw new Error('Invalid ZIP member bounds');
    const packed = data.subarray(start, start + compressed);
    const bytes = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: 65536 });
    if (bytes.length !== size) throw new Error('Archive member size mismatch');
    files.set(name, bytes);
  }
  if (at !== end || !files.has('manifest.json')) throw new Error('Missing archive manifest');
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  const prefix = `companies-${scope.companyId}/sites-${scope.siteId}/devices-${scope.deviceId}/identities-`;
  if (manifest.kind !== 'device-health' || manifest.schemaVersion !== 1 || typeof manifest.scope !== 'string' ||
    !manifest.scope.startsWith(prefix) || !/^[A-Za-z0-9:_-]{1,160}$/.test(manifest.scope.slice(prefix.length))) throw new Error('Archive tenant mismatch');
  const views = [], settings = [];
  for (const [name, bytes] of files) {
    if (name.startsWith('view-') && name.endsWith('.jpg')) {
      boundedJpeg(bytes);
      const metadataBytes=files.get(name.replace('.jpg','.json'));
      const metadata=metadataBytes ? JSON.parse(metadataBytes.toString('utf8')) : null;
      if(metadata && (metadata.schemaVersion!==2 || metadata.imageSha256!==hash(bytes) ||
        !Number.isSafeInteger(metadata.frameAtEpochMs) || metadata.frameAtEpochMs<1000000000000 ||
        !metadata.settings || typeof metadata.settings!=='object' || Array.isArray(metadata.settings))) throw new Error('Invalid image/settings association');
      views.push({ atEpochMs: metadata?.frameAtEpochMs ?? Number(name.slice(5, 18)), sha256: hash(bytes), data: bytes.toString('base64'), metadata });
    }
    if (name.startsWith('settings-')) {
      const row = JSON.parse(bytes.toString('utf8'));
      if (!row || !row.settings || typeof row.settings !== 'object' || Array.isArray(row.settings) || !/^[a-f0-9]{64}$/.test(row.revision) ||
        !Number.isSafeInteger(row.observedAtEpochMs) || row.observedAtEpochMs <= 0 || row.observedAtEpochMs >= 4102444800000) throw new Error('Invalid settings revision');
      settings.push(row);
    }
  }
  return { manifest, views, settings };
}
export function settingChanges(before, after, prefix='') {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort().flatMap(key => {
    const a=before?.[key],b=after?.[key],name=prefix ? `${prefix}.${key}` : key;
    if(JSON.stringify(a)===JSON.stringify(b))return [];
    if(a && b && typeof a==='object' && typeof b==='object' && !Array.isArray(a) && !Array.isArray(b))return settingChanges(a,b,name);
    return [{setting:name,before:a ?? null,after:b ?? null}];
  });
}
const stamp = ms => Number.isFinite(ms) ? new Date(ms).toISOString().replace('T',' ').replace('.000Z',' UTC') : 'Unavailable';
function cameraSection(history) {
  const events=history.events ?? [], comparisons=history.comparisons ?? [];
  let previous;
  return `<article id="camera-${escape(history.deviceId)}"><h2>Camera ${escape(history.deviceId)}</h2>
<p>${escape(history.name ?? '')} · ${history.views.length} images · ${events.length} sensor events</p>
<aside>${escape(history.gaps.join('; ') || 'Returned images cover the selected dates. Daily stills cannot rule out a brief bump and return.')}</aside>
<h3>When the camera may have moved</h3><table><tr><th>Time or interval</th><th>Evidence</th><th>Result</th></tr>
${events.map(e=>`<tr><td>${escape(stamp(e.atEpochMs))}</td><td>Device sensor · ${escape(e.kind)}</td><td>${e.timeUncertain?'Device clock uncertain':'Device event timestamp'}; review images to confirm view changed</td></tr>`).join('')}
${comparisons.map(c=>`<tr><td>${escape(stamp(c.from))}<br>to ${escape(stamp(c.to))}</td><td>Daily image comparison</td><td>${escape(c.state.replaceAll('_',' '))}${c.reason?': '+escape(c.reason):''}${c.shiftPx!==undefined?' · '+escape(c.shiftPx)+' px':''}</td></tr>`).join('')}
${!events.length&&!comparisons.length?'<tr><td colspan="3">No dated movement evidence available. This does not establish that the camera stayed still.</td></tr>':''}</table>
<h3>Daily views</h3><section class="views">${history.views.map(v=>`<figure><img loading="lazy" alt="Camera ${escape(history.deviceId)} view at ${escape(stamp(v.atEpochMs))}" src="data:image/jpeg;base64,${v.data}">
<figcaption><strong>${escape(stamp(v.atEpochMs))}</strong><br>${v.metadata?`Stream ${escape(v.metadata.streamWidth)} × ${escape(v.metadata.streamHeight)} · source ${escape(v.metadata.sourceWidth)} × ${escape(v.metadata.sourceHeight)}<br>Saved ${escape(v.metadata.imageWidth)} × ${escape(v.metadata.imageHeight)} · ${escape(v.metadata.representation)}`:'Legacy image: resolution/settings association unavailable'}
${v.metadata?`<details><summary>Settings and capture details</summary><pre>${escape(JSON.stringify(v.metadata,null,2))}</pre></details>`:''}</figcaption></figure>`).join('')}</section>
<h3>Settings changes</h3>${history.settings.map(row=>{const diff=previous?settingChanges(previous,row.settings):[];const baseline=!previous;previous=row.settings;
 return `<details><summary>${escape(stamp(row.observedAtEpochMs))} · ${baseline?'First available settings snapshot':diff.length+' changed settings'}</summary><pre>${escape(JSON.stringify(baseline?row.settings:diff,null,2))}</pre></details>`;
}).join('')}</article>`;
}
export function healthHistoryHtml(history) {
  const cameras=history.cameras ?? [history];
  const events=cameras.reduce((n,c)=>n+(c.events?.length??0),0);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Camera movement and daily history</title><style>
:root{color-scheme:dark}.logo{width:96px;height:32px;object-fit:contain;margin-bottom:24px}*{box-sizing:border-box}body{margin:0;background:#071C0F;color:#F0EAD8;font:16px 'DM Sans',system-ui,sans-serif;line-height:1.5;background-image:linear-gradient(#2ecc5a08 1px,transparent 1px),linear-gradient(90deg,#2ecc5a08 1px,transparent 1px);background-size:32px 32px}main{max-width:1400px;margin:auto;padding:36px}h1{font-size:42px;letter-spacing:-1.5px;line-height:1.1}h2{font-size:28px}h3{margin-top:28px}a{color:#2ECC5A}header p,.muted{color:#C8C2B0}.tag{font:12px 'DM Mono',monospace;border:1px solid #2ECC5A;border-radius:20px;padding:6px 12px;color:#2ECC5A}nav,.stats{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}.stats div{background:#0F3320;border-radius:12px;padding:16px 24px}.stats strong{display:block;color:#2ECC5A;font-size:30px}article{margin-top:32px;background:#0F3320;border:1px solid #2ecc5a33;border-radius:16px;padding:24px}aside{background:#071C0F;padding:16px;border-left:3px solid #E858C8}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #2ecc5a33;vertical-align:top}.views{display:flex;gap:16px;overflow-x:auto;padding-bottom:12px}figure{min-width:280px;max-width:360px;margin:0;background:#071C0F;padding:16px;border-radius:12px}img{width:100%;height:250px;object-fit:contain}figcaption{font-size:13px}pre{font:12px 'DM Mono',monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto}summary{cursor:pointer;padding:12px 0}footer{margin:32px 0;color:#C8C2B0}@media(max-width:700px){main{padding:16px}h1{font-size:32px}article{padding:16px}table{font-size:13px}}
</style><main><header><img class="logo" alt="Zira" src="data:image/svg+xml;base64,${logo}"><br><span class="tag">● ADMIN CAMERA HISTORY</span><h1>Camera movement<br>and daily views</h1><p>${escape(stamp(history.from))} — ${escape(stamp(history.to))}</p>
<p>Read-only evidence. Sensor events have device timestamps; visual changes are dated between images. Daily images can miss a camera moving and returning between captures. Saved settings are redacted and may differ from settings loaded by inference.</p></header>
<div class="stats"><div><strong>${cameras.length}</strong>cameras</div><div><strong>${cameras.reduce((n,c)=>n+c.views.length,0)}</strong>images</div><div><strong>${events}</strong>sensor events</div><div><strong>${cameras.filter(c=>c.gaps.length).length}</strong>cameras with coverage gaps</div></div>
<nav>${cameras.map(c=>`<a href="#camera-${escape(c.deviceId)}">Camera ${escape(c.deviceId)}</a>`).join('')}</nav>
${cameras.map(cameraSection).join('')}<footer>Private report · no external resources or automatic refresh · visual findings are candidates for review, not confirmed physical bumps.</footer></main></html>`;
}

export function mergeHealthEvidence(inventories, parsed, {from,to}) {
  const views=new Map(),settings=new Map(),events=new Map(),gaps=[];
  for(const item of parsed) {
    for(const v of item.views)if(v.atEpochMs>=from && v.atEpochMs<=to)views.set(`${v.atEpochMs}:${v.sha256}`,v);
    for(const row of item.settings)if(row.observedAtEpochMs<=to)settings.set(`${row.observedAtEpochMs}:${row.revision}`,row);
    for(const v of item.views)if(v.metadata && v.atEpochMs<=to)settings.set(`${v.metadata.settingsObservedAtEpochMs}:${v.metadata.settingsRevision}`,{observedAtEpochMs:v.metadata.settingsObservedAtEpochMs,revision:v.metadata.settingsRevision,settings:v.metadata.settings});
    const journal=item.manifest.movement;
    if(journal?.schemaVersion===1 && typeof journal.journalId==='string' && Array.isArray(journal.events))
      for(const e of journal.events.slice(0,64)) if(Number.isSafeInteger(e.id) && Number.isSafeInteger(e.atEpochMs) && e.atEpochMs>=from && e.atEpochMs<=to && ['bump','tilt'].includes(e.kind))
        events.set(`${item.manifest.scope}:${journal.journalId}:${e.id}`,{...e,journalId:journal.journalId,identity:item.manifest.scope});
  }
  const images=[...views.values()].sort((a,b)=>a.atEpochMs-b.atEpochMs);
  if(!images.length)gaps.push('No daily images in the selected interval');
  if(images.some(v=>!v.metadata))gaps.push('Legacy images lack exact resolution/settings association');
  for(let at=from;at<=to;at+=86400000) if(!images.some(v=>v.atEpochMs>=at && v.atEpochMs<Math.min(at+86400000,to+1)))gaps.push(`No image in the 24-hour window starting ${stamp(at)}`);
  const journals=parsed.map(p=>p.manifest.movement).filter(Boolean);
  if(!journals.some(j=>j.completeSinceAtEpochMs<=from && j.lastObservedAtEpochMs>=to))gaps.push('Sensor journal does not establish uninterrupted coverage of the entire interval');
  let rows=[...settings.values()].sort((a,b)=>a.observedAtEpochMs-b.observedAtEpochMs);
  const baseline=rows.filter(r=>r.observedAtEpochMs<from).at(-1);rows=rows.filter(r=>r.observedAtEpochMs>=from);if(baseline)rows.unshift(baseline);
  return {...inventories[0],from,to,archives:undefined,views:images,settings:rows,events:[...events.values()].sort((a,b)=>a.atEpochMs-b.atEpochMs),gaps};
}

async function compareImages(history, out, python) {
  python ??= process.env.ZIRA_HISTORY_PYTHON ?? ((await runtimeStatus()).ready ? runtimePython(scenePaths()) : 'python');
  const file=path.join(out,'evidence.json');await writePrivate(file,history);
  const script=fileURLToPath(new URL('./history-compare.py',import.meta.url));
  return new Promise(resolve=>{
    const child=spawn(python,['-I',script,'--evidence',file],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    let text='',done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(null);},60000);
    child.stdout.on('data',c=>{text+=c;if(text.length>256*1024){child.kill();finish(null);}});
    child.on('error',()=>finish(null));child.on('close',code=>{try{finish(code===0?JSON.parse(text):null);}catch{finish(null);}});
  });
}

export async function saveCloudHealthHistory(options, {request,fetchImpl=globalThis.fetch,budget={archives:60,bytes:64*1024*1024,deadline:Date.now()+600000},compare=compareImages}={}) {
  if(!options.out)throw new Error('--out DIRECTORY is required');
  const to=options.to ?? new Date().toISOString(),from=options.from ?? new Date(Date.parse(to)-7*86400000).toISOString();
  if(![from,to].every(s=>typeof s==='string' && /(Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s))) || Date.parse(from)>=Date.parse(to) || Date.parse(to)>Date.now()+60000)throw new Error('Supply an ordered past interval with explicit timezone offsets');
  const out=path.resolve(options.out);await mkdir(path.join(out,'cache'),{recursive:true,mode:0o700});
  request ??= await healthCloudClient(options.profile ?? 'prod');
  const inventories=[],archives=[],seen=new Set();let after;
  // Include up to 14 days of later uploads: offline phones may upload older captures later.
  const uploadTo=new Date(Math.min(Date.now(),Date.parse(to)+14*86400000)).toISOString();
  for(let page=0;page<4;page++) {
    if(Date.now()>budget.deadline)break;
    const inv=await cloudHealthHistory({...options,from,to:uploadTo,after,limit:30},{request});
    if(String(inv?.deviceId)!==String(options.deviceId) || !/^[1-9]\d*$/.test(inv.companyId) || !/^[1-9]\d*$/.test(inv.siteId) || !Array.isArray(inv.archives) || inv.archives.length>30)throw new Error('Invalid cloud history inventory');
    if(inventories.length && (inv.companyId!==inventories[0].companyId || inv.siteId!==inventories[0].siteId))throw new Error('History scope changed');
    inventories.push(inv);archives.push(...inv.archives);
    if(!inv.hasMore)break;
    if(!inv.nextAfter || seen.has(inv.nextAfter))throw new Error('History pagination failed to advance');
    seen.add(inv.nextAfter);after=inv.nextAfter;
  }
  if(!inventories.length)throw new Error('Report time budget exhausted');
  const parsed=[],receipts=[],gaps=[];
  if(inventories.at(-1).hasMore)gaps.push('Archive listing budget reached; narrow the interval to continue');
  if(inventories.some(i=>i.unavailable?.length))gaps.push('Some archives exceeded the allowed size');
  for(const archive of archives.sort((a,b)=>b.atEpochMs-a.atEpochMs)) {
    if(budget.archives<=0 || budget.bytes<archive.bytes || Date.now()>budget.deadline){gaps.push('Shared report download budget reached; narrow the scope');break;}
    const url=new URL(archive.url),bucket=options.profile==='integ'?'integ-vision-hub':'prod-vision-hub',region=options.profile==='integ'?'eu-west-1':'us-west-2';
    const inv=inventories[0],prefix=`manual-uploads/companies/${inv.companyId}/sites/${inv.siteId}/data-sources/${inv.deviceId}/camera-health/`;
    if(url.protocol!=='https:' || url.hostname!==`${bucket}.s3.${region}.amazonaws.com` || url.port || url.username || url.password ||
      !archive.key?.startsWith(prefix) || !/^\d{13}-[a-f0-9]{64}\.zip$/.test(archive.key.slice(prefix.length)) || decodeURIComponent(url.pathname)!==`/${archive.key}` ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) || !Number.isSafeInteger(archive.bytes) || archive.bytes<=0 || archive.bytes>2*1024*1024)throw new Error('Invalid private archive URL or size');
    // Reserve before attempting IO: failed/partial downloads also consume the shared cap.
    budget.archives--;budget.bytes-=archive.bytes;
    const cache=path.join(out,'cache',archive.sha256+'.zip');let bytes;
    try{bytes=await readFile(cache);if(bytes.length!==archive.bytes || hash(bytes)!==archive.sha256)bytes=null;}catch{}
    try {
      if(!bytes) {
        const response=await fetchImpl(url.href,{redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!response.ok){await response.body?.cancel();throw new Error(`Download HTTP ${response.status}`);}
        const chunks=[];let size=0;
        for await(const c of response.body){size+=c.length;if(size>archive.bytes)throw new Error('Archive download exceeds cap');chunks.push(c);}
        bytes=Buffer.concat(chunks);
      }
      if(bytes.length!==archive.bytes)throw new Error('Archive size mismatch');
      const item=readHealthArchive(bytes,archive.sha256,inv);parsed.push(item);
      await writeFile(cache,bytes,{mode:0o600});
      await new Promise(resolve=>setTimeout(resolve,250));
      receipts.push({key:archive.key,sha256:archive.sha256,bytes:bytes.length,scope:item.manifest.scope});
    }catch(error){gaps.push(`Archive ${stamp(archive.atEpochMs)} unavailable: ${error.message}`);break;}
  }
  const history=mergeHealthEvidence(inventories,parsed,{from:Date.parse(from),to:Date.parse(to)});
  delete history.nextAfter;delete history.expiresAt;history.receipts=receipts;history.gaps.push(...gaps);
  history.comparisons=await compare(history,out,options.python) ?? [];
  if(history.views.length>1 && !history.comparisons.length)history.gaps.push('Visual comparison unavailable; images remain available for review');
  const dashboard=path.join(out,'index.html'),evidence=path.join(out,'evidence.json');
  await writePrivate(dashboard,healthHistoryHtml(history));await writePrivate(evidence,history);
  return {dashboard,evidence,archives:receipts.length,images:history.views.length,settingsRevisions:history.settings.length,events:history.events.length,gaps:history.gaps,complete:history.gaps.length===0};
}

export async function saveFleetHealthHistory(options,deps={}) {
  const ids=[...new Set(options.deviceIds ?? [])];
  if(!ids.length || ids.length>25 || ids.some(id=>!/^[1-9]\d*$/.test(String(id))))throw new Error('Choose 1-25 exact camera IDs per report');
  if(!options.out)throw new Error('--out DIRECTORY is required');
  const budget={archives:60,bytes:64*1024*1024,deadline:Date.now()+600000};
  const request=deps.request ?? await healthCloudClient(options.profile ?? 'prod',{maxRequests:120});
  const cameras=[],results=[];
  for(const id of ids) {
    const out=path.join(options.out,`camera-${id}`);
    try{const result=await saveCloudHealthHistory({...options,deviceId:String(id),out},{...deps,request,budget});results.push(result);cameras.push(JSON.parse(await readFile(result.evidence,'utf8')));}
    catch(error){cameras.push({deviceId:String(id),views:[],settings:[],events:[],gaps:[error.message]});
      if(error.status===403 || error.status===401 || /rate limit/i.test(error.message))break;}
  }
  for(const id of ids)if(!cameras.some(c=>c.deviceId===String(id)))cameras.push({deviceId:String(id),views:[],settings:[],events:[],gaps:['Not checked after permission or rate-limit failure']});
  const report={from:Date.parse(options.from ?? new Date(Date.now()-7*86400000).toISOString()),to:Date.parse(options.to ?? new Date().toISOString()),cameras};
  const dashboard=path.resolve(options.out,'index.html');await writePrivate(dashboard,healthHistoryHtml(report));
  await writePrivate(path.resolve(options.out,'fleet.json'),report);
  return {dashboard,deviceIds:ids,results,complete:cameras.every(c=>!c.gaps.length),cameras:cameras.map(c=>({deviceId:c.deviceId,events:c.events.length,images:c.views.length,gaps:c.gaps}))};
}
