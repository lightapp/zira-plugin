# Company-level dashboards

A company-level dashboard is a dashboard of the company itself: it has no site (`siteId` null, `companyId` set). It is listed on the company channel's **Dashboards** tab. It can attach data sources from **any site of the company**, so native charts can compare saws across sites.
- **Database permissions:**
  - reading follows the database's row-level security (RLS): company-level members see shared dashboards, and Private dashboards are visible to their creator and the people they're shared with;
  - writes need company update rights (`rls_can_update_company`).
- **Plugin access:** the platform admits company dashboards as company-scoped. Reading one charges only the user's usage allowance. Writes need company update rights, and every attached or referenced data source must be readable and belong to that company.

## Commands (leave out `--site-id`)
- **List:** `node ../../scripts/browse.mjs dashboards --company-id ID`
- **Create:** `node ../../scripts/dashboards.mjs create --company-id ID --company-level --name "…" [--data-source-ids A,B,…] --range last-7-days --interval daily`.
  - The data sources may be on any site of the company, up to 200 of them.
  - The dashboard starts **Private**: only its creator sees it until it is shared. Ask before sharing.
- **Change:**
  - `node ../../scripts/dashboard-widgets.mjs context|save --company-id ID --dashboard-id ID` reads the dashboard and adds or updates widgets.
  - The same flags work for `dashboards.mjs edit`, `delete-widgets`, `delete`, `sharing` and `restore`.
- **Not yet for company dashboards:** copy, copy-mapping, relink and multi-site rollout still handle site dashboards only.
- **Time zone:** the dashboard has one time zone and day start for every site. If the sites span time zones, say so in the widget descriptions.

## Fast aggregated views: aggregator data sources
- **What an aggregator is:** a data source of type Aggregator whose readings are a database view over other data sources. It has one row per source, per **site-local day** (each source site's own time zone and day start), per grouping.
  - Each aggregator field takes one rule per source:
    - `aggregatedMetric` with count, sum, avg, max or min of a source metric;
    - `groupedMetric`, which groups by a source metric;
    - `metadataMetric` with `{{siteName}}`, `{{siteId}}`, `{{meterName}}` or `{{meterId}}`;
    - `staticMetric`, up to 30 characters;
    - `null`.
  - Zira computes it; no custom service is involved.
- **Why use one:** a company dashboard on raw saw readings loads every reading into the browser, which gets slow as saws and ranges grow. On an aggregator it reads a few rows per saw and day. Use it for company totals and site comparisons; keep raw sources for hourly detail.
- **Commands:**
  1. **Create:** `node ../../scripts/aggregators.mjs create --company-id ID --site-id ID --spec AGG.json`. Spec: `{title, like:[source IDs], fields:[{metricId, title?, kind?, enum?}]}`. Field units are copied from the sources.
  2. **Configure:** `aggregators.mjs configure --company-id ID --aggregator-id ID --spec CONFIG.json`, then `--apply --expected REVISION`. Spec: `{sources:[…], config:{metricId: rule}, perSource?, missingAsNull?}`. It posts each changed source once, regenerates the view and reads the configs back.
  3. **Show:** `aggregators.mjs show` lists the sources and rules.
- **Limits:**
  - Rows are daily; there is no hourly view.
  - `avg` is a plain average of the source rows, not weighted by Units.
  - Sources must be in the aggregator's company.
  - Zira cannot detach a source.
  - The form submission fields (329, 330, 331) are set to `null` automatically.
- **Choosing fields:**
  - A field owned by another site is refused ("meter schema and metric must belong to the same site"); Use a field of the aggregator's own site or a global field (`context` and the form editor show which), for example the aggregator site's own Site list field and a global Machine Name field.
  - Don't group by a measured value such as a length: every distinct value becomes a row. On a fleet of 34 trimsaws, grouping by measured length made 37,000 rows a week and the current week timed out after 29 seconds. Use `avg`, `max` or `min` instead; grouping by stop and cut state gave 1,700 rows and loaded in 1.5 seconds.
  - The first load of a new aggregator's past week can fail once while Zira prepares the file; reload.
- **Dates:** every aggregator row is one source's local production day (its site's time zone and day start), in `event_date`. Daily charts can group by `event_date_day` or `event_date`.

## Native widgets across sites
- Attach the saws at creation time. Then group by `meter_name` (one row per saw) or filter with `meter_id` IN, as on any dashboard.
- Every source of a chart must be attached to the dashboard.
- When adding saws later, check the metric IDs first: they must exist on every saw the chart reads. Use readings-report `sources --metrics`, or `context`.

## Embedded and custom widgets (type 19)
These widgets work on site dashboards and on company dashboards. `embedded` reuses another dashboard's chart; `custom` charts its own set of data sources, so the dashboard does not need them attached.
```json
{"version":1,"widgets":[
 {"key":"gr","type":"embedded","settings":{"name":"Grand Rapids: within ±0.6 in.","dashboardId":"11753","sourceWidgetId":"128001"}},
 {"key":"trim","type":"custom","settings":{"name":"Trimsaws: data quality","devices":["44557","39347"],
   "chartType":"7","groupBy":["meter_name"],"aggregations":[…],"derivedMetrics":[…],"customAgg":[…],"filters":[],"withColors":true,"colors":{…}}}
]}
```

### `embedded`
- It shows a Data Research widget of another dashboard live, with that dashboard's metrics and formulas. The source dashboard must be readable, in the same company and not this dashboard.
- Changing the source widget changes every place that embeds it, so prefer a source dashboard the team owns.

### `custom`
- It takes every `dataResearch` setting (see [native settings](native-widgets.md)) plus `devices`: 1–100 data source IDs, from any sites of the company.
- Metrics, derived expressions and `meter_id` filters are checked against those data sources' own schemas.
- It is stored as `embeddedWidgetConfig` with `chartSubTypeName` (`column`, `pie`, `bar`, `line`, `kpi`, `kpi-table`, `kpi-group`).
- Group by `meter_name` for one row per data source, and use `withColors`/`colors` for thresholds.
- Data sources with the same metric (for example every trimsaw's Units) combine in one chart. Check `context` of a site dashboard, or readings-report `sources --metrics`, for metric IDs first.

### Both modes
- Both save the web's placeholder source 21267 on the argument and use the dashboard's time range (`timeSpanType: "default"`).
- An update keeps a custom time span saved in Zira. An existing widget keeps its mode.

## Admission and limits
- **Platform admission:** company dashboards and type 19 saves need Zira's plugin access update for company-level dashboards (platform `assistantAccess`). Before it is deployed, reading a company dashboard answers 403 and type 19 saves answer 400. An older backend answers 400 and nothing is written; report the gap and keep the spec.
- **What the backend checks:**
  - every referenced dashboard, widget and data source is readable by the signed-in user and belongs to the dashboard's company;
  - another company's references are refused;
  - referenced sites are read-only and do not count toward the per-request site limit.
- **Edits, rollouts, restores and backups:** `dashboards.mjs edit`, `rollout`, `restore` and backups keep saved type 19 widgets exactly as Zira returns them (`needsPlatform`).
- **Not handled:** a custom widget's own `devices` list is not remapped by `rollout --remapDataSources`.
- **Deletes:** deleting a dashboard does not search other sites for embedded widgets that show it. Before deleting a dashboard that a company view uses, check the company dashboards first.
- **Verification:** the same as any chart. Open the dashboard and compare key totals and shares with readings-report queries for the same data sources and site-time window.
