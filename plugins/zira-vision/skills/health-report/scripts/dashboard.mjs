import { dataSourceUrl } from "./links.mjs";
import { statusText, statusIndicators } from "./status.mjs";
const hour = 3600000;
export const NEW_HOURS = 48;
export const KNOWN_DAYS = 14;
export const BUCKETS = {
  alerts: { label: "Current alerts", note: "Device or production issue" },
  new: { label: "Signal lost under 48h", note: "Check first" },
  recent: { label: "Signal lost 2–14 days", note: "Check next" },
  review: { label: "Verify device status", note: "Last-known warning" },
  undated: { label: "Down, age unknown", note: "No timestamp" },
  long: { label: "Down over 14 days", note: "Confirm relevance" },
  never: { label: "Never reported", note: "Placeholder?" },
  unknown: { label: "Could not check", note: "Evidence missing" },
  reporting: { label: "Reporting", note: "Data arriving; check alerts" },
};
const ORDER = Object.keys(BUCKETS);
function downSince(d) {
  return d.connectivity?.since ?? d.lastHeartbeat ?? d.lastReadingAt ?? null;
}
export function attention(report) {
  const at = Date.parse(report.assessedAt);
  const firstSeen = Object.fromEntries(
    (report.findings ?? [])
      .filter((f) => f.code === "not-reporting")
      .map((f) => [f.deviceId, f]),
  );
  const rows = (report.devices ?? []).map((d) => {
    const state = d.connectivity?.state,
      since = downSince(d),
      ms =
        since && Number.isFinite(Date.parse(since))
          ? at - Date.parse(since)
          : null,
      finding = firstSeen[d.id];
    let bucket =
      state === "reporting"
        ? "reporting"
        : state === "never-reported"
          ? "never"
          : state === "not-reporting"
            ? ms === null
              ? "undated"
              : ms < NEW_HOURS * hour || d.transition === "new"
                ? "new"
                : ms <= KNOWN_DAYS * 24 * hour
                  ? "recent"
                  : "long"
            : "unknown";
    if (bucket === "undated" && d.transition === "new") bucket = "new";
    const issues = (report.findings ?? []).filter(
      (f) => f.deviceId === d.id && f.siteId === d.siteId,
    );
    const activeAlerts = issues.filter((f) => f.check !== "connectivity");
    const statusWarnings = d.deviceStatus?.warnings ?? [];
    const needsCheck =
      ["new", "recent"].includes(bucket) || activeAlerts.length > 0;
    if (activeAlerts.length) bucket = "alerts";
    else if (bucket === "reporting" && statusWarnings.length) bucket = "review";
    return {
      bucket,
      needsCheck,
      issues,
      statusText: statusText(d.deviceStatus),
      statusFreshness: !Object.keys(d.deviceStatus?.values ?? {}).length ? "Unavailable" : d.deviceStatus.freshness === "current" ? "Current" : "Last known",
      indicators: statusIndicators(d.deviceStatus),
      statusWarnings,
      url: dataSourceUrl(report, d.id),
      id: d.id,
      name: d.name,
      siteId: d.siteId,
      siteName: d.siteName,
      profile: d.profile ?? null,
      since: state === "reporting" ? null : since,
      downHours:
        state === "not-reporting" && ms !== null
          ? Math.max(0, ms / hour)
          : null,
      // Age of the last known signal, also for sources whose state could not be decided.
      signalHours: state !== "reporting" && ms !== null ? Math.max(0, ms / hour) : null,
      firstSeen: finding?.firstSeen ?? null,
      transition: d.transition ?? null,
      reason: d.connectivity?.reason ?? "",
    };
  });
  rows.sort(
    (a, b) =>
      ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket) ||
      (a.downHours ?? Infinity) - (b.downHours ?? Infinity) ||
      String(a.siteName).localeCompare(String(b.siteName)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const counts = Object.fromEntries(ORDER.map((k) => [k, 0]));
  rows.forEach((r) => counts[r.bucket]++);
  return {
    assessedAt: report.assessedAt,
    total: rows.length,
    needsCheck: rows.filter((r) => r.needsCheck).length,
    // Last-known hardware is the norm in a status report; the footer says so, not the gap count.
    coverageGaps: (report.devices ?? []).filter((d) =>
      Object.entries(d.checks ?? {}).some(([k, c]) =>
        ["unavailable", "partial", "needs-setup"].includes(c.state) &&
        !(report.checks === "status" && k === "hardware"),
      ),
    ).length,
    counts,
    newFindings: (report.findings ?? []).filter((f) => f.change === "new")
      .length,
    recovered: (report.recovered ?? []).length,
    rows,
  };
}
// Names the report's scope for people: company and site names, falling back to the company ID.
export function scopeLabel(report) {
  const sites = [...new Set((report.devices ?? []).map((d) => d.siteName).filter(Boolean))];
  const where = sites.length === 1 ? sites[0] : sites.length > 1 ? `${sites.length} sites` : "";
  const company = report.companyName || (where ? "" : `company ${report.companyId}`);
  return [company, where].filter(Boolean).join(" · ");
}
export function ageLabel(h) {
  if (h === null || h === undefined) return "";
  return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
}
const json = (v) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
const text = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function dashboardHtml(report, { title } = {}) {
  const a = attention(report);
  const data = {
    companyId: report.companyId,
    monitorId: report.monitorId,
    assessedAt: report.assessedAt,
    inventoryComplete: report.inventoryComplete === true,
    errors: (report.errors ?? []).length,
    buckets: BUCKETS,
    ...a,
  };
  const cards = [
    ["Needs check", a.needsCheck], ["All devices", a.total],
    ...ORDER.filter((k) => a.counts[k] > 0).map((k) => [BUCKETS[k].label, a.counts[k]]),
  ].map(([label, count]) => `<div class="k"><div class="kl">${text(label)}</div><div class="kv">${count}</div></div>`).join("");
  const warning = !data.inventoryComplete || data.errors || a.coverageGaps
    ? `<div class="warnbox">Partial report: ${data.inventoryComplete ? "" : "inventory incomplete. "}${data.errors ? `${data.errors} collection errors. ` : ""}${a.coverageGaps ? `${a.coverageGaps} sources have unavailable checks or need setup.` : ""}</div>` : "";
  const rows = a.rows.map((r) => {
    const name = r.url ? `<a href="${text(r.url)}" target="_blank" rel="noopener noreferrer">${text(r.name)}</a>` : text(r.name);
    const hours = r.downHours ?? r.signalHours;
    const age = hours == null ? "—" : `${ageLabel(hours)} since ${text(r.since)}`;
    const issues = r.issues.filter((i) => i.check !== "connectivity").map((i) => `<div class="issue">${text(i.title)}</div>`).join("");
    const detail = `<details><summary>Details</summary><div>${text(r.statusText)}</div><div>${text(r.reason)}</div></details>`;
    const groups = Object.values(r.indicators).map((items) => `<td><div class="chips">${items.map((i) => `<span class="pill ${i.tone}" title="${text(i.title)}" aria-label="${text(i.title)}">${text(i.label)}</span>`).join("") || '<span class="muted">—</span>'}</div></td>`).join("");
    return `<tr><td>${text(BUCKETS[r.bucket].label)}</td><td>${text(r.siteName)}</td><td>${name} <span class="muted source-id">#${text(r.id)}</span><div class="freshness">Status: ${text(r.statusFreshness)}</div></td><td>${age}</td><td>${issues}${detail}</td>${groups}</tr>`;
  }).join("") || '<tr><td colspan="8">No devices in this report</td></tr>';
  const heading = title ?? `${report.checks === "status" ? "Device status" : "Device health"} — ${scopeLabel(report)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${text(heading)}</title>
<style>
:root{--bg:#fcfcfb;--card:#f3f2ee;--ink:#1f1e1d;--ink2:#5e5d59;--ink3:#8a8984;--line:#e5e3dc;--line2:#c9c7bf;--good:#0ca30c;--crit:#d03b3b;--serious:#ec835a;--warn:#fab219;--long:#8a8984;--never:#c9c7bf}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1a1a19;--card:#262624;--ink:#f0efea;--ink2:#b8b6ae;--ink3:#8a8984;--line:#34332f;--line2:#4a4944;--long:#8a8984;--never:#5a5954}}
:root[data-theme="dark"]{--bg:#1a1a19;--card:#262624;--ink:#f0efea;--ink2:#b8b6ae;--ink3:#8a8984;--line:#34332f;--line2:#4a4944;--long:#8a8984;--never:#5a5954}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1600px;margin:0 auto;padding:24px 16px 40px}h1{font-size:22px;font-weight:500;margin:0}
.meta{color:var(--ink2);font-size:13px;margin:4px 0 20px}.warnbox{border:1px solid var(--warn);border-radius:8px;padding:8px 12px;margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.k{background:var(--card);border:1px solid transparent;border-radius:8px;padding:12px 14px;text-align:left;font:inherit;color:inherit;cursor:pointer}
.k:hover{border-color:var(--line2)}.k[aria-pressed="true"]{border-color:var(--ink2)}
.kl{font-size:13px;color:var(--ink2);display:flex;align-items:center;gap:6px}.kv{font-size:26px;font-weight:500}.ks{font-size:12px;color:var(--ink3)}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.bar{display:flex;gap:2px;margin:18px 0 6px}.seg{height:14px;border-radius:4px;min-width:3px}
.hint{font-size:12px;color:var(--ink2);min-height:18px}
.tools{display:flex;gap:8px;align-items:center;margin:16px 0 8px}
input{flex:1;min-width:0;height:36px;border:1px solid var(--line2);border-radius:8px;background:transparent;color:var(--ink);padding:0 10px;font:inherit}
.cnt{color:var(--ink2);font-size:13px;white-space:nowrap}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px;min-width:1100px}
th{text-align:left;font-weight:500;color:var(--ink2);padding:6px 8px;border-bottom:1px solid var(--line2);position:sticky;top:0;background:var(--bg)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:hover td{background:var(--card)}
.muted{color:var(--ink3)}.st{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:4px;min-width:112px;max-width:180px}.pill{display:inline-flex;align-items:center;white-space:nowrap;font-size:11px;line-height:1.6;padding:1px 6px;border-radius:5px;background:var(--card);border:1px solid var(--line)}.pill.dim{color:var(--ink3)}.pill.review{border-color:var(--warn);color:var(--ink)}.pill.alert{border-color:var(--crit);color:var(--crit);font-weight:600}.source-id{display:block}.freshness{font-size:11px;color:var(--ink2);margin-top:3px}.issue{font-size:12px;max-width:170px}details{font-size:12px;max-width:260px}summary{cursor:pointer;color:var(--ink2)}details[open]{min-width:200px}details[open] div{margin-top:6px;color:var(--ink2)}th:nth-child(1){width:145px}th:nth-child(2){width:170px}th:nth-child(3){width:170px}th:nth-child(4){width:90px}th:nth-child(5){width:100px}th:nth-child(6){width:180px}th:nth-child(7){width:155px}th:nth-child(8){width:170px}
a{color:inherit;text-decoration:underline}footer{margin-top:14px;font-size:12px;color:var(--ink3)}
</style></head><body><main>
<h1>${text(heading)}</h1>
<div class="meta" id="meta">Snapshot ${text(data.assessedAt)} · monitor ${text(data.monitorId)} · ${a.newFindings} new findings · ${a.recovered} recovered</div>
<div id="warn">${warning}</div>
<div class="kpis" id="kpis">${cards}</div>
<div class="bar" id="bar" aria-hidden="true"></div>
<div class="hint" id="hint">All sources are shown. Open in a browser with JavaScript enabled to search and filter.</div>
<div class="tools"><input id="q" disabled type="search" placeholder="Search site or device" aria-label="Search site or device"><span class="cnt" id="cnt">${a.total} of ${a.total}</span></div>
<div class="wrap"><table><thead><tr><th>Status</th><th>Site</th><th>Device</th><th>Last signal age</th><th>Issues</th><th>Power &amp; temperature</th><th>Network</th><th>Camera &amp; errors</th></tr></thead><tbody id="tb">${rows}</tbody></table></div>
<footer>Indicators are last known unless marked Current. Amber outlines need verification; red outlines are current alerts. “—” on a network interface means disconnected, not necessarily a fault. “?” means the temperature unit was not reported. Expand Details for full status. Last signal age uses the available reporting-loss timestamp, last heartbeat or last reading. It is not a proven outage start. Sources inactive over ${KNOWN_DAYS} days may no longer be relevant, but are not automatically cleared. Device status without a fresh heartbeat is labeled last known. This snapshot does not refresh; source links open Zira when clicked.</footer>
</main>
<script type="application/json" id="data">${json(data)}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById("data").textContent);
var COL={alerts:"var(--crit)",review:"var(--warn)",new:"var(--crit)",recent:"var(--serious)",undated:"var(--warn)",long:"var(--long)",never:"var(--never)",unknown:"var(--line2)",reporting:"var(--good)"};
var CARDS=[["check","Needs check",D.needsCheck,"Current alerts + recent reporting loss"],["all","All devices",D.total,"In this report"]].concat(Object.keys(D.buckets).map(function(k){return [k,D.buckets[k].label,D.counts[k],D.buckets[k].note]}).filter(function(c){return c[2]>0||c[0]==="new"||c[0]==="reporting"}));
var f=D.needsCheck?"check":"all";
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function age(h){return h==null?"":h<48?Math.round(h)+"h":Math.round(h/24)+"d"}
document.getElementById("meta").textContent="Snapshot "+D.assessedAt.replace("T"," ").slice(0,16)+" UTC · monitor "+D.monitorId+" · "+D.newFindings+" new findings · "+D.recovered+" recovered";
document.getElementById("warn").textContent="";
if(!D.inventoryComplete||D.errors||D.coverageGaps){var w=el("div","warnbox","Partial report: "+(D.inventoryComplete?"":"inventory incomplete. ")+(D.errors?D.errors+" collection errors. ":"")+(D.coverageGaps?D.coverageGaps+" sources have unavailable checks or need setup.":""));document.getElementById("warn").appendChild(w)}
var kp=document.getElementById("kpis");kp.textContent="";
CARDS.forEach(function(c){var b=el("button","k");b.type="button";b.dataset.k=c[0];var l=el("div","kl");if(COL[c[0]]){var d=el("span","dot");d.style.background=COL[c[0]];l.appendChild(d)}l.appendChild(document.createTextNode(c[1]));b.appendChild(l);b.appendChild(el("div","kv",String(c[2])));b.appendChild(el("div","ks",c[3]));b.onclick=function(){f=c[0];draw()};kp.appendChild(b)});
document.getElementById("hint").textContent="Search applies to the selected card. Choose All devices to search the entire report.";
var bar=document.getElementById("bar"),hint=document.getElementById("hint"),h0=hint.textContent;
Object.keys(D.buckets).forEach(function(k){if(!D.counts[k])return;var s=el("div","seg");s.style.flex=D.counts[k];s.style.background=COL[k];s.onmouseenter=function(){hint.textContent=D.buckets[k].label+": "+D.counts[k]+" of "+D.total+" ("+Math.round(D.counts[k]/D.total*100)+"%)"};s.onmouseleave=function(){hint.textContent=h0};bar.appendChild(s)});
function draw(){
Array.prototype.forEach.call(kp.children,function(b){b.setAttribute("aria-pressed",String(b.dataset.k===f))});
var q=document.getElementById("q").value.trim().toLowerCase();
var rows=D.rows.filter(function(r){return (f==="all"||(f==="check"?r.needsCheck:r.bucket===f))&&(!q||(r.siteName+" "+r.name+" "+r.id).toLowerCase().indexOf(q)>=0)});
document.getElementById("cnt").textContent=rows.length+" of "+D.total;
var tb=document.getElementById("tb");tb.textContent="";
if(!rows.length){var tr=el("tr"),td=el("td","muted","No matching devices");td.colSpan=8;tr.appendChild(td);tb.appendChild(tr);return}
rows.forEach(function(r){var tr=el("tr"),s=el("td"),st=el("span","st"),d=el("span","dot");d.style.background=COL[r.bucket];st.appendChild(d);st.appendChild(document.createTextNode(D.buckets[r.bucket].label));s.appendChild(st);tr.appendChild(s);
tr.appendChild(el("td",null,r.siteName));var n=el("td");var link=el(r.url?"a":"span",null,r.name+" ");if(r.url){link.href=r.url;link.target="_blank";link.rel="noopener noreferrer"}n.appendChild(link);n.appendChild(el("span","muted source-id","#"+r.id));n.appendChild(el("div","freshness","Status: "+r.statusFreshness));tr.appendChild(n);
var a=el("td"),hrs=r.downHours!=null?r.downHours:r.signalHours;if(hrs!=null){a.appendChild(document.createTextNode(age(hrs)+" "));a.appendChild(el("span","muted","since "+r.since.slice(0,10)))}else a.appendChild(el("span","muted",r.since===null?"—":"no timestamp"));tr.appendChild(a);
var detail=el("td");r.issues.filter(function(i){return i.check!=="connectivity"}).forEach(function(i){detail.appendChild(el("div","issue",i.title))});var full=el("details");full.appendChild(el("summary",null,"Details"));full.appendChild(el("div",null,r.statusText));full.appendChild(el("div",null,r.reason+(r.transition?" · "+r.transition:"")));detail.appendChild(full);tr.appendChild(detail);
Object.keys(r.indicators).forEach(function(key){var cell=el("td"),chips=el("div","chips");r.indicators[key].forEach(function(i){var pill=el("span","pill "+i.tone,i.label);pill.title=i.title;pill.setAttribute("aria-label",i.title);chips.appendChild(pill)});if(!chips.children.length)chips.appendChild(el("span","muted","—"));cell.appendChild(chips);tr.appendChild(cell)});tb.appendChild(tr)})}
document.getElementById("q").oninput=draw;draw();document.getElementById("q").disabled=false;
})();
</script></body></html>
`;
}
