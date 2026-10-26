"""Self-contained HTML view of a model evaluation: summary, per-class table and an image gallery
with ground truth and predictions drawn. Everything is embedded (no network); boxes (coloured by
class, with the camera's confidence on device labels when known) and the worst-first order are
rendered as static HTML, and a browser adds filters, colouring by outcome instead, a confidence
and match IoU for each class that re-score live (kept in the page address), and enlarged views."""

from __future__ import annotations

import base64
import hashlib
import html
import io
import json
from pathlib import Path

from PIL import Image

MAX_SIDE = 640          # embedded image size; Zira slices are usually smaller
MAX_IMAGES = 400        # worst first; the rest are counted, not embedded
# Box colour per class id (border, label text), saturated enough to read on wood; repeats past ten.
CLASS_COLORS = [("#2f7cf6", "#fff"), ("#e535d8", "#fff"), ("#00b8d4", "#000"), ("#ffd21f", "#000"), ("#8a5cf6", "#fff"),
                ("#ff5c8a", "#000"), ("#7ed321", "#000"), ("#ff8c1a", "#000"), ("#14b8a6", "#000"), ("#f8fafc", "#000")]
OUTCOME_MARKS = {"ok": "✓ ", "miss": "✗ ", "extra": "+ "}


def _thumb(path: Path) -> str:
    with Image.open(path) as opened:
        image = opened.convert("RGB")
        image.thumbnail((MAX_SIDE, MAX_SIDE))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=82)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def _pct(v: float) -> str:
    return f"{max(0.0, min(100.0, v * 100)):.2f}%"


def _color(class_id: int) -> tuple[str, str]:
    return CLASS_COLORS[class_id % len(CLASS_COLORS)]


def _box(b: dict, kind: str, outcome: str, name: str, score: float | None, model_score: float | None = None) -> str:
    """A box with its class and confidence as separate parts, so the page can show either or both.

    kind `t` is a label (the camera's confidence on a device label, when known), `p` a prediction
    (the model's), and `a` a label and prediction that agree, drawn once with both scores."""
    color, text = _color(b["classId"])
    style = (f"left:{_pct(b['x'] - b['w'] / 2)};top:{_pct(b['y'] - b['h'] / 2)};"
             f"width:{_pct(b['w'])};height:{_pct(b['h'])};--c:{color};--ct:{text}")
    shown = f'<em class="s st"> {score:.2f}</em>' if score is not None else ""
    if model_score is not None:
        separator = '<em class="sep"> |</em>' if shown else ""
        shown += f'{separator}<em class="s sp"> {model_score:.2f}</em>'
    mark = OUTCOME_MARKS[outcome] if kind == "a" or outcome != "ok" else ""
    return (f'<div class="b {kind} {outcome}" style="{style}"><span><i>{mark}</i>'
            f'<em class="n">{html.escape(name)}</em>{shown}</span></div>')


def _fmt(v) -> str:
    return "—" if v is None else f"{v:.2f}"


def render(report: dict, dataset_root: Path) -> str:
    names = report["dataset"]["classNames"]
    mapping = report.get("classMapping", {})
    model_names = mapping.get("modelNames") or names
    comparable = mapping.get("comparable") or [True] * len(names)
    images = report.get("images", [])
    shown = images[:MAX_IMAGES]
    data, cards = [], []
    for index, item in enumerate(shown):
        src = _thumb(dataset_root / item["image"])
        pair = {m["truth"]: m["prediction"] for m in item["matches"]}
        predictions = item["predictions"]
        # Ids match, but a mismatched model may call the same id something else; then both names show.
        agreed = lambda c: names[c] if c >= len(model_names) or model_names[c] == names[c] else f"{names[c]} / {model_names[c]}"
        # A matched label and prediction are one agreed box (the label's place, both scores).
        boxes = [_box(t, "a", "ok", agreed(t["classId"]), t.get("deviceScore"), predictions[pair[i]]["score"]) if i in pair
                 else _box(t, "t", "miss", names[t["classId"]], t.get("deviceScore"))
                 for i, t in enumerate(item["truth"])]
        matched_p = set(pair.values())
        boxes += [_box(p, "p", "extra", str(model_names[p["classId"]] if p["classId"] < len(model_names) else p["classId"]),
                       None, p["score"]) for i, p in enumerate(predictions) if i not in matched_p]
        title = html.escape(item["image"])
        cards.append(
            f'<figure class="card" id="i{index}" data-i="{index}"><div class="frame"><img src="{src}" alt="{title}">'
            f'{"".join(boxes)}</div><figcaption><span class="name" title="{title}">{html.escape(Path(item["image"]).name)}</span>'
            f'<span class="counts"><b class="ok">{item["tp"]} correct</b> <b class="miss">{item["fn"]} missed</b> '
            f'<b class="extra">{item["fp"]} extra</b></span></figcaption></figure>')
        data.append({"src": src, "name": item["image"],
                     "t": [[b["classId"], b["x"], b["y"], b["w"], b["h"], b.get("deviceScore")] for b in item["truth"]],
                     "p": [[b["classId"], b["x"], b["y"], b["w"], b["h"], round(b["score"], 4)] for b in item["predictions"]]})

    s = report["summary"]
    settings = report.get("settings", {})
    # Each class has its own thresholds; the run's are the starting point and the browser adjusts them.
    thresholds = f'<td class="th">{settings.get("confidence", 0.25)}</td><td class="th">{settings.get("matchIou", 0.5)}</td>'
    swatch = lambda i: f'<i class="sw" style="--c:{_color(i)[0]}"></i>'
    def row(c: dict) -> str:
        ok = comparable[c["classId"]]
        name = f'{swatch(c["classId"])}{html.escape(c["name"])}'
        if not ok:  # the model predicts something else in this slot; its numbers would mislead
            other = html.escape(str(c.get("modelClass") or "no such class"))
            return (f'<tr class="nc"><td>{name}</td>{thresholds}<td colspan="6">not comparable: the model has '
                    f'<b>{other}</b> here, so these labels can only be missed</td></tr>')
        return (f'<tr><td>{name}</td>{thresholds}'
                f'<td>{_fmt(c["precision"])}</td><td>{_fmt(c["recall"])}</td><td>{_fmt(c["f1"])}</td>'
                f'<td>{c["tp"]}</td><td>{c["fp"]}</td><td>{c["fn"]}</td></tr>')
    rows = "".join(row(c) for c in report["classes"])
    pre = report.get("preprocessing", {})
    model = report.get("model", {})
    warning = mapping.get("warning") if mapping.get("mismatch") else None
    hidden = len(images) - len(shown)
    # A predicted class beyond the dataset's names still gets a colour by its id.
    colors = [_color(i) for i in range(max(len(names), len(model_names)))]
    class_legend = "".join(f'<span>{swatch(i)}{html.escape(n)}</span>' for i, n in enumerate(names))
    payload = json.dumps({"names": names, "modelNames": model_names, "comparable": comparable, "colors": colors,
                          "matchIou": settings.get("matchIou", 0.5), "confidence": settings.get("confidence", 0.25),
                          "images": data}, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    # The version as the user knows it (the ZIP name), not the unpacked cache folder.
    source = Path(str(report.get("request", {}).get("dataset") or report["dataset"]["path"]))
    version = source.stem if source.suffix.lower() == ".zip" else source.name
    title = f"{model.get('name', 'Model')} on {version}"
    return TEMPLATE.format(
        csp=CSP,
        title=html.escape(title), model=html.escape(str(model.get("name", ""))),
        dataset=html.escape(version), split=html.escape(str(report["dataset"]["split"])),
        images=s["images"], precision=_fmt(s["precision"]), recall=_fmt(s["recall"]), f1=_fmt(s["f1"]),
        tp=s["tp"], fp=s["fp"], fn=s["fn"], rows=rows, class_legend=class_legend,
        warning=f'<p class="warn">{html.escape(warning)}</p>' if warning else "",
        reference=_reference(report.get("reference")),
        confusions=_confusions(report.get("confusions", [])),
        partial='<p class="warn">This run was cancelled; only part of the images were evaluated.</p>' if not report.get("complete") else "",
        hidden=f'<p class="note">{hidden} more images without errors are in the JSON report.</p>' if hidden else "",
        conf=settings.get("confidence", 0.25), match=settings.get("matchIou", 0.5),
        resize=html.escape(str(pre.get("resize", "?"))), size=html.escape("×".join(map(str, pre.get("size", []))) or "?"),
        ms=_fmt(report.get("timing", {}).get("model", {}).get("meanMs")),
        cards="".join(cards), payload=payload)


def _confusions(rows: list[dict]) -> str:
    """Labels the model found at the right place but named as another class."""
    if not rows:
        return ""
    cells = "".join(f'<tr><td>{html.escape(r["labelClass"])}</td><td>{html.escape(r["predictedClass"])}</td><td>{r["count"]}</td></tr>' for r in rows)
    return ('<h2 class="sec">Found but named wrong</h2><p class="note">Labeled objects the model found at the same place under '
            "another class (at the run&#39;s thresholds). Each is also counted as a miss and an extra above.</p>"
            f'<div class="tw"><table><thead><tr><th>Labeled as</th><th>Model said</th><th>Times</th></tr></thead><tbody>{cells}</tbody></table></div>')


def _reference(ref: dict | None) -> str:
    """Session-built datasets: say where the labels came from, with results per source."""
    if not ref:
        return ""
    names = {"annotations": "reviewer-corrected", "device": "device output (unverified)"}
    parts = []
    for source, rates in ref.get("summaryBySource", {}).items():
        count = ref.get("labelSources", {}).get(source, 0)
        parts.append(f'<b>{html.escape(names.get(source, source))}</b>: {count} images, precision {_fmt(rates.get("precision"))}, '
                     f'recall {_fmt(rates.get("recall"))}')
    sessions = ", ".join(ref.get("sessions", [])[:6]) + (" …" if len(ref.get("sessions", [])) > 6 else "")
    scored = ref.get("deviceScores") or {}
    cam = ""
    if scored.get("deviceLabels"):
        known, total = scored.get("labels", 0), scored["deviceLabels"]
        cam = (f' Camera confidence is known for {known} of {total} device labels (the score on a solid label box)'
               + ("; the others have no score in their inspection record." if known < total else "."))
    return (f'<p class="warn">QA sessions {html.escape(sessions)}. {html.escape(ref.get("note", ""))}</p>'
            f'<p class="note">{" · ".join(parts)} (at the run\'s thresholds).{html.escape(cam)}</p>')


def write(report: dict, dataset_root: Path, out: Path) -> Path:
    text = render(report, dataset_root)
    temporary = out.with_name(out.name + ".partial")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(out)
    return out


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#1f9d55;--miss:#d93636;--extra:#e8890c}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151514;--fg:#ecebe6;--muted:#a3a29b;--card:#1f1f1d;--line:#34332f}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:1280px;margin:0 auto;padding:20px 16px 48px}}h1{{font-size:20px;margin:0 0 4px}}.sub{{color:var(--muted);margin:0 0 16px}}
.kpis{{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 16px}}.kpi{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:110px}}
.kpi b{{display:block;font-size:22px}}.kpi span{{color:var(--muted);font-size:12px}}
.warn{{background:color-mix(in srgb,var(--extra) 14%,var(--card));border:1px solid var(--extra);border-radius:8px;padding:8px 12px}}
.note{{color:var(--muted)}}.tw{{overflow-x:auto;margin:0 0 6px}}table{{border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;min-width:min(100%,560px)}}
th,td{{padding:6px 12px;text-align:right;border-bottom:1px solid var(--line)}}th:first-child,td:first-child{{text-align:left}}tr.nc{{color:var(--muted)}}tr.nc td[colspan]{{text-align:left}}
.th{{white-space:nowrap;text-align:left}}td.th input{{width:72px;vertical-align:middle;margin:0 6px 0 0}}td.th output{{display:inline-block;min-width:2.4em;font-variant-numeric:tabular-nums}}
td.th.changed output{{font-weight:700;color:var(--fg)}}#thnote{{margin:0 0 18px;font-size:12px}}
.legend{{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);margin:6px 0 12px}}.legend i{{display:inline-block;width:12px;height:12px;border:2px solid;margin-right:5px;vertical-align:-1px}}
.controls{{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 14px}}.controls[hidden]{{display:none}}
.controls button,.controls select{{font:inherit;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}}
.controls button[aria-pressed=true]{{border-color:var(--fg)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}}
.card{{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:zoom-in}}
.frame{{position:relative;line-height:0}}.frame img{{width:100%;height:auto;display:block}}
.b{{position:absolute;border:2px solid var(--c);line-height:1.2}}.b.p{{border-style:dashed}}.b.t.miss{{border-width:3px}}
.b span{{position:absolute;left:-2px;bottom:100%;font-size:10px;padding:0 3px;background:var(--c);color:var(--ct);white-space:nowrap}}.b.p span{{top:100%;bottom:auto}}
.b span i{{font-style:normal;font-weight:700}}.b span em{{font-style:normal}}.by-outcome .b:not(.a) span i{{display:none}}
.by-outcome .b.ok{{border-color:var(--ok)}}.by-outcome .b.miss{{border-color:var(--miss)}}.by-outcome .b.extra{{border-color:var(--extra)}}
.by-outcome .b span{{color:#fff}}.by-outcome .b.ok span{{background:var(--ok)}}.by-outcome .b.miss span{{background:var(--miss)}}.by-outcome .b.extra span{{background:var(--extra)}}
.sw{{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--c);margin-right:6px}}
.legend .sw{{border:0;width:12px;height:12px}}.by-outcome .legend.lc,body:not(.by-outcome) .legend.lo{{display:none}}
.hide-labels .b .n,.hide-scores .b .s,.hide-scores .b .sep,.hide-labels.hide-scores .b span,.hide-labels .b span:not(:has(.s)){{display:none}}
.hide-t .b.t,.hide-p .b.p,.hide-t.hide-p .b.a,.hide-t .b.a .st,.hide-p .b.a .sp,.hide-t .b.a .sep,.hide-p .b.a .sep{{display:none}}
figcaption{{padding:8px 10px;display:flex;flex-direction:column;gap:2px}}.name{{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted)}}
.counts b{{font-weight:600;font-size:12px;margin-right:6px}}.counts .ok{{color:var(--ok)}}.counts .miss{{color:var(--miss)}}.counts .extra{{color:var(--extra)}}
dialog{{border:0;border-radius:12px;padding:0;background:var(--card);color:var(--fg);max-width:min(96vw,1100px)}}dialog::backdrop{{background:#000a}}
dialog .frame img{{width:min(92vw,1000px)}}dialog .b span{{font-size:12px}}dialog p{{margin:8px 12px}}
footer{{color:var(--muted);font-size:12px;margin-top:24px}}.sec{{font-size:15px;margin:18px 0 4px}}
</style></head><body><main>
<h1>{model}</h1>
<p class="sub">Dataset version <b>{dataset}</b> · {split} split · {images} images · run on this computer, nothing was uploaded</p>
{partial}{warning}{reference}
<div class="kpis"><div class="kpi"><b id="kp">{precision}</b><span>precision</span></div><div class="kpi"><b id="kr">{recall}</b><span>recall</span></div>
<div class="kpi"><b id="kf">{f1}</b><span>F1</span></div><div class="kpi"><b id="kc">{tp} / {fp} / {fn}</b><span>correct / extra / missed</span></div></div>
<div class="tw"><table><thead><tr><th>Class</th><th class="th">Confidence ≥</th><th class="th">Match IoU ≥</th><th>Precision</th><th>Recall</th><th>F1</th><th>Correct</th><th>Extra</th><th>Missed</th></tr></thead>
<tbody id="rows">{rows}</tbody></table></div>
{confusions}
<p class="note" id="thnote" hidden>Each class has its own confidence and match IoU: change them in the table and the numbers and images re-score.
The run kept predictions from {conf}, so that is the lowest confidence; the address of this page keeps your choice.</p>
<div class="legend lc">{class_legend}<span>✓ label and prediction agree, one box (camera | model confidence) · ✗ missed label (solid, camera confidence) · + extra prediction (dashed, model confidence)</span></div>
<div class="legend lo"><span><i style="border-color:var(--ok)"></i>✓ correct, one box for label and prediction</span><span><i style="border-color:var(--miss)"></i>missed label</span>
<span><i style="border-color:var(--extra);border-style:dashed"></i>extra prediction</span><span>solid = label · dashed = prediction</span></div>
<div class="controls" id="controls" hidden>
<button data-f="errors" aria-pressed="true">With errors</button><button data-f="miss" aria-pressed="false">Misses</button>
<button data-f="extra" aria-pressed="false">Extras</button><button data-f="all" aria-pressed="false">All</button>
<select id="cls"><option value="">All classes</option></select>
<label>Colour by <select id="colorby"><option value="class">class</option><option value="outcome">outcome</option></select></label>
<label>Every class: confidence ≥ <input type="range" id="conf" min="{conf}" max="0.95" step="0.05" value="{conf}"> <b id="confv">{conf}</b></label>
<label>match IoU ≥ <input type="range" id="miou" min="0.05" max="0.95" step="0.05" value="{match}"> <b id="miouv">{match}</b></label>
<button type="button" id="reset">Reset</button>
<label><input type="checkbox" id="labels" checked> Labels</label><label><input type="checkbox" id="scores" checked> Confidence</label>
<label><input type="checkbox" id="showt" checked> Ground truth</label>
<label><input type="checkbox" id="showp" checked> Predictions</label><span id="shown" class="note"></span></div>
<section class="grid" id="grid">{cards}</section>{hidden}
<dialog id="zoom"></dialog>
<footer>Matching: same class, IoU ≥ that class's match IoU (run default {match}). Preprocessing: {resize} to {size}. Mean model time {ms} ms on this computer (not device latency).</footer>
</main>
<script id="data" type="application/json">{payload}</script>
<script>
(() => {{
  const D = JSON.parse(document.getElementById("data").textContent), grid = document.getElementById("grid");
  const ctl = document.getElementById("controls"); ctl.hidden = false;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}})[c]);
  const iou = (a, b) => {{ const ix = Math.max(0, Math.min(a[1]+a[3]/2, b[1]+b[3]/2) - Math.max(a[1]-a[3]/2, b[1]-b[3]/2));
    const iy = Math.max(0, Math.min(a[2]+a[4]/2, b[2]+b[4]/2) - Math.max(a[2]-a[4]/2, b[2]-b[4]/2)); const i = ix*iy, u = a[3]*a[4] + b[3]*b[4] - i; return u > 0 ? i/u : 0; }};
  // Thresholds per class id: the run's values to start, or the ones kept in the page address.
  const N = D.names.length, C0 = D.confidence, M0 = D.matchIou;
  const conf = D.names.map(() => C0), miou = D.names.map(() => M0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let colorBy = "class";
  const readAddress = () => {{
    conf.fill(C0); miou.fill(M0); colorBy = "class";
    try {{
      const h = new URLSearchParams(location.hash.slice(1));
      const load = (key, into, lo) => (h.get(key) || "").split(",").forEach((v, i) => {{ if (i < N && v !== "" && Number.isFinite(+v)) into[i] = clamp(+v, lo, 0.95); }});
      load("conf", conf, C0); load("iou", miou, 0.05);
      if (h.get("color") === "outcome") colorBy = "outcome";
    }} catch (e) {{}}
  }};
  readAddress();
  const score = img => {{
    const preds = img.p.filter(p => p[5] >= (conf[p[0]] ?? C0)), pairs = [];
    img.t.forEach((t, ti) => preds.forEach((p, pi) => {{ if (t[0] === p[0]) {{ const v = iou(t, p); if (v >= miou[t[0]]) pairs.push([v, ti, pi]); }} }}));
    pairs.sort((a, b) => b[0] - a[0]); const mt = new Set(), mp = new Set(), pair = new Map();
    for (const [, ti, pi] of pairs) if (!mt.has(ti) && !mp.has(pi)) {{ mt.add(ti); mp.add(pi); pair.set(ti, pi); }}
    return {{ preds, mt, mp, pair }};
  }};
  const pct = v => Math.max(0, Math.min(100, v * 100)).toFixed(2) + "%";
  const MARK = {{ ok: "✓ ", miss: "✗ ", extra: "+ " }}, color = c => D.colors[c % D.colors.length] || D.colors[0];
  // Class name and confidence are separate parts so the Labels and Confidence switches work apart. Kind t is a
  // label, p a prediction, a an agreed pair drawn once with both scores (the label's, then the model's).
  const box = (b, kind, out, name, s, ms) => {{
    const st = s == null ? "" : `<em class="s st"> ${{s.toFixed(2)}}</em>`;
    const sp = ms == null ? "" : `${{st ? '<em class="sep"> |</em>' : ""}}<em class="s sp"> ${{ms.toFixed(2)}}</em>`;
    return `<div class="b ${{kind}} ${{out}}" style="left:${{pct(b[1]-b[3]/2)}};top:${{pct(b[2]-b[4]/2)}};width:${{pct(b[3])}};height:${{pct(b[4])}};--c:${{color(b[0])[0]}};--ct:${{color(b[0])[1]}}">` +
      `<span><i>${{kind === "a" || out !== "ok" ? MARK[out] : ""}}</i><em class="n">${{esc(name)}}</em>${{st}}${{sp}}</span></div>`;
  }};
  const agreed = c => D.modelNames[c] == null || D.modelNames[c] === D.names[c] ? D.names[c] : `${{D.names[c]}} / ${{D.modelNames[c]}}`;
  const draw = (img, r) => img.t.map((t, i) => r.pair.has(i) ? box(t, "a", "ok", agreed(t[0]), t[5], r.preds[r.pair.get(i)][5])
      : box(t, "t", "miss", D.names[t[0]], t[5])).join("") +
    r.preds.map((p, i) => r.mp.has(i) ? "" : box(p, "p", "extra", D.modelNames[p[0]] ?? p[0], null, p[5])).join("");
  const colorSel = document.getElementById("colorby");
  const sel = document.getElementById("cls"); D.names.forEach((n, i) => sel.insertAdjacentHTML("beforeend", `<option value="${{i}}">${{esc(n)}}</option>`));
  let filter = "errors";
  const f2 = v => v == null ? "—" : v.toFixed(2);
  // The class table is built once with a confidence and match IoU slider per class; render() fills its numbers.
  const rows = document.getElementById("rows");
  const slider = (kind, i, min, step, what) => `<input type="range" class="${{kind}}" data-c="${{i}}" min="${{min}}" max="0.95" step="${{step}}" aria-label="${{esc(D.names[i])}} ${{what}}"><output></output>`;
  rows.innerHTML = D.names.map((n, i) => `<tr${{D.comparable[i] ? "" : ' class="nc"'}}><td><i class="sw" style="--c:${{color(i)[0]}}"></i>${{esc(n)}}</td>` +
    `<td class="th">${{slider("rc", i, C0, 0.01, "confidence")}}</td><td class="th">${{slider("rm", i, 0.05, 0.05, "match IoU")}}</td>` +
    (D.comparable[i] ? "<td></td>".repeat(6) : `<td colspan="6">not comparable: the model has <b>${{esc(D.modelNames[i] ?? "no such class")}}</b> here, so these labels can only be missed</td>`) + "</tr>").join("");
  const rc = [...rows.querySelectorAll(".rc")], rm = [...rows.querySelectorAll(".rm")];
  const setSliders = () => {{ rc.forEach((s, i) => s.value = conf[i]); rm.forEach((s, i) => s.value = miou[i]); }};
  setSliders();
  document.getElementById("thnote").hidden = false;
  const same = (a, d) => a.every(v => Math.abs(v - d) < 1e-9);
  function syncThresholds() {{
    const show = (sliders, values, d) => sliders.forEach((s, i) => {{ s.nextElementSibling.textContent = values[i].toFixed(2); s.parentElement.classList.toggle("changed", Math.abs(values[i] - d) > 1e-9); }});
    show(rc, conf, C0); show(rm, miou, M0);
    const every = (id, values) => {{ const one = same(values, values[0]); if (one) document.getElementById(id).value = values[0];
      document.getElementById(id + "v").textContent = one ? values[0].toFixed(2) : "per class"; }};
    every("conf", conf); every("miou", miou);
    document.body.classList.toggle("by-outcome", colorBy === "outcome"); colorSel.value = colorBy;
    const hash = [same(conf, C0) ? "" : "conf=" + conf.map(v => +v.toFixed(2)).join(","),
                  same(miou, M0) ? "" : "iou=" + miou.map(v => +v.toFixed(2)).join(","),
                  colorBy === "class" ? "" : "color=" + colorBy].filter(Boolean).join("&");
    try {{ history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search); }} catch (e) {{}}
  }}
  function render() {{
    const cls = sel.value === "" ? null : +sel.value;
    syncThresholds();
    const st = D.names.map(() => [0, 0, 0]); const cards = [];
    D.images.forEach((img, i) => {{
      const r = score(img); let tp = 0, fp = 0, fn = 0, touches = cls === null;
      img.t.forEach((t, ti) => {{ st[t[0]][r.mt.has(ti) ? 0 : 2]++; if (r.mt.has(ti)) tp++; else fn++; if (t[0] === cls) touches = true; }});
      r.preds.forEach((p, pi) => {{ if (!r.mp.has(pi)) {{ st[p[0]] && st[p[0]][1]++; fp++; }} if (p[0] === cls) touches = true; }});
      cards.push({{ i, img, r, tp, fp, fn, touches }});
    }});
    const keep = c => c.touches && (filter === "all" || (filter === "errors" && c.fp + c.fn > 0) || (filter === "miss" && c.fn > 0) || (filter === "extra" && c.fp > 0));
    const shown = cards.filter(keep).sort((a, b) => (b.fp + b.fn) - (a.fp + a.fn) || a.img.name.localeCompare(b.img.name));
    grid.innerHTML = shown.map(c => `<figure class="card" data-i="${{c.i}}"><div class="frame"><img src="${{c.img.src}}" alt="${{esc(c.img.name)}}">${{draw(c.img, c.r)}}</div>` +
      `<figcaption><span class="name" title="${{esc(c.img.name)}}">${{esc(c.img.name.split("/").pop())}}</span><span class="counts"><b class="ok">${{c.tp}} correct</b> <b class="miss">${{c.fn}} missed</b> <b class="extra">${{c.fp}} extra</b></span></figcaption></figure>`).join("")
      || '<p class="note">No images match this filter.</p>';
    document.getElementById("shown").textContent = `${{shown.length}} of ${{cards.length}} images`;
    let T = [0, 0, 0];
    [...rows.rows].forEach((tr, i) => {{
      const [tp, fp, fn] = st[i]; if (!D.comparable[i]) return; T = [T[0] + tp, T[1] + fp, T[2] + fn];
      const p = tp + fp ? tp / (tp + fp) : null, r = tp + fn ? tp / (tp + fn) : null, f = p != null && r != null ? (p + r ? 2 * p * r / (p + r) : 0) : null;
      [f2(p), f2(r), f2(f), tp, fp, fn].forEach((v, k) => tr.cells[3 + k].textContent = v);
    }});
    const P = T[0] + T[1] ? T[0] / (T[0] + T[1]) : null, R = T[0] + T[2] ? T[0] / (T[0] + T[2]) : null;
    document.getElementById("kp").textContent = f2(P); document.getElementById("kr").textContent = f2(R);
    document.getElementById("kf").textContent = f2(P != null && R != null ? (P + R ? 2 * P * R / (P + R) : 0) : null);
    document.getElementById("kc").textContent = `${{T[0]}} / ${{T[1]}} / ${{T[2]}}`;
  }}
  ctl.addEventListener("click", e => {{ const b = e.target.closest("button[data-f]"); if (!b) return; filter = b.dataset.f;
    ctl.querySelectorAll("button[data-f]").forEach(x => x.setAttribute("aria-pressed", x === b)); render(); }});
  sel.addEventListener("input", render);
  colorSel.addEventListener("input", () => {{ colorBy = colorSel.value === "outcome" ? "outcome" : "class"; render(); }});
  rows.addEventListener("input", e => {{ const s = e.target, i = +s.dataset.c; if (!s.matches(".rc,.rm")) return;
    (s.matches(".rc") ? conf : miou)[i] = +s.value; render(); }});
  const setAll = (values, v) => {{ values.fill(v); setSliders(); render(); }};
  document.getElementById("conf").addEventListener("input", e => setAll(conf, +e.target.value));
  document.getElementById("miou").addEventListener("input", e => setAll(miou, +e.target.value));
  document.getElementById("reset").addEventListener("click", () => {{ conf.fill(C0); setAll(miou, M0); }});
  window.addEventListener("hashchange", () => {{ readAddress(); setSliders(); render(); }});  // a pasted link in an open page
  const toggle = (id, cls, on) => document.getElementById(id).addEventListener("change", e => document.body.classList.toggle(cls, e.target.checked !== on));
  toggle("labels", "hide-labels", true); toggle("scores", "hide-scores", true);
  toggle("showt", "hide-t", true); toggle("showp", "hide-p", true);
  const zoom = document.getElementById("zoom");
  grid.addEventListener("click", e => {{ const card = e.target.closest(".card"); if (!card) return;
    zoom.innerHTML = card.querySelector(".frame").outerHTML + `<p>${{esc(D.images[card.dataset.i].name)}} · click outside to close</p>`; zoom.showModal(); }});
  zoom.addEventListener("click", e => {{ if (e.target === zoom) zoom.close(); }});
  render();
}})();
</script></body></html>
"""

# Hash only the trusted template script, never scripts parsed out of rendered customer data.
# Inline styles position the static/dynamic detection boxes; no inline script handlers are allowed.
_SCRIPT = TEMPLATE.split("<script>", 1)[1].split("</script>", 1)[0].format()
_SCRIPT_HASH = base64.b64encode(hashlib.sha256(_SCRIPT.encode("utf-8")).digest()).decode("ascii")
CSP = ("default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; "
       "connect-src 'none'; img-src data:; style-src 'unsafe-inline'; "
       f"script-src 'sha256-{_SCRIPT_HASH}'; script-src-attr 'none'")
