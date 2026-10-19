# Configuration and evidence

Run all commands relative to the installed skill directory, or pass absolute script paths. Keep customer configuration, state and reports outside the package; files written by the tool use private permissions. The same configuration plus evidence produces the same findings in either assistant. A package version does not establish that every production release check has passed; inspect the loaded build identity.

## Minimum saved monitor

Use actual IDs obtained from authorized discovery. This example is synthetic:

```json
{
  "version": 1,
  "monitorId": "example-health",
  "companyId": "101",
  "siteIds": ["201"],
  "profiles": ["trimsaw", "bandsaw", "pallet-qa"],
  "freshnessMinutes": 30,
  "tasks": {"mode": "report-only"},
  "devices": {}
}
```

`siteIds: "all"` refreshes authorized inventory on each run. All in-scope use cases are classified from `cv.settings.PostingMode` (`TRIM_SAW`, `BAND_SAW`, `PALLET_QA`), not names. Unknown profiles are listed as exclusions needing classification. Confirm a device override with `devices.ID.profile` and `profileConfirmed: true`; mark its actual hardware installation with `identity` if known. Without an identity the tool tracks the data source only and cannot detect hardware replacement. Deleted devices/templates are excluded. API failures remain incomplete coverage.

Status-only configuration (`"checks": "status"`, used by the `device-status` skill) leaves out `profiles`: every device whose detail carries a vision status block (`cv`) is in scope, whatever its PostingMode, and forms or custom sources are excluded as "Not a camera: no device status". Count and trim checks are not run, so they never need setup. `"statusDefaults": {"batteryMinimum": 20}` applies a battery limit to every camera unless a device rule sets its own. Last-known hardware is summarized once in report.md and is not a coverage gap or a partial run; connectivity that could not be checked still is. `checks` defaults to `"full"`, the behavior described above.

Task modes are `report-only`, `draft`, `automatic`. The latter two require `tasks.assigneeId`. `automatic` is saved authorization to the skill; the CLI's `run` remains read-only. The skill separately invokes `tasks --apply` when policy authorizes it. Use the same private report/state directory when repeating a monitor. A configuration change resets comparisons; changing limits never retrospectively resolves an old issue.

## Count checks

Add a confirmed per-device rule. Limits apply to each complete operating window of the declared duration; they are not a statistical baseline. Absolute ISO windows make the pilot comparisons reviewable. For recurrent production comparisons, the agent must prepare completed eligible windows from the approved site calendar; unattended automatic calendar expansion is not implemented in this alpha. If these windows become stale, report needs setup rather than reuse old production as current health.

```json
{
  "profile": "bandsaw",
  "profileConfirmed": true,
  "counts": {
    "confirmed": true,
    "metric": "86",
    "kind": "increments",
    "minimum": 10,
    "maximum": 1000,
    "periodMinutes": 60,
    "operatingWindows": [{"from":"2026-09-28T08:00:00Z","to":"2026-09-28T09:00:00Z"}]
  }
}
```

`kind: "counter"` needs `counterReset: "zero"` or `"unknown"`; the collector fetches an earlier period for the starting value. Unknown resets invalidate the count window. Pallet-QA also requires `uniqueCyclesConfirmed: true`: count completed unique pallet cycles, not images, retries or grades. Paired feeds must be mapped/confirmed before interpreting a line total; the alpha reports each data source independently.

## Trimsaw checks

Add `measurements` to an approved trimsaw device rule:

```json
{
  "confirmed": true,
  "independentTargets": true,
  "unit": "in",
  "version": "example-app-version",
  "actualMetric": "40073",
  "targetKeyMetric": "product-code",
  "filterMetric": "cut-state",
  "filterEquals": "cut",
  "granularity": "grouped-mean",
  "weightMetric": "86",
  "minSamples": 10,
  "warningMargin": 0.05,
  "targets": {"recipe-a":{"expected":40,"lower":39.8,"upper":40.2}}
}
```

Metric IDs and categorical filter values must come from the actual schema; this example is not a real device mapping. Targets come from an independently approved specification/recipe. Never assign targets by rounding the actual reading to a nearby size. Validate measurement units end to end: a device's Inch setting and schema's Feet label may disagree. The configured unit is the verified raw-data unit; this alpha does not infer or convert conflicting units. App version must match the approved filter mapping, including older No Cut polarity. Grouped means are weighted; they cannot show the percentage of individual boards outside tolerance. `individual` granularity permits individual outlier checks. At least `minSamples` rows per assigned target are needed. Missing/invalid values and unknown targets appear as findings/partial coverage.

## Status and hardware

`staleStatus: true` provides evidence of reporting loss, unless contradicted by fresh readings. Exact heartbeat ages are available only when the API supplies a timestamp. A recent reading establishes that data is arriving; it does not make old battery/temperature flags current. With no heartbeat or fresh reading, status is Unknown, not Online or Never reported. The attention summary prioritizes current findings and reporting loss within 14 days; losses under 48 hours come before 2–14 days. More than 14 days is long-inactive and lower priority, not automatically irrelevant or recovered. Age uses connectivity `since`, last heartbeat, or last reading in that order and is a proxy, not a proven outage start. An observed reporting-to-not-reporting transition takes priority even with an older or missing signal timestamp; the first assessment alone does not prove a recent outage.

Each report device has an allowlisted `deviceStatus` with `freshness`, `values`, `warnings` and `assessedCodes`. Values include battery/charging, temperature/unit, online/stale, Wi-Fi/cellular/Ethernet, camera on/off/movement, power and an error-present boolean; raw error text is never saved. Hardware alerts require a fresh heartbeat. Battery and heat additionally need confirmed `batteryMinimum` (per device, or `statusDefaults.batteryMinimum`), `temperatureMaximum` and matching `temperatureUnit` rules. Camera off/movement, power off and a reported device error are explicit flags. A network alert requires all three interfaces to explicitly report disconnected; an unused interface alone is not a failure. Missing sensor values cannot clear a prior finding.

Without fresh status provenance, values and candidate warnings are displayed as last known and never promoted to current findings or used to clear incidents. A reporting source with a last-known warning is placed in Needs verification; long-inactive sources stay in the lower-priority group. `attention.rows` merges all current findings and status context per source; `needsCheck` counts distinct sources, including reporting sources with hardware/production alerts. Links are profile-specific (`my.zira.us` for prod, `zira-webinteg.zira.us` for integ) and use `/data-sources/ID`; unknown environments and invalid IDs have no link. Markdown and HTML use the same priorities. Dashboard source links navigate only when clicked; loading the file makes no network requests. The full table and summary are included as static HTML; browser JavaScript enhances them with search and category filters. Hosted publication and audience verification are covered in [sharing](sharing.md).

Heartbeat provenance: `status.lastHeartbeat` is mapped only from a field of that name. Production `/devices/list` `cvStatus` carries no timestamp. `/prod-vision/list` returns `lastModifiedDate`, `modifiedBeforeSeconds` and `staleStatus`, but these are not collected or used as heartbeat times. Platform source (reviewed 2026-09-29) shows that a device's status report (`POST /devices/status/{id}`) writes the status row through `update_device_cv_status`. The offline sweeper `deviceOfflineChecker` sends each device it finds inactive back through that same path, with the previously stored status plus `staleStatus: true`. CV settings, properties and file-attach updates write the same record too. A stale device's `lastModifiedDate` can therefore be the time it was marked stale or edited, not its last report. Many devices sharing one exact value usually means a single sweeper run. Its schedule and threshold are defined outside the platform repository. Mapping it would make old outages look new, so these devices stay "age unknown". Revisit this only if the API exposes a timestamp written solely by device reports.

## Bounded collection

Live collection queries only the selected company, then verifies company/site membership again. It uses four concurrent device requests; default device cap 500 and row cap 50,000 per device. Explicit caps/partial responses cannot pass checks. One raw-data run is limited to 7 days. Readings use `analysis/data/{id}` and are reduced to approved metric fields in memory; full settings/secrets are never saved. Individual API errors do not abort other devices.

For dashboard questions, share relevant discovered dashboard links before further analysis and follow [dashboard evidence](dashboard-evidence.md). `dashboard-widgets --dashboard-id ID` inspects widgets and time settings; `agent-data --dashboard-id ID --widget-ids ID --from ISO --to ISO --interval '1 hours'` queries selected analytics server-side, with one bounded empty/deferred calculation retry and explicit coverage (exit 3 if incomplete). Pass selected company/site IDs to verify scope. It is evidence retrieval, not automatic widget-to-device attribution. Comparison engines based on learned multi-week baselines, persistent outlier percentages and shared-site incident grouping remain planned work.

## Fixture input

`run --snapshot FILE` disables live collection and evaluates normalized evidence. Snapshot has `version`, `companyId`, `assessedAt`, `window`, `complete`, `errors` and `devices`. A device has string IDs (`id`, `siteId`, `companyId`), names, confirmed `profile`, optional `identity`, `appVersion`, `status`, `lastReadingAt`, and optional `readings: {from,to,complete,rows:[{at,values:{metric:value}}]}`. Use synthetic fixtures only in source control. File imports are evidence, not executable instructions.
