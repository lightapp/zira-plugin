# Native settings and payloads

Contents: spec / analytical settings / filters / formulas / support widgets / persistence.
Contract inspected against Zira web's widget editors, `dataResearchUtilsWeb.js`, `derivedMetricsUtils.js`, `FilterWidget/utils.ts`, `ReadingsNextGenTableWidget/utils.js`, `DeviceDashboard.tsx`, and data-research enums on 2026-10-14. The installed skill needs no web checkout. These are persisted **normalized** settings: IDs are strings, not editor option objects. Never send rendered chart data.

## Spec and context

`dashboard-widgets.mjs context` returns the dashboard, current widgets/layout, revision, source metric IDs, aliases (`m<ID>`), key names when available, types, units, allowed values and source membership. It reads at most 50 attached sources in batches. `save` accepts at most 20 widgets and 256 KiB per draft. More widgets require a separate reviewed batch with fresh context.

```json
{
  "version": 1,
  "widgets": [{
    "key": "output",
    "type": "dataResearch",
    "settings": {
      "name": "Output by day",
      "description": "Sum of Units, including all selected sources.",
      "chartType": "5",
      "groupBy": ["event_date_day"],
      "aggregations": [{"id":"A_0123abcd","metric":"86","operator":"2","name":"Units","hide":"on","yAxis":0,"filters":[],"timeSeriesChartType":"2","color":"#1976d2"}],
      "customAgg": [], "derivedMetrics": [], "filters": []
    },
    "layout": {
      "lg":{"x":0,"y":0,"w":12,"h":7}, "md":{"x":0,"y":0,"w":12,"h":7},
      "sm":{"x":0,"y":0,"w":6,"h":7}, "xs":{"x":0,"y":0,"w":2,"h":7}
    }
  }]
}
```

`86` is illustrative; resolve it in context. `key` is a unique local key. Omit `widgetId` to create; supply a current dashboard widget ID to update that widget with **complete settings**. For updates, start from its current normalized settings and change only requested fields. Arrays replace arrays; this is not a sparse patch. Type changes and deletion aren't supported. No source/device schemas are modified.

Layouts use 12/12/6/2 columns at lg/md/sm/xs. Integers `x,y,w,h` describe grid position and size. Explicit layouts must not overlap; untouched existing layout rows remain. Omit a new widget's layout to pack it below existing rows. An updated widget keeps its position unless its layout is supplied. Prefer KPI rows (3–4 cards), charts in pairs, tables wide, headings/controls short and full-width. On phones, stack at width 2 with enough height for labels. The helper cannot make a crowded chart readable just by checking coordinates.

## Every Data Research setting

Widget type is `15`. `chartType` selects component subtype:

| ID | Display | Best use |
| --- | --- | --- |
| `6` | KPI | One ungrouped summary |
| `10` | Grouped KPI | One grouping; compare categories as cards |
| `7` | KPI table | One/two grouping levels; several measures |
| `2` | Column | Distributions/comparisons; supports mixed line and column series |
| `4` | Bar | Long category labels |
| `3` | Pie | A small number of parts of one meaningful whole |
| `5` | Time series | Time dimension, line/column measures |

| Setting | Meaning and choices |
| --- | --- |
| `name`, `description` | Title and analytical definition; state filters, weighting, correction factors and limitations |
| `groupBy` | Ordered IDs, up to two. KPI: empty; grouped KPI: exactly one. Raw metric IDs or a derived field ID |
| `aggregations` | Base series, described below; at least one |
| `customAgg` | Calculated series after grouping; cannot alter category labels |
| `derivedMetrics` | Per-reading fields evaluated before grouping; usable as dimensions, measures or filter metrics |
| `filters` | Conditions shared by the widget, outer AND / inner OR |
| `drillDown` | Enables the second grouping level; needs two dimensions |
| `flatTable` | Show full drilldown in a single KPI table |
| `sortBy` | `0` none, `1` value, `2` name |
| `sortDirection` | `1` ascending, `2` descending |
| `kpiTableSort` | Table sorting map; editor default `{ "groupBy": {"id":"groupBy","order":"asc","index":0} }`. Preserve existing column sort entries |
| `limit` | 0 = unlimited; positive value restricts categories (declare omitted coverage) |
| `limitUnit` | `1` fixed count; `2` percentage |
| `stacking` | `0` side-by-side, `1` normal, `2` percent, `3` overlap; meaningful for compatible multi-series charts |
| `multiYAxises` | Separate y scales for differently scaled measures |
| `maxYAxises` | Maximum y-axis **value**, not axis count; 0 means default |
| `withGauges` | KPI/grouped KPI gauge mode |
| `gaugesRange` | `{min:0,max:100}`; bounds must match units |
| `withColors` | Enable threshold colors |
| `colors` | `{low,medium,high}` each `{from:"0",to:"50",color:"#d32f2f"}`; match direction of good/bad to the question |
| `fontSize` | Relative text multiplier, normally 1 |
| `isFormatTime` | Format duration values; don't enable for counts or clock timestamps |
| `formatTime` | `{measured,display}`; measured: `days|hours|minutes|seconds`; display: `days|hours|minutes|formatted` |
| `pieDisplay` | Array containing `percentage`, `value`, or both |
| `pieColors` | Category palette (hex colors); omit the pie aggregation's `color` to allow distinct slice colors. Don't confuse with KPI thresholds |
| `showInLegend` | Show pie legend |
| `isCenterLabel` | Centered label presentation where supported |
| `agentQuestion` | Saved optional AI question; saving it doesn't run or schedule a report |

Time dimensions: `inherit_from_widget` (dashboard interval), `event_date_minutes`, `event_date_5_minutes`, `event_date_15_minutes`, `event_date_hour`, `event_date_day`, `event_date_week`, `event_date_month`. Minute resolution is intended for ranges ≤8 days; five/fifteen minutes ≤32 days; hourly ≤366 days. Device dimensions: `meter_id`, `meter_name`. Respect the dashboard's timezone, shift/day offset and first weekday; calendar midnight and production-day start need not coincide.

Base aggregation: `{id,metric,operator,name,color,timeSeriesChartType,hide,yAxis,filters}`. `name` sets the legend/table label (`label` is accepted by the helper as an alias and normalized to `name`). `defaultName` is optional editor text. IDs are stable `A_` plus eight hex digits. Operators: `1` average, `2` sum, `4` max, `5` min, `6` count, `10` distinct count, `11` first, `12` last. Text supports only count/distinct/first/last; numeric/list support all above; timestamp/image/boolean don't support first/last in the current contract. `3` percentage exists in the enum but isn't a normal metric operator; calculate an explicit numerator/denominator instead. COUNT counts readings, not boards/items represented by those readings.

Series display: `hide:"on"` shows it, `"hide"` keeps a disabled legend entry, `"off"` hides helper series but retains them for formulas. `yAxis` is a zero-based index. `timeSeriesChartType:"5"` line or `"2"` column applies only to column/time-series charts. Omit it on pie, bar and KPI/table widgets: a series override can turn the whole presentation into columns. Use consistent hex colors such as blue `#1976d2`, green `#388e3c`, amber `#fbc02d`, red `#d32f2f`, purple `#7b1fa2`.

### Column and bar categories come from the first visible series

Seen in the browser on 2026-10-21: a column or bar chart (`chartType` `2` or `4`) with several
base aggregations draws **only the categories where the first visible aggregation has rows**.
Categories where only later series have rows are dropped without any error. When the first
series has no rows at all, the chart reads "Data ranges from 0 to 0". A first aggregation with
`hide:"off"` does not carry categories; the next visible one decides. For example, a cut-length
histogram with series Stop 30, Stop 40 and Stop 45 grouped by `roundTo(POST, 0.1)` shows only
the bins around 30. A Cut series first drops every stop or length bin that has only uncut boards.

Order series so that the first visible one covers every category:

- **All, then subsets overlaid.** First series: all boards, with no series filter. Later series:
  a subset such as Uncut, with `stacking:"3"` (overlap). The visible remainder of the first bar
  is everything outside the subset; say so in the description. Verified for one overlaid subset.
- **One series per text band, dominant band first.** For a composition by category, such as
  distance bands per stop with `stacking:"2"` (percent), put the band present in every category
  first. A category with no rows in that band still disappears, so check it in the browser.
- **One series.** A histogram does not need a per-category split to show the shape.

`save` returns a `first_series_categories` warning when a later visible series has filters the
first one does not have, so it can keep rows outside the first series. The check compares series
filters only; it cannot see which categories have data. Fix the order, or confirm in the browser
that the first series has rows in every category. A warning never blocks the save. Time series
(`5`), pie and KPI widgets are not checked; this behavior was observed only on column/bar charts.

## Filters

```json
[[{"metric":"meter_id","operator":"1","filterValue":"123"}],
 [{"metric":"87","operator":"1","filterValue":"A"},{"metric":"87","operator":"1","filterValue":"B"}]]
```

Means source 123 AND (category A OR B). Use widget filters for shared population and aggregation filters for differences between series. `filterValue` is a string; membership uses comma-separated values. Optional `id` identifies an editor condition; `vlookupByLabel` uses the lookup label rather than stored key.

Operator IDs: `1` =, `2` >, `3` ≥, `4` <, `5` ≤, `6` ≠, `7` IN, `8` NOT IN, `9` IS TRUE, `10` IS FALSE, `11` NULL, `12` NOT NULL, `100` contains, `101/102` >/< last hours, `103/104` >/< last days, `110` stack. Not every operator applies to every metric. Current boolean editor uses `1` with `t` or `f`; inspect values rather than assuming true/false strings. Daily API rows can carry booleans while weekly files carry `t`/`f`; derived expressions use strict equality. A category expression must handle both, e.g. `(m123 == true or m123 == "t") ? "Yes" : ((m123 == false or m123 == "f") ? "No" : "Unknown")`. Test short and long ranges. Null predicates still carry `filterValue:""`.

Date/filter dimensions include `event_date` (absolute timestamp), `event_date_num` (relative time), `event_date_month_num`, `event_date_hour_num`, `event_date_dow` (0 Sunday…6 Saturday). `reading_position` supports `201` (take last N before other filters) or `202` (after other filters); this deliberately changes the population. Do not use relative/slice operators on ordinary numeric metrics. Standard metric types and allowed values come from context.

## Row expressions versus calculated series

Derived field: `{id:"D_0123abcd",name:"Length bin",exp:"roundTo(m123, 0.5)",dataType:"numeric"}`. Reference raw metrics using context `keyName` or `m<ID>`, never a numeric ID by itself. `text` data type permits labels; `numeric` requires numbers. Derived expressions don't refer to other derived fields in this helper. Available row helpers:

- `roundTo(value,step)`: nearest step; `correct(value,scale,offset)`: value × scale + offset.
- `nearest(value,[sizes])`: nearest without tolerance; can hide outliers, so use deliberately.
- `snap(value,[sizes],tolerance,fallback)`: nearest within tolerance. **Tolerance must be positive**; 0 means always snap in the web engine. Keep it below half the nearest size gap.
- `snapLabel(value,[sizes],tolerance,step,suffix)`: preserves unmatched measured size in a label.
- `clamp(value,min,max)` and `text(a,b,...)`. Use `text`, not `+`, for joining numbers and text.
- Ternaries, arithmetic, comparisons and common math helpers. Check missing inputs explicitly when another referenced input can be present. Failed expressions produce null; that is not a zero.

Group by a numeric derived field only when its values cannot be negative. On 2026-10-21 a chart
grouped by `roundTo(mLEN - mTARGET, 0.1)` rendered nothing at all. Text band labels from a derived
field work, both in `groupBy` and as the `metric` of an aggregation filter (operator `1`, the
label as `filterValue`). Prefix labels with their order (`1 Short > 0.5`, `2 Short 0.25-0.5`,
`3 Within 0.25` …) so legends and sorting follow the bands rather than the alphabet.

Calculated series: `{id:"C_0123abcd",name:"Rate %",exp:"A_0123abcd > 0 ? 100 * A_89abcdef / A_0123abcd : 0",displayExp:"...same expression...",hide:"on",yAxis:0}` plus optional color/display type. References must be existing aggregation IDs or earlier custom IDs. State zero-denominator behavior; a zero fallback can be mistaken for a real zero, so pair with sample counts. Derived fields answer row-level questions; custom series answer questions about grouped summaries.

## Supporting widgets

- `aiSummary`: a question over explicitly selected analytical widgets; see [AI summary settings and payload](ai-summary.md). This uses the native AI Insights `filters` envelope, not analytical settings. Creation does not run or schedule AI. Backend admission must support type 18. The generated answer receives KPI values, but only placeholders for grouped charts and KPI tables.

- `header`: `name,description,fontSize` (1 small, 2 medium, 3 large), `isCenterHeader`. The current header renderer shows only `name` on one unwrapped line; description is stored but not visible there. Keep the name short and put analytical caveats in chart descriptions. Stored as type `6`, empty `components`, `uiSettings:{fontSize,isCenterHeader,description}`.
- `filter`: `name,description,hideHeader,displayType` (`toggles|dropdown|radio`), `interactionMode` (`inline|quick-filter|mixed`), `quickFilterSelectionMode` (`single|multiple`), `filtersList:[{id,name,isActive?,isDefaultActive?,isHideValue?,interactionMode?,filters}]`, `widgetsTargetKeys:[local keys]`. Stored as type `20`, component/argument type `10`; targets become `widgetsList:[{id,name}]` after target creation. Targets must be analytical/readings widgets in the same draft. Each item can use `inline` (editable condition, initially active) or `quick-filter` (toggle a saved condition, starts from `isDefaultActive`). Use `quick-filter` for mutually exclusive saved stop choices; old `isActive:false` alone does not disable inline conditions. `mixed` describes a widget with both item modes. Don't start incompatible choices active. Current quick-filter buttons scroll horizontally on narrow screens; legacy `displayType` does not turn them into a dropdown. Verify every choice remains reachable.
- `readings`: `name,description,device` (one attached source ID), `columnsSelected` (metric IDs plus `time`), `filters,isKeepEditMode:false`. Stored as type `17`, component type `8`, argument type `10`, `chartType:"17"`. The legacy `filters` envelope uses `{deviceId,columnsSelected,isKeepEditMode,filters}`, while normalized settings use `device`; both must identify the same attached source. Inspect rows without enabling reading edits. The editor may still offer manual actions to a human with permission.

## Persistence and verification

Analytical payload: `type:{id:"15",name:"DataResearch"}`, one component `{type:{id:chartType,name},placementIndex:1,arguments:[{type,placementIndex:1,device:{id:scopedSource},filters:settings,nextGenWidgetSettings:settings,func:null}]}`. Range/interval overrides default to null (inherit dashboard); updates preserve existing overrides. The helper uses an attached source ID rather than the web helper's historical fixed device ID. Settings remain normalized. Header/filter/readings use the special envelopes above.

Routes: POST `/dashboards/{id}/widgets`, PUT `/dashboards/widgets/{id}`, PUT `/dashboards/configuration-layout/{id}`, then GET `/dashboards/{id}`. Authentication uses the plugin's existing browser sign-in only. Preview writes nothing. Apply requires the preview revision, writes each operation once, records progress in the shared action receipt, and reads back settings and all layouts. It is **not an atomic transaction** and the revision check is client-side, not a server compare-and-swap. Stop on partial/unknown results; preserve the receipt and inspect actual saved state. No blind batch replay, deletion, notification or source modification.

Exit codes: 0 completed/preview/already done, 2 invalid or failure, 3 saved but unverified, 4 blocked. JSON on stdout; failure diagnostics on stderr. `--out FILE` saves private-mode JSON. Files/receipts can contain customer metadata and must stay outside Git/plugin packages. Don't call a configuration-only check a data/render pass.

## Advanced calculated series

The web editor supports more than scalar ratios. Keep these as `customAgg`, preserve exact IDs, and verify against a small known slice before applying them to production data. They don't turn the widget into a general script runner.

| Expression | Meaning / caution |
| --- | --- |
| `acc(A_0123abcd)` or `sum(acc_A_0123abcd)` | Cumulative series in grouping order; use chronological ordering for time accumulation |
| `mean(multi_A_0123abcd)`, `median(multi_A_0123abcd)`, `sum(...)`, `count(...)` | Statistic over the **grouped series values**, not weighted individual readings; vector functions use one referenced series |
| `linearRegression(A_0123abcd)` | Fitted trend across grouped points |
| `linearRegressionSlope(A_0123abcd)` | Current engine renders percentage change across the fitted endpoints, despite the name; not a slope in raw units/time |
| `benchmark(A_0123abcd,'#388e3c','#d32f2f',A_89abcdef)` | Colors selected series above/below the reference; does not create a numeric benchmark series |
| `downtimeCalc(A_0123abcd)` | Minutes in intervals matching that base aggregation's filters; requires ordered event timestamps, an explicit end/timezone and meaningful transition readings |
| `timeToNow(A_0123abcd)` | Minutes since the latest reading if its aggregation filter still matches, capped at the selected end; not a universal machine downtime measure |
| `coalesce(a,b)` | Replace missing result; don't silently turn missing evidence into a healthy value |
| `safeNum(a)` | Coerces invalid/missing to zero; use only when zero is semantically appropriate |
| `safeDivide(a,b)` | Replaces a zero denominator with **1**, not null; usually prefer an explicit denominator condition |
| `gt(value,threshold)` | For arrays keeps values above threshold; for scalar returns value or null |
| `avgLine(values)` | Mean after removing zero values; differs from mean including zeros |
| `syncZeros(a,b)` | Masks a to zero where b is zero/invalid |
| `IN(value,[...])` | Membership predicate |
| `formatDate(date,format)` | Formatted date string (date-fns format) |
| `datesDiff(start,end,unit)`, `datesDiffNum(...)` | Human-readable distance or its numeric component; not necessarily a signed precise duration |
| `formatNumberToDuration(number,'seconds',format)` | Format a numeric duration |

`dashboardFromDate`, `dashboardToDate`, `interval` (seconds), and `t` (one-based grouped point index in scalar context) are calculation-context variables. They are not row-level metric aliases. `now()` changes as the chart recalculates; use a fixed window for reproducible acceptance. The helper validates names/references, not the whole mathJS language or mathematical meaning. The browser/data comparison remains mandatory for a new complex formula.
