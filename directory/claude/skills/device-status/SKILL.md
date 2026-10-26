---
name: device-status
description: Check the basic status of every Zira camera at chosen sites, now or on a schedule — online or offline, battery and charging, temperature, camera on or moved, Wi-Fi/cellular/LAN, power and device errors — with a dashboard, before any production counts or KPIs are set up. Use for "are my Plant East cameras OK?", "check battery and connection on all Example Manufacturing devices", "which cameras were bumped in the last week?", "acknowledge these reviewed bumps", "which cameras moved?" or "check device status every morning". Use health-report for count and trim checks or follow-up tasks, schedule-health-report for those checks on a schedule, and readings-report for production numbers.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) (including "Asking the user to choose") and, for schedules, [scheduling](../../references/scheduling.md). Run `node scripts/device-status.mjs …` from this skill's directory with the same `--profile`. It runs the health-report engine in its status mode: it reads Zira and writes only to this computer (the dashboard, the last check's warnings and, for schedules, the saved monitor). It never creates tasks or changes devices.

**Scheduled run.** When a scheduled task asks you to run a saved status check, run `device-status.mjs run --name NAME` and follow that task's prompt. Do not ask setup questions.

## Check now (one or two questions)

1. **Sites.** Resolve the company through authorized discovery, reusing supplied or saved scope. Run `sites --company-id ID` and let the user pick sites by name, or "all". Share the site links.
2. **Check.** Run `check --company-id ID --site-ids A,B|all`. It covers every camera, meaning any Zira vision device; forms and custom data sources have no device status and are skipped. Battery below 20% while not charging is a warning by default; change it only on request (`--battery-min N`, 0 turns it off). All sites of a large company take a minute or two.

## Movement during a date range and acknowledgement

For "check cameras bumped in the last week", use this same skill and `device_status` MCP tool:
`movement --company-id ID --site-ids A,B|all --days 7`. A different range uses `--from ISO --to ISO`
with explicit offsets, at most 30 days. Resolve authorized company/sites as for a normal check.
Present `open` incidents first, then `uncertain` (observed in the window, occurrence time unknown),
then coverage gaps. Older incidents are `olderUnreviewed`, not new weekly events. Acknowledged
history stays available separately and should not be repeated as an issue. Always deliver the
local movement dashboard. A zero-event result with gaps is not proof that no camera moved.

When the user asks to acknowledge/review named incidents, preview
`acknowledge --company-id ID --report FILE --incident-ids ID,ID --note "Review outcome"` and apply
the exact authorized IDs with `--apply`. Never acknowledge all cameras or future incidents by
implication. An instruction such as "acknowledge those three; we checked their mounts" authorizes
those three without another permission question. Retain the review note; never infer physical
repair/calibration from acknowledgement. A later bump or position change has a new ID and appears
again. Never reset thresholds, counting, the camera or its calibration as part of acknowledgement.

Receipts are private local files, isolated by environment/company/site/camera/journal/event.
They are reused by ordinary Health Report, Device Status and local scheduled monitors on this
computer, but are not shared with teammates' computers or the separate cloud notification service.
Default report attention uses the last seven days; older history is available with a wider window.
The APK needs the dated-journal feature and the plugin needs the corresponding update. Sensor
gaps, restarts, 64-event/30-day retention and unsupported old APKs are explicit coverage limits.
Daily images are supporting evidence via the existing history viewer, not automatic image-based
bump detection. Acknowledgement does not erase that evidence.

## Present a check

The output has `offlineRecently`, `warningsByKind`, `offlineLong`, `couldNotCheck`, `neverReported`, the `attention` counts, `changes` and the `dashboard` path. Report from these fields only, and link each camera by its `url`.

1. **Offline recently first:** cameras that stopped reporting within 14 days, with how long (`hours`) and since when (`since`). Several cameras at one site going quiet together may point to a shared network or power problem; say so as a possibility.
2. **Warnings next,** one line per kind (low battery, camera moved/bumped, camera off, power off/unplugged, cellular only, low storage, device error, no network), naming the cameras. Lead with cameras that are reporting (`reporting: true`). A warning on an offline camera is the last value it sent before going quiet; say that rather than presenting it as current.
3. **Freshness.** Zira usually sends status without a heartbeat time, so most values are last known (`freshness: "last-known"`, counted in `lastKnownStatus`). Present those warnings as "check on site", never as confirmed current faults. Temperature is judged only with a reported unit and a configured threshold; older devices may not report units.
4. **Lower down:** long-offline cameras (over 14 days) as a separate group, then cameras that could not be checked (no status and no recent readings; often placeholders or devices never set up), then healthy totals.
5. **Changes.** On a repeated check of the same sites, `changes.newWarnings` and `changes.clearedWarnings` say what changed since the last check; `firstCheck: true` means there is nothing to compare with yet.

Offer to open the dashboard, and end the answer with the **Open the dashboard** line from [handing over local pages](../../references/local-pages.md). It shows one row per camera with Power & temperature, Network and Camera & errors labels: grey is normal, amber needs checking, red would be a current alert. Hovering a label shows its full value and freshness. Exit 3 means incomplete coverage: say what is missing. Exit 4 is blocked: the JSON explains, and a sign-in block means the user signs in again.

Then offer once to run it on a schedule. For counts, trim targets or follow-up tasks, point to `health-report`.

## Schedule

Ask the frequency (`daily`, `weekdays`, `weekly` + day), time and IANA time zone. Suggest weekdays at 06:30 in the sites' zone; for sites in several zones, offer one time in a named zone. Delivery defaults to `changes-only`: a run with no newly offline or recovered camera, no new or cleared warning and no failed read stays quiet. Pick a short kebab-case name (such as `example-camera-status`), then run `schedule --name NAME --company-id ID --site-ids A,B|all --frequency … --time HH:MM --timezone IANA [--day mon] [--delivery changes-only|all-runs] [--battery-min N]`. It prints the handoff; follow [scheduling](../../references/scheduling.md) to create the host job and verify it. A scheduled run prints the same fields as a check plus `notify`.

Finish with one line per item: the sites, when it runs (site time and this computer's time), the next run, delivery mode, where the dashboard lands, and how to change or stop it.

## Change, list, remove

- Change sites, time, delivery or the battery limit: run `schedule` again with the same `--name` and `--replace`, then update the existing host job with the same `taskId`.
- `handoff --name NAME` reprints the prompt and timing. `list` shows saved status checks with their next run. `remove --name NAME` deletes the saved check and its state; delete the host job too.

On HTTP 429, report the retry time and the missing coverage, and do not retry.

New app builds report timestamped `cameraHealth` and storage. Show free device space and app usage separately; missing app usage is unavailable. App usage is Android UID accounting and excludes public shared media. Cellular-only requires all three interface states. External power is independent of charging. Tilt/bump signals require inspection, and missing/stale evidence never proves recovery. Only fresh, explicitly assessed conditions can clear previous warnings. A source merge alone does not activate camera or cloud coverage.

