// Compare original bucket assignments, independent of report relabel merges.
// Counts are camera classifications, not independently verified production intent.
export const MAX_NEIGHBOR_PAIRS = 8;
const cutId = i => String(912000 + 2 * i);
const uncutId = i => String(912001 + 2 * i);
const name = n => String(n);

export function neighboringStops(rows, { from, to, maxPairs = MAX_NEIGHBOR_PAIRS }) {
  const counts = new Map();
  for (const r of rows) {
    if (r.t < from || r.t >= to || !(r.target > 0) || !(r.units > 0)) continue;
    counts.set(r.target, (counts.get(r.target) ?? 0) + r.units);
  }
  const sizes = [...counts.keys()].sort((a, b) => a - b), all = [];
  for (let i = 0; i < sizes.length; i++) for (let j = i + 1; j < sizes.length; j++) {
    const gap = sizes[j] - sizes[i];
    if (Math.abs(gap - 0.5) < 1e-6 || Math.abs(gap - 1) < 1e-6)
      all.push({ stops: [sizes[i], sizes[j]], boards: counts.get(sizes[i]) + counts.get(sizes[j]) });
  }
  all.sort((a, b) => b.boards - a.boards || a.stops[0] - b.stops[0]);
  const pairs = all.slice(0, maxPairs);
  const labels = [...new Set(pairs.flatMap(p => p.stops))].sort((a, b) => a - b)
    .map((stop, i) => ({ stop, cutId: cutId(i), uncutId: uncutId(i) }));
  return { pairs, labels, omitted: all.length - pairs.length };
}

export function deriveNeighborColumns(device, rows, neighbors, { from, to }) {
  const metrics = [];
  for (const l of neighbors.labels) {
    device.cols[l.cutId] = new Array(device.t.length).fill(null);
    device.cols[l.uncutId] = new Array(device.t.length).fill(null);
    for (const r of rows) {
      if (r.t < from || r.t >= to) continue;
      device.cols[l.cutId][r.i] = r.target === l.stop && !r.noCut ? r.units : 0;
      device.cols[l.uncutId][r.i] = r.target === l.stop && r.noCut ? r.units : 0;
    }
    metrics.push(...[[l.cutId, "Recorded cut"], [l.uncutId, "Recorded uncut"]].map(([id, state]) =>
      ({ id, name: `${name(l.stop)} · ${state}`, unit: null, dataType: "numeric", present: true })));
  }
  return metrics;
}

export function neighborSections(neighbors, { target, units, avgPost, outcome, avgPostName, unit }) {
  const sections = [];
  if (!neighbors.pairs.length) return sections;
  sections.push({ title: "Nearby stops: bucket assignment is not production intent",
    text: "Pairs 0.5 or 1 length unit apart use original stop labels, even when the rest of the report merges relabels. Select the same From/To window for the timeline and distributions. A few boards assigned to the neighboring bucket with similar measured lengths suggest possible assignment spillover, not proof. Confirm the active physical stop with an operator, production log or video. Sparse samples, short runs and sequential relabels can look similar."
      + (neighbors.omitted ? ` Showing the ${neighbors.pairs.length} busiest pairs; ${neighbors.omitted} additional pairs omitted. Narrow the time window and rebuild to inspect other activity.` : "") });
  for (const pair of neighbors.pairs) {
    const labels = pair.stops.map(s => neighbors.labels.find(l => l.stop === s));
    const title = pair.stops.join(" / ");
    const filters = [{ metric: target, op: "in", value: pair.stops }, { metric: units, op: ">", value: 0 }];
    const cols = labels.flatMap(l => [
      { id: l.cutId, label: `${l.stop} · Recorded cut`, stack: name(l.stop) },
      { id: l.uncutId, label: `${l.stop} · Recorded uncut`, stack: name(l.stop) },
    ]);
    sections.push({ title: `${title}: assigned boards every 5 minutes`,
      text: "Two bars per time bucket, one per stop, each split into recorded cut and uncut boards. Heights count boards, not reading rows. Gaps mean no recorded boards in this pair; they do not establish which size was intended. Table view includes each stop's share of this pair's boards.",
      chart: { query: { interval: "5-minutes", filters, measures: [
          ...cols.map(c => ({ metric: c.id, op: "sum", label: c.label })),
          ...labels.map(l => ({ metric: units, op: "share", where: { metric: target, op: "=", value: l.stop }, label: `${l.stop} share of pair (%)` })),
        ] },
        option: { yAxis: { name: "Boards" }, series: cols.map(c => ({ type: "bar", name: c.label, stack: c.stack, encode: { x: "time", y: c.label } })) } },
    });
    sections.push({ title: `${title}: measured cut lengths in the selected window`,
      text: "Original measured postcut, weighted by boards, separated by original bucket assignment. Nearby peaks may indicate ambiguous assignment; separate peaks support distinct groups but do not prove which physical stop was active. Compare peak locations, not bar heights when the groups have different counts. Select a shorter production interval above to check simultaneous activity. The next section gives cut/uncut counts for each bucket, including samples with missing measured postcut.",
      chart: { query: { groupBy: avgPost, pivot: false,
        filters: [...filters, { metric: avgPost, op: "not-empty" }, { metric: outcome, op: "!=", value: "Uncut" }],
        measures: labels.map(l => ({ metric: l.cutId, op: "sum", label: `${l.stop} · Recorded cut` })) },
        option: { xAxis: { type: "value", name: `Measured ${unit || "length"}`, scale: true }, yAxis: { name: "Cut boards" },
          series: labels.map(l => ({ type: "bar", name: `${l.stop} · Recorded cut`, barMaxWidth: 12,
            encode: { x: avgPostName, y: `${l.stop} · Recorded cut` } })) } },
    });
    sections.push({ title: `${title}: sample counts in the selected window`,
      text: "All assigned boards, including those without a measured postcut. Compare these counts with the distribution table above to identify missing measurements.",
      table: { query: { filters, measures: cols.map(c => ({ metric: c.id, op: "sum", label: c.label })) } } });
  }
  return sections;
}
