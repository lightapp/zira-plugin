// Readings query engine shared by readings.mjs (Node) and the generated report page, which
// inlines this file. Keep it dependency-free browser JavaScript whose only module syntax is
// `export` in front of top-level declarations.
//
// Times are site wall-clock milliseconds: the reading's site-local time read as if it were
// UTC, so buckets follow the site's days and hours without time-zone lookups.

export const INTERVAL_MS = { minute: 60e3, "5-minutes": 300e3, "15-minutes": 900e3, hour: 3600e3, day: 86400e3 };
export const INTERVALS = ["raw", "minute", "5-minutes", "15-minutes", "hour", "day", "week", "month", "all"];
// Bounds one result so a chart or table stays responsive; ask for a coarser interval instead.
export const MAX_BUCKETS = 20000;
// "percent" is the share of a metric's readings meeting the measure's `where` condition.
// "share" is the share of a metric's sum on readings where another metric meets `where`
// (fail rate weighted by units, running share weighted by duration).
export const OPS = ["avg", "sum", "min", "max", "count", "count-distinct", "first", "last", "median", "stddev", "percent", "share"];
export const FILTER_OPS = ["=", "!=", ">", ">=", "<", "<=", "in", "not-in", "contains", "empty", "not-empty"];

export function isOp(op) {
  return OPS.indexOf(op) >= 0 || /^p([1-9]|[1-9]\d)$/.test(op);
}

// "2026-09-01", "2026-09-01T06:00" or "2026-09-01T06:00:00" in site time; no zone suffix.
export function parseLocal(value) {
  var m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?)?$/.exec(String(value == null ? "" : value).trim());
  if (!m) return NaN;
  var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  var d = new Date(t);
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
}

export function formatLocal(t, interval) {
  if (typeof t !== "number" || !isFinite(t)) return "";
  var s = new Date(t).toISOString();
  if (interval === "month") return s.slice(0, 7);
  if (interval === "day" || interval === "week") return s.slice(0, 10);
  if (interval === "raw") return s.slice(0, 19).replace("T", " ");
  return s.slice(0, 16).replace("T", " ");
}

export function bucketStart(t, interval) {
  if (interval === "raw") return t;
  if (INTERVAL_MS[interval]) return Math.floor(t / INTERVAL_MS[interval]) * INTERVAL_MS[interval];
  var d = new Date(t);
  if (interval === "week") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  if (interval === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  throw new Error("Unknown interval " + interval);
}

export function nextBucket(b, interval) {
  if (INTERVAL_MS[interval]) return b + INTERVAL_MS[interval];
  if (interval === "week") return b + 7 * 86400e3;
  var d = new Date(b);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// Every bucket from the range start (or first reading) to its end, so an hour or day without
// readings shows as a gap instead of being skipped over.
function timeline(q, found) {
  if (!found.length && (q.from === null || q.to === null)) return found;
  var start = bucketStart(q.from !== null ? q.from : found[0], q.interval);
  var stop = q.to !== null ? q.to : found[found.length - 1] + 1;
  var out = [];
  for (var b = start; b < stop; b = nextBucket(b, q.interval)) {
    out.push(b);
    if (out.length > MAX_BUCKETS) throw new Error("More than " + MAX_BUCKETS + " time buckets; use a coarser interval or a shorter range");
  }
  return out;
}

// Readings arrive as numbers or CSV strings. Like Zira's data research, numeric text becomes
// a number unless it looks like an identifier (leading zero) or exponent notation.
export function readingValue(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  var s = String(v);
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function num(v) {
  return typeof v === "number" && isFinite(v);
}

function matches(v, f) {
  var x = f.value;
  switch (f.op) {
    case "empty": return v === null || v === undefined || v === "";
    case "not-empty": return !(v === null || v === undefined || v === "");
    case "=": return v !== null && String(v) === String(x);
    case "!=": return v === null || String(v) !== String(x);
    case "in": return v !== null && x.map(String).indexOf(String(v)) >= 0;
    case "not-in": return v === null || x.map(String).indexOf(String(v)) < 0;
    case "contains": return v !== null && String(v).toLowerCase().indexOf(String(x).toLowerCase()) >= 0;
  }
  if (!num(v)) return false;
  switch (f.op) {
    case ">": return v > x;
    case ">=": return v >= x;
    case "<": return v < x;
    case "<=": return v <= x;
  }
  return false;
}

function accumulator(op, where) {
  return { op: op, where: where, k: 0, n: 0, sum: 0, sq: 0, min: null, max: null, firstT: Infinity, first: null, lastT: -Infinity, last: null, values: null, set: null };
}

function add(a, v, t, hit) {
  if (a.op === "count-distinct") {
    if (v === null) return;
    (a.set || (a.set = {}))[typeof v + ":" + v] = 1;
    return;
  }
  if (a.op === "count") { if (v !== null) a.n++; return; }
  if (a.op === "percent") { if (v !== null) { a.n++; if (matches(v, a.where)) a.k++; } return; }
  if (a.op === "share") { if (num(v)) { a.n++; a.sum += v; if (hit) a.k += v; } return; }
  if (a.op === "first") { if (v !== null && t < a.firstT) { a.firstT = t; a.first = v; } return; }
  if (a.op === "last") { if (v !== null && t >= a.lastT) { a.lastT = t; a.last = v; } return; }
  if (!num(v)) return;
  a.n++;
  a.sum += v;
  a.sq += v * v;
  if (a.min === null || v < a.min) a.min = v;
  if (a.max === null || v > a.max) a.max = v;
  if (a.op === "median" || a.op.charAt(0) === "p") (a.values || (a.values = [])).push(v);
}

function percentile(values, p) {
  if (!values || !values.length) return null;
  values.sort(function (x, y) { return x - y; });
  var rank = (p / 100) * (values.length - 1), lo = Math.floor(rank), hi = Math.ceil(rank);
  return values[lo] + (values[hi] - values[lo]) * (rank - lo);
}

function result(a) {
  switch (a.op) {
    case "count": return a.n;
    case "percent": return a.n ? 100 * a.k / a.n : null;
    case "share": return a.sum ? 100 * a.k / a.sum : null;
    case "count-distinct": return a.set ? Object.keys(a.set).length : 0;
    case "first": return a.first;
    case "last": return a.last;
    case "sum": return a.n ? a.sum : null;
    case "avg": return a.n ? a.sum / a.n : null;
    case "min": return a.min;
    case "max": return a.max;
    case "median": return percentile(a.values, 50);
    case "stddev": return a.n > 1 ? Math.sqrt(Math.max(0, (a.sq - a.sum * a.sum / a.n) / (a.n - 1))) : null;
  }
  return percentile(a.values, Number(a.op.slice(1)));
}

export function metricIds(query) {
  var ids = [];
  var push = function (m) { if (m && m !== "*" && m !== "device" && ids.indexOf(m) < 0) ids.push(m); };
  (query.measures || []).forEach(function (m) { push(m.metric); if (m.where) push(m.where.metric); });
  (query.filters || []).forEach(function (f) { push(f.metric); });
  push(query.groupBy);
  return ids;
}

// Throws on an invalid query so the agent can correct it; returns a normalized copy.
export function checkQuery(query, metrics) {
  if (!query || typeof query !== "object") throw new Error("Query must be an object");
  var known = function (m) { return m === "*" || m === "device" || !metrics || Object.prototype.hasOwnProperty.call(metrics, m); };
  var interval = query.interval || "all";
  if (INTERVALS.indexOf(interval) < 0) throw new Error("interval must be one of " + INTERVALS.join(", "));
  var measures = query.measures || [];
  if (!Array.isArray(measures) || !measures.length || measures.length > 20) throw new Error("Give 1-20 measures");
  var labels = {};
  var out = {
    interval: interval,
    measures: measures.map(function (m) {
      if (!m || typeof m.metric !== "string" || !known(m.metric) || m.metric === "device") throw new Error("Unknown measure metric " + (m && m.metric));
      var op = interval === "raw" ? "last" : m.op || "avg";
      if (!isOp(op)) throw new Error("Unknown op " + m.op + "; use " + OPS.join(", ") + " or pNN");
      if (m.metric === "*" && op !== "count") throw new Error('Metric "*" only supports op "count" (number of readings)');
      var where = null;
      if (op === "percent" || op === "share") {
        if (!m.where || FILTER_OPS.indexOf(m.where.op) < 0) throw new Error('A ' + op + ' measure needs "where": {"op": "=", "value": "Reject"} (any filter op)');
        if ((m.where.op === "in" || m.where.op === "not-in") && !Array.isArray(m.where.value)) throw new Error("in/not-in conditions need an array value");
        where = { op: m.where.op, value: m.where.value };
        if (op === "share") {
          if (typeof m.where.metric !== "string" || !known(m.where.metric) || m.where.metric === "*") throw new Error('A share measure needs "where.metric": the metric the condition tests (such as a disposition)');
          where.metric = m.where.metric;
        }
      }
      var label = String(m.label || (m.metric === "*" ? "Readings" : (metrics && metrics[m.metric] && metrics[m.metric].name || m.metric) + (interval === "raw" ? "" : " (" + op + ")")));
      if (labels[label]) throw new Error("Measure labels must be unique: " + label);
      labels[label] = 1;
      return where ? { metric: m.metric, op: op, label: label, where: where } : { metric: m.metric, op: op, label: label };
    }),
    filters: (query.filters || []).map(function (f) {
      if (!f || typeof f.metric !== "string" || !known(f.metric) || FILTER_OPS.indexOf(f.op) < 0) throw new Error("Each filter needs a known metric and op " + FILTER_OPS.join(" "));
      if ((f.op === "in" || f.op === "not-in") && !Array.isArray(f.value)) throw new Error("in/not-in filters need an array value");
      if (/^[<>]=?$/.test(f.op) && !num(f.value)) throw new Error("Comparison filters need a number value");
      return { metric: f.metric, op: f.op, value: f.value };
    }),
    devices: query.devices ? query.devices.map(String) : null,
    from: query.from == null || query.from === "" ? null : parseLocal(query.from),
    to: query.to == null || query.to === "" ? null : parseLocal(query.to),
    groupBy: query.groupBy || null,
    pivot: query.pivot !== false,
    sort: query.sort || null,
    limit: query.limit == null ? null : Number(query.limit),
  };
  if (out.from !== null && !isFinite(out.from) || out.to !== null && !isFinite(out.to)) throw new Error("from/to must be site-local dates like 2026-09-01 or 2026-09-01T06:00");
  if (out.groupBy !== null && (typeof out.groupBy !== "string" || out.groupBy === "*" || !known(out.groupBy))) throw new Error("groupBy must be device or a metric ID");
  if (out.limit !== null && !(out.limit >= 1 && out.limit <= 100000 && out.limit % 1 === 0)) throw new Error("limit must be 1-100000");
  if (out.sort && (typeof out.sort.by !== "string" || ["asc", "desc", undefined].indexOf(out.sort.dir) < 0)) throw new Error('sort is {"by": column, "dir": "asc"|"desc"}');
  return out;
}

// data = { devices: [{ id, name, t: [ms], cols: { metricId: [values] } }], metrics: { id: { name, unit } } }
// Returns a table { columns, rows, meta } ready for an ECharts dataset (time column is ms).
export function runQuery(data, query) {
  var q = checkQuery(query, data.metrics);
  var timeCol = q.interval === "all" ? null : "time";
  var groups = {}, order = [], scanned = 0, matched = 0;
  var names = {};
  data.devices.forEach(function (d) { names[d.name] = (names[d.name] || 0) + 1; });
  data.devices.forEach(function (d) {
    if (q.devices && q.devices.indexOf(String(d.id)) < 0) return;
    var label = names[d.name] > 1 ? d.name + " #" + d.id : d.name;
    var cols = d.cols || {};
    for (var i = 0; i < d.t.length; i++) {
      var t = d.t[i];
      scanned++;
      if (q.from !== null && t < q.from || q.to !== null && t >= q.to) continue;
      var pass = true;
      for (var f = 0; f < q.filters.length && pass; f++) {
        var flt = q.filters[f];
        pass = matches(flt.metric === "device" ? String(d.id) : cols[flt.metric] ? cols[flt.metric][i] : null, flt);
      }
      if (!pass) continue;
      matched++;
      var b = timeCol ? bucketStart(t, q.interval) : 0;
      var gv = q.groupBy === null || q.groupBy === "device" || !cols[q.groupBy] ? null : cols[q.groupBy][i];
      var g = q.groupBy === null ? "" : q.groupBy === "device" ? label : gv === null || gv === undefined || gv === "" ? "(none)" : String(gv);
      var key = b + "\u0000" + g;
      var row = groups[key];
      if (!row) {
        row = groups[key] = { b: b, g: g, acc: q.measures.map(function (m) { return accumulator(m.op, m.where); }) };
        order.push(key);
        if (order.length > MAX_BUCKETS * 5) throw new Error("Too many buckets; use a coarser interval or a shorter range");
      }
      for (var m = 0; m < q.measures.length; m++) {
        var ms = q.measures[m];
        var hit = ms.op === "share" ? matches(ms.where.metric === "device" ? String(d.id) : cols[ms.where.metric] ? cols[ms.where.metric][i] : null, ms.where) : false;
        add(row.acc[m], ms.metric === "*" ? 1 : cols[ms.metric] ? cols[ms.metric][i] : null, t, hit);
      }
    }
  });
  var long = order.map(function (k) {
    var r = groups[k];
    return { b: r.b, g: r.g, v: r.acc.map(result) };
  }).sort(function (x, y) { return x.b - y.b || (x.g < y.g ? -1 : x.g > y.g ? 1 : 0); });
  var columns, rows;
  if (q.groupBy !== null && q.pivot && timeCol) {
    var gs = [];
    long.forEach(function (r) { if (gs.indexOf(r.g) < 0) gs.push(r.g); });
    gs.sort();
    if (gs.length > 50) throw new Error("More than 50 groups; filter or set pivot false");
    columns = [timeCol];
    gs.forEach(function (g) { q.measures.forEach(function (m) { columns.push(q.measures.length > 1 ? g + " · " + m.label : g); }); });
    var byTime = {}, times = [];
    long.forEach(function (r) {
      if (!byTime[r.b]) { byTime[r.b] = {}; times.push(r.b); }
      byTime[r.b][r.g] = r.v;
    });
    if (q.interval !== "raw") times = timeline(q, times);
    rows = times.map(function (t) {
      var row = [t];
      gs.forEach(function (g) { q.measures.forEach(function (m, i) { row.push(byTime[t] && byTime[t][g] ? byTime[t][g][i] : null); }); });
      return row;
    });
  } else {
    columns = [].concat(timeCol ? [timeCol] : [], q.groupBy !== null ? [q.groupBy === "device" ? "device" : (data.metrics && data.metrics[q.groupBy] && data.metrics[q.groupBy].name) || q.groupBy] : [], q.measures.map(function (m) { return m.label; }));
    if (timeCol && q.interval !== "raw" && q.groupBy === null) {
      var at = {};
      long.forEach(function (r) { at[r.b] = r; });
      long = timeline(q, long.map(function (r) { return r.b; })).map(function (b) {
        return at[b] || { b: b, g: "", v: q.measures.map(function () { return null; }) };
      });
    }
    rows = long.map(function (r) {
      return [].concat(timeCol ? [r.b] : [], q.groupBy !== null ? [r.g] : [], r.v);
    });
  }
  if (q.sort) {
    var c = columns.indexOf(q.sort.by);
    if (c < 0) throw new Error("sort.by must be one of the result columns: " + columns.join(", "));
    var dir = q.sort.dir === "desc" ? -1 : 1;
    rows.sort(function (x, y) {
      var a = x[c], b = y[c];
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * dir;
    });
  }
  var total = rows.length;
  if (q.limit !== null) rows = rows.slice(0, q.limit);
  return { columns: columns, rows: rows, meta: { interval: q.interval, timeColumn: timeCol, rowsScanned: scanned, rowsMatched: matched, resultRows: total, truncated: rows.length < total } };
}

// Table and export formatting shared by the static page and its live updates.
export function formatValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!isFinite(v)) return "";
    var a = Math.abs(v);
    return v.toLocaleString("en-US", { maximumFractionDigits: a >= 100 ? 1 : a >= 1 ? 2 : 4 });
  }
  return String(v);
}

export function tableCells(result) {
  var tc = result.meta.timeColumn;
  return result.rows.map(function (r) {
    return r.map(function (v, i) { return i === 0 && tc ? formatLocal(v, result.meta.interval) : formatValue(v); });
  });
}

// Spreadsheet-safe text: a leading = + - @ in text would run as a formula in Sheets or Excel.
export function delimited(result, sep) {
  var tc = result.meta.timeColumn;
  var cell = function (v, i) {
    var s = v === null || v === undefined ? "" : i === 0 && tc ? formatLocal(v, result.meta.interval) : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (sep === "\t") return s.replace(/[\t\r\n]+/g, " ");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [result.columns.map(function (c) { return cell(c, -1); }).join(sep)]
    .concat(result.rows.map(function (r) { return r.map(cell).join(sep); })).join("\r\n") + "\r\n";
}
