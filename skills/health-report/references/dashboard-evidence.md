# Dashboard questions: links, context, then evidence

Resolve the authorized company/site and relevant dashboard through `browse.mjs`. Share its returned URL immediately, then continue the requested analysis. Commands below are relative to `skills/show-dashboards/`; for another skill resolve the health-report script within the installed plugin. No source checkout or browser credentials are needed.

## Inspect and choose the period

```sh
node ../health-report/scripts/health-report.mjs dashboard-widgets --dashboard-id ID --company-id ID --site-id ID --profile prod
```

The inspector returns sanitized widget IDs/names, queryability, formula descriptions, time overrides, dashboard default range/interval, timezone/offset, production-day start and an explicit UTC `today` window. It never emits saved `totalY` values as readings. A dashboard with no queryable widgets has no supported analytics to summarize; that says nothing about readings on its sources.

Honor the user's period and any browser period/shift filters they refer to. Otherwise use the dashboard default and state the window. For Today, use the inspector's `today` timestamps: a 06:00 production-day start is not midnight, and before 06:00 the current production day began yesterday. The helper matches the dashboard's supplied offset; do not replace it with the computer's timezone or infer a fixed offset from a timezone abbreviation. For historical periods, account for the applicable timezone/DST. For other default ranges, resolve explicit boundaries using the site timezone, production-day start and first day of week. Ask only when ambiguity changes the answer.

## Retrieve selected analytics

```sh
node ../health-report/scripts/health-report.mjs agent-data --dashboard-id ID --company-id ID --site-id ID --widget-ids ID,ID --from ISO_WITH_OFFSET --to ISO_WITH_OFFSET --interval '1 hours' --profile prod
```

Select `queryable` widgets relevant to the question. Each invocation accepts at most 20 widgets over a positive window of at most 7 days. Use the inspector's `suggestedInterval` when available. The API expects duration strings such as `1 hours`, not a display-interval ID. Inputs carry offsets; the helper normalizes them to UTC in the backend's date-string format.

The legacy endpoint can return HTTP 200 with empty `kpis`/`charts` when calculation is deferred. The helper makes at most one `force=true` calculation request for an empty/deferred response, using the same dashboard, widgets, interval and period. Do not loop, widen scope, or repeat after a timeout, 401/403 or 429. Follow the shared authorization/rate-limit stop rules. A forced calculation does not bypass domain permissions.

Read `status`, `coverage`, `unexpectedRows` and `complete`. Exit 3 means incomplete evidence, not a failed login or zero production. Missing widgets remain unavailable; duplicate widget names are ambiguous because the legacy response identifies results by name rather than ID. A returned KPI may itself be null/non-numeric; do not turn that into zero. Compare only numeric values with compatible units, source attribution, periods and filters. Distinguish configured targets from observed values.

The helper does not apply browser-only quick filters or filter overrides. If a user-selected shift, widget time override, derived metric or unsupported chart affects comparability, disclose the mismatch; do not claim browser parity. Do not sum overlapping feeds into site production or label a product of unrelated percentages OEE.

## When the browser shows data but the API does not

Use available host browser tools to inspect the visible date range, selected shift/filter and widget labels without changing them. Browser observations may support a clearly labeled summary of what is visible, but must not be presented as API-confirmed evidence. Do not extract browser cookies/tokens or use a different identity to work around an API denial.

After the helper's bounded attempt, report any unresolved gap precisely: the selected API widgets could not be retrieved for that window, rather than “the dashboard has no data.” Keep the dashboard link in the answer. Package/runtime fixes belong in the canonical plugin source, not its installed cache.
