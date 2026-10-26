# Readings queries and report specs

Readings are rows: a time and the data source's metric values, keyed by metric ID (`"86"`). Use the IDs from `describe` or `sources --metrics`, not names. Times are **site time** (as the site's clock shows them); a dataset whose readings lack site time says so in `notes` and uses UTC.

## Query

```json
{
  "interval": "hour",
  "groupBy": "device",
  "measures": [{ "metric": "86", "op": "avg", "label": "Average length" }],
  "filters": [{ "metric": "40073", "op": "!=", "value": "Reject" }],
  "from": "2026-09-08", "to": "2026-09-15T06:00",
  "devices": ["501"], "sort": { "by": "Average length", "dir": "desc" }, "limit": 20
}
```

| Field | Values |
| --- | --- |
| `interval` | `raw` (each reading), `minute`, `5-minutes`, `15-minutes`, `hour`, `day`, `week` (Monday start), `month`, `all` (one row; default) |
| `measures` | 1-20 of `{metric, op, label?}`. `metric: "*"` with `op: "count"` counts readings. |
| `op` | `avg` (default), `sum`, `min`, `max`, `count` (non-empty values), `count-distinct`, `first`, `last`, `median`, `pNN` (such as `p90`), `stddev`, `percent`, `share` |
| `percent` | Share (0-100) of the metric's readings meeting `where`: `{"metric": "40073", "op": "percent", "where": {"op": "=", "value": "Reject"}}` |
| `share` | Share (0-100) of the metric's **sum** on readings where another metric meets `where`, for rates weighted by units or minutes: `{"metric": "86", "op": "share", "where": {"metric": "57834", "op": "=", "value": "Fail"}}` (units that failed). One reading can carry many units, so prefer `share` over `percent` for unit rates. |
| `groupBy` | `device` or a metric ID (such as a grade or product). With a time interval, groups become columns (`"pivot": false` keeps them as rows). |
| `filters` | All must match. `op`: `=`, `!=`, `in`/`not-in` (array value), `>`, `>=`, `<`, `<=` (numbers), `contains`, `empty`, `not-empty`. `metric: "device"` filters by data source ID. |
| `from` / `to` | Site-time limits within the dataset (`to` excluded). A report sets them from its range. |

A time result has a `time` column, then one column per measure (or per group). Hours or days without readings are present with empty values, so charts show gaps; do not call them zero. Results are capped at 20,000 time buckets: choose a coarser interval for long ranges (minutes for days, hours for weeks to months, days beyond).

## Report spec

```json
{
  "title": "Trimsaw output, week of Sep 8",
  "summary": "Both saws ran all week.\n\n- **Trimsaw 2 rejected 18% of boards**, 6 points above Trimsaw 1.\n- Average length held at 112 in.",
  "range": { "from": "2026-09-08", "to": "2026-09-15" },
  "kpis": [
    { "label": "Boards", "query": { "measures": [{ "metric": "*", "op": "count" }] } },
    { "label": "Reject rate", "unit": "%", "query": { "measures": [{ "metric": "40073", "op": "percent", "where": { "op": "=", "value": "Reject" } }] } }
  ],
  "sections": [
    { "title": "Boards per hour", "text": "One line on what to look at.",
      "chart": { "query": { "interval": "hour", "groupBy": "device", "measures": [{ "metric": "*", "op": "count" }] } } },
    { "title": "Reject rate by saw",
      "chart": { "query": { "groupBy": "device", "measures": [{ "metric": "40073", "op": "percent", "where": { "op": "=", "value": "Reject" }, "label": "Reject rate (%)" }] },
                 "option": { "series": [{ "type": "bar" }], "yAxis": { "name": "%" } } } },
    { "title": "Length by grade", "table": { "query": { "groupBy": "40073", "measures": [{ "metric": "86", "op": "median" }, { "metric": "86", "op": "p90" }] } } }
  ]
}
```

- `summary` and section `text` accept paragraphs, `- ` bullets, `### ` headings and `**bold**`. No HTML or links.
- `range` defaults to the whole dataset. KPI queries use one measure and ignore `interval` and `groupBy`.
- A section has a `chart`, a `table`, `text`, or a combination. A chart without a table gets a table view; `table.maxRows` (default 200) limits the rows shown, while CSV export has all of them. `chart.height` is 180-900 px (default 340).
- Helpers that compute values outside the readings can add `images` (1-24 `{src, caption?, alt?, width?}`, where `src` is a PNG data URI under 4 MB, 12 MB per section, and `width` 40-1200 px) and a `staticTable` (`{columns: [1-12 names], rows: [up to 200 rows of text or numbers]}`). Both are shown as they are; they do not follow the From/To controls and have no CSV export. Validate Trimsaw Sizes uses them for its camera-view pictures.
- `chart.option` is an [ECharts option](https://echarts.apache.org/en/option.html) in JSON, merged over the report's styled defaults. Leave out `dataset`: the report supplies the query result, and series refer to its columns by name through `encode` (such as `{"x": "time", "y": "Trimsaw 1"}`). Without `series`, each measure column becomes a line. Give one `{"type": "bar"}` per column for bars, or set `encode` for other forms (scatter, heatmap, pie, boxplot…). Functions, markup and script links are rejected.

## Chart rules

- Time series: line (default); bars for counts per day or week. Comparing sources or categories: bar, sorted when order is not meaningful. Distribution: a table or bar chart of `p10`/`median`/`p90` per source or category. A single number is a KPI, not a chart.
- One y-axis per chart. A measure with a different unit or scale gets its own section; two y-axes are rejected.
- At most 8 series in a chart: filter, use `limit` with `sort`, or split into sections.
- Colors follow the report's palette in a fixed order and stay with each series when the viewer filters. Do not set colors unless they carry a meaning the user asked for.
- Name units in labels or `yAxis.name`. Keep titles plain and specific.

## Large datasets

A report embeds only the metrics its queries use. Up to about 6 million values stay explorable in the page; beyond that the report shows its authored results with the controls off and says so. Ask for fewer sources, a shorter range or fewer metrics if the user needs to explore it.
