// Report templates for scheduled readings reports. A data source is classified as pallet-qa,
// trimsaw, bandsaw or custom from its device type and its metrics; each kind offers blocks
// (key numbers and sections) that only use metrics the selected sources actually have.
// Zira metric IDs are shared across data sources, so templates name them by ID.

export const M = {
  units: "86", status: "2693", duration: "81", event: "53315", shift: "3411",
  disposition: "57834", rule: "58310", decision: "56842", nails: "56916",
  precut: "40072", postcut: "40073", target: "48169", yieldPct: "39156", noCut: "48168", defective: "46661",
  length: "77", width: "76", area: "85", palletSize: "48735", people: "45573",
};

export const KINDS = ["pallet-qa", "trimsaw", "bandsaw", "custom"];
export const KIND_NAMES = { "pallet-qa": "Pallet QA", trimsaw: "Trimsaw", bandsaw: "Bandsaw", custom: "Custom" };

// Default alert levels; the user can change them when setting up the report.
export const DEFAULT_THRESHOLDS = { failRatePct: 8, pendingStopMin: 60, quietMin: 30, offlineMin: 1440, minUnitsForRate: 50 };

const has = (source, id) => source.metrics.some(m => m.id === id);

// Device type from vision settings wins; otherwise the metric signature decides.
export function classify(source) {
  if (KINDS.includes(source.deviceType)) return { kind: source.deviceType, by: "device type" };
  if (source.type === "Pallet Inspector" || has(source, M.disposition) || has(source, M.rule)) return { kind: "pallet-qa", by: "metrics" };
  if (has(source, M.postcut) || has(source, M.precut) || has(source, M.target)) return { kind: "trimsaw", by: "metrics" };
  if ((has(source, M.length) && has(source, M.width)) || has(source, M.palletSize)) return { kind: "bandsaw", by: "metrics" };
  return { kind: "custom", by: "metrics" };
}

const count = { metric: "*", op: "count" };
const unitsOr = all => (all.has(M.units) ? { metric: M.units, op: "sum" } : count);
const stopped = { metric: M.status, op: "=", value: "Stop" };

// Each block: id, label, default on, needs (metric IDs every block query uses), and what it adds.
// `kpi` entries carry `compare` (higher|lower is better) for the scheduled digest.
function blocks(kind, all, metrics, form = false) {
  const unit = id => metrics[id]?.unit ?? "";
  const out = [];
  const add = b => { if ((b.needs ?? []).every(id => all.has(id))) out.push(b); };
  const units = unitsOr(all);
  const noun = { "pallet-qa": "Pallets", trimsaw: "Boards", bandsaw: "Units", custom: all.has(M.units) ? "Units" : form ? "Submissions" : "Readings" }[kind];

  add({ id: "output", label: `${noun}: total and per day`, on: true,
    // More units from a saw or camera is better; more form entries or readings is only "up".
    kpis: [{ label: noun, query: { measures: [{ ...units, label: noun }] }, compare: kind === "custom" ? "neutral" : "higher", digest: "output" }],
    sections: [{ title: `${noun} per day`, chart: { query: { interval: "day", groupBy: "device", measures: [{ ...units, label: noun }] },
      option: { series: [] } }, bars: true }] });
  add({ id: "hourly", label: `${noun} per hour`, on: kind !== "custom",
    sections: [{ title: `${noun} per hour`, text: "Gaps are hours without readings.", chart: { query: { interval: "hour", groupBy: "device", measures: [{ ...units, label: noun }] } } }] });

  if (kind === "pallet-qa") {
    const fail = { metric: M.units, op: "share", where: { metric: M.disposition, op: "=", value: "Fail" } };
    add({ id: "fail-rate", label: "Fail rate (by pallets)", on: true, needs: [M.units, M.disposition],
      kpis: [{ label: "Fail rate", unit: "%", query: { measures: [{ ...fail, label: "Fail rate" }] }, compare: "lower", digest: "failRate" }],
      sections: [{ title: "Fail rate per day", text: "Share of pallets sent to repair.", chart: { query: { interval: "day", groupBy: "device", measures: [{ ...fail, label: "Fail rate (%)" }] }, option: { yAxis: { name: "%" } } } }] });
    add({ id: "fail-rules", label: "Fails by rule", on: true, needs: [M.units, M.disposition, M.rule],
      sections: [{ title: "Failed pallets by rule", chart: { query: { groupBy: M.rule, filters: [{ metric: M.disposition, op: "=", value: "Fail" }], measures: [{ metric: M.units, op: "sum", label: "Failed pallets" }], sort: { by: "Failed pallets", dir: "desc" }, limit: 8 } }, bars: true }] });
    add({ id: "fail-rules-daily", label: "Fails by rule per day", on: false, needs: [M.units, M.disposition, M.rule],
      sections: [{ title: "Failed pallets per day by rule", chart: { query: { interval: "day", groupBy: M.rule, filters: [{ metric: M.disposition, op: "=", value: "Fail" }], measures: [{ metric: M.units, op: "sum", label: "Failed pallets" }] } }, bars: true }] });
    add({ id: "nails", label: "Protruding nails per fail", on: false, needs: [M.nails, M.rule],
      sections: [{ title: "Protruding nails per nail fail", table: { query: { groupBy: M.nails, filters: [{ metric: M.rule, op: "=", value: "Protruding Nail" }], measures: [{ metric: "*", op: "count", label: "Fails" }] } } }] });
  }
  if (kind === "trimsaw") {
    add({ id: "yield", label: "Yield", on: true, needs: [M.yieldPct],
      kpis: [{ label: "Average yield", unit: "%", query: { measures: [{ metric: M.yieldPct, op: "avg", label: "Average yield" }] }, compare: "higher", digest: "yield" }],
      sections: [{ title: "Average yield per day", chart: { query: { interval: "day", groupBy: "device", measures: [{ metric: M.yieldPct, op: "avg", label: "Yield (%)" }] }, option: { yAxis: { name: "%" } } } }] });
    add({ id: "length", label: "Cut length", on: true, needs: [M.postcut],
      kpis: [{ label: "Median cut length", unit: unit(M.postcut), query: { measures: [{ metric: M.postcut, op: "median", label: "Median cut length" }] } }],
      sections: [{ title: "Cut length spread by saw", table: { query: { groupBy: "device", measures: [{ metric: M.postcut, op: "p10", label: "p10" }, { metric: M.postcut, op: "median", label: "Median" }, { metric: M.postcut, op: "p90", label: "p90" }] } } }] });
    add({ id: "target", label: "Cut length by target", on: true, needs: [M.postcut, M.target],
      sections: [{ title: "Cut length by target length", text: "Median and spread of cut boards for each target.", table: { query: { groupBy: M.target, measures: [{ metric: "*", op: "count", label: "Boards" }, { metric: M.postcut, op: "median", label: "Median cut" }, { metric: M.postcut, op: "p10", label: "p10" }, { metric: M.postcut, op: "p90", label: "p90" }], sort: { by: "Boards", dir: "desc" }, limit: 20 } } }] });
    add({ id: "no-cut", label: "No-cut share", on: false, needs: [M.noCut],
      kpis: [{ label: "No-cut boards", unit: "%", query: { measures: [{ metric: M.noCut, op: "percent", where: { op: "=", value: true }, label: "No-cut boards" }] }, compare: "lower", digest: "noCut" }] });
    add({ id: "defective", label: "Defective boards", on: false, needs: [M.defective],
      sections: [{ title: "Defective boards", table: { query: { groupBy: M.defective, measures: [{ metric: "*", op: "count", label: "Readings" }], sort: { by: "Readings", dir: "desc" }, limit: 10 } } }] });
  }
  if (kind === "bandsaw") {
    add({ id: "area", label: "Area cut", on: true, needs: [M.area],
      kpis: [{ label: "Area", unit: unit(M.area), query: { measures: [{ metric: M.area, op: "sum", label: "Area" }] }, compare: "higher", digest: "area" }] });
    add({ id: "sizes", label: "Top pallet sizes", on: true, needs: [M.palletSize],
      sections: [{ title: "Top pallet sizes", chart: { query: { groupBy: M.palletSize, measures: [{ ...units, label: noun }], sort: { by: noun, dir: "desc" }, limit: 8 } }, bars: true }] });
    add({ id: "dimensions", label: "Length and width per day", on: false, needs: [M.length, M.width],
      sections: [
        { title: `Average length per day (${unit(M.length) || "length"})`, chart: { query: { interval: "day", groupBy: "device", measures: [{ metric: M.length, op: "avg", label: "Length" }] } } },
        { title: `Average width per day (${unit(M.width) || "width"})`, chart: { query: { interval: "day", groupBy: "device", measures: [{ metric: M.width, op: "avg", label: "Width" }] } } },
      ] });
  }
  if (kind === "custom") {
    // Up to four numeric metrics as daily averages, and the first list metric as a breakdown.
    // Running totals ("Accumulated Units", counters) do not average into anything useful.
    const numeric = [...all].filter(id => metrics[id]?.dataType === "numeric" && ![M.units, M.duration].includes(id) && !/accumulat|counter|total/i.test(metrics[id].name)).slice(0, form ? 2 : 4);
    for (const id of numeric)
      add({ id: `avg-${id}`, label: `Average ${metrics[id].name}`, on: true, needs: [id],
        sections: [{ title: `Average ${metrics[id].name} per day${unit(id) ? ` (${unit(id)})` : ""}`, chart: { query: { interval: "day", groupBy: "device", measures: [{ metric: id, op: "avg", label: metrics[id].name }] } } }] });
    // Reason-like lists first (stop reasons on downtime forms), then the form's other lists.
    const lists = [...all].filter(id => metrics[id]?.dataType === "list" && ![M.status, M.event, M.shift].includes(id))
      .sort((a, b) => /reason/i.test(metrics[b].name) - /reason/i.test(metrics[a].name));
    const reason = lists.find(id => /reason/i.test(metrics[id].name));
    if (reason && all.has(M.duration))
      add({ id: `minutes-by-${reason}`, label: `Minutes by ${metrics[reason].name}`, on: true, needs: [reason, M.duration],
        sections: [{ title: `Minutes by ${metrics[reason].name}`, text: `Sum of ${metrics[M.duration].name} on entries with a ${metrics[reason].name}.`,
          chart: { query: { groupBy: reason, filters: [{ metric: reason, op: "not-empty" }], measures: [{ metric: M.duration, op: "sum", label: "Minutes" }], sort: { by: "Minutes", dir: "desc" }, limit: 8 } }, bars: true }] });
    lists.forEach((list, i) =>
      add({ id: `by-${list}`, label: `${noun} by ${metrics[list].name}`, on: i < 2, needs: [list],
        sections: [{ title: `${noun} by ${metrics[list].name}`, chart: { query: { groupBy: list, measures: [{ metric: "*", op: "count", label: noun }], sort: { by: noun, dir: "desc" }, limit: 8 } }, bars: true }] }));
  }

  // Running and stopped time, for any source reporting status with durations.
  const running = { metric: M.duration, op: "share", where: { metric: M.status, op: "!=", value: "Stop" } };
  add({ id: "uptime", label: "Running share", on: true, needs: [M.status, M.duration],
    kpis: [{ label: "Running share", unit: "%", query: { measures: [{ ...running, label: "Running share" }] }, compare: "higher", digest: "running" }],
    sections: [{ title: "Running share per day", text: "Share of reported minutes not in Stop.", chart: { query: { interval: "day", groupBy: "device", measures: [{ ...running, label: "Running (%)" }] }, option: { yAxis: { name: "%" } } } }] });
  add({ id: "stops", label: "Stop time by reason", on: true, needs: [M.status, M.duration, M.event],
    sections: [{ title: "Stop minutes by reason", text: "\"Pending Reason\" means nobody entered a reason for the stop.", chart: { query: { groupBy: M.event, filters: [stopped], measures: [{ metric: M.duration, op: "sum", label: "Stop minutes" }], sort: { by: "Stop minutes", dir: "desc" }, limit: 8 } }, bars: true }] });
  if (kind === "pallet-qa")
    add({ id: "shifts", label: "Shift comparison", on: false, needs: [M.shift, M.units, M.disposition],
      sections: [{ title: "Shifts", table: { query: { groupBy: M.shift, measures: [{ metric: M.units, op: "sum", label: "Pallets" }, { metric: M.units, op: "share", where: { metric: M.disposition, op: "=", value: "Fail" }, label: "Fail rate (%)" }] } } }] });
  else
    add({ id: "shifts", label: "Shift comparison", on: false, needs: [M.shift],
      sections: [{ title: "Shifts", table: { query: { groupBy: M.shift, measures: [{ ...units, label: noun }] } } }] });
  return out;
}

// Groups sources by kind and lists each group's available blocks, for the guided choice.
// Saws and Pallet QA cameras of one kind share a group; each custom source or form has its
// own metrics, so it gets a group of its own named after it.
export function plan(sources, kinds = {}) {
  const groups = {};
  for (const s of sources) {
    const auto = classify(s);
    const kind = kinds[s.id] ?? auto.kind;
    if (!KINDS.includes(kind)) throw new Error(`Unknown kind ${kind} for data source ${s.id}; use ${KINDS.join(", ")}`);
    const key = kind === "custom" ? `custom-${s.id}` : kind;
    (groups[key] ??= { kind, form: s.type === "form", items: [] }).items.push({ id: s.id, name: s.name, url: s.url, detected: auto.kind, by: kinds[s.id] ? "chosen" : auto.by });
  }
  const metrics = metricMap(sources);
  return Object.entries(groups).map(([key, g]) => {
    const all = commonMetrics(sources.filter(s => g.items.some(i => i.id === s.id)));
    return { key, kind: g.kind, name: g.kind === "custom" ? g.items[0].name.trim() : KIND_NAMES[g.kind], form: g.form, sources: g.items,
      blocks: blocks(g.kind, all, metrics, g.form).map(b => ({ id: b.id, label: b.label, default: b.on })) };
  });
}

function metricMap(sources) {
  const out = {};
  for (const s of sources) for (const m of s.metrics) out[m.id] ??= { name: m.name, unit: m.unit ?? null, dataType: m.dataType ?? null };
  return out;
}

// Blocks for a group use metrics that at least one of its sources has; sources without a
// metric show gaps in that block rather than hiding it for the others.
function commonMetrics(sources) {
  return new Set(sources.flatMap(s => s.metrics.map(m => m.id)));
}

// Builds a readings-report spec from saved choices:
// groups: [{ kind, deviceIds, blocks?: [id] }], metrics: { id: {name, unit, dataType} }.
export function buildSpec({ title, groups, metrics, extra = null }) {
  const spec = { title, kpis: [], sections: [] };
  const digest = [];
  const many = groups.length > 1;
  for (const g of groups) {
    const all = new Set(Object.keys(metrics).filter(id => (g.metricIds ?? Object.keys(metrics)).includes(id)));
    const chosen = blocks(g.kind, all, metrics, g.form).filter(b => (g.blocks ? g.blocks.includes(b.id) : b.on));
    const scope = q => (many ? { ...q, devices: g.deviceIds } : q);
    const prefix = many ? `${g.name ?? KIND_NAMES[g.kind]} · ` : "";
    for (const b of chosen) {
      for (const k of b.kpis ?? []) {
        if (spec.kpis.length >= 12) break;
        spec.kpis.push({ label: `${prefix}${k.label}`.slice(0, 60), unit: k.unit || undefined, query: scope(k.query) });
        if (k.compare) digest.push({ kind: g.kind, label: `${prefix}${k.label}`, unit: k.unit || null, compare: k.compare, metric: k.digest, query: scope(k.query) });
      }
      for (const s of b.sections ?? []) {
        const query = scope(s.chart?.query ?? s.table.query);
        const section = { title: `${prefix}${s.title}`, ...(s.text ? { text: s.text } : {}) };
        if (s.chart) {
          const option = { ...(s.chart.option ?? {}) };
          delete option.series;
          section.chart = { query, ...(Object.keys(option).length ? { option } : {}) };
          if (s.bars) section.chart.barSeries = true;
        } else section.table = { query, ...(s.table.maxRows ? { maxRows: s.table.maxRows } : {}) };
        spec.sections.push(section);
      }
    }
  }
  if (extra) {
    for (const k of extra.kpis ?? []) if (spec.kpis.length < 12) spec.kpis.push(k);
    spec.sections.push(...(extra.sections ?? []));
  }
  if (!spec.sections.length) throw new Error("Choose at least one section");
  return { spec, digest };
}
