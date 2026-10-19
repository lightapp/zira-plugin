---
name: schedule-health-report
description: Set up a recurring Zira fleet health report for one or more sites in a few guided steps. It checks every trimsaw, bandsaw and Pallet QA device for reporting loss and alerts, writes a dashboard, and runs on this computer's scheduler, staying quiet when nothing changed. Use for "check my Example Manufacturing sites' devices every morning", "schedule a health report for Plant 2" or "daily device health for these plants", and to run, change or list those reports. Use health-report for a one-off check, task follow-up or custom count and trim rules, device-status for battery, temperature, camera and network status of every camera (now or scheduled), and schedule-readings-report for production numbers.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) (including "Asking the user to choose") and [scheduling](../../references/scheduling.md). Run `node scripts/monitor.mjs …` from this skill's directory with the same `--profile`. It uses the health-report engine, reads Zira and writes only to this computer: the saved monitor, its comparison state and dashboards. It never creates tasks or changes devices.

**Scheduled run.** When a scheduled task asks you to run a saved health report, run `monitor.mjs run --name NAME` and follow that task's prompt. Do not ask setup questions.

## Set up (about three questions)

1. **Sites.** Resolve the company through authorized discovery, reusing supplied or saved scope. Run `sites --company-id ID` and let the user pick sites by name, or "all" (all authorized sites, refreshed each run). One monitor covers one company. Device types default to trimsaw, bandsaw and Pallet QA. Narrow them only on request (`--profiles`).
2. **When and how loud.** Ask the frequency (`daily`, `weekdays`, `weekly` + day), time and time zone. Suggest weekdays at 06:30 in the sites' zone. When the sites span several zones, offer one monitor per zone or one time in a named zone. Delivery defaults to `changes-only`: a run with no new problems, recoveries or failed reads replies in one line. Use `all-runs` when the user wants the full summary every time.
3. **Create.** Pick a short kebab-case name (such as `example-plant-health`), then run `create --name NAME --company-id ID --site-ids A,B|all --frequency … --time HH:MM --timezone IANA [--day mon] [--delivery changes-only]`. It checks the sites against the user's authorized list and prints the handoff. Run `run --name NAME` once right away and present it as below. Then follow [scheduling](../../references/scheduling.md) to create the host job from the handoff and verify it.

Finish with one line per item: the sites and device types, when it runs (site time and this computer's time), the next run, delivery mode, where the dashboard lands, and how to change or stop it.

## Present a run

`run` prints `attention` (counts by priority), `changes` (`new` findings, `recovered`, `ongoing`, `firstAssessment`), `notify`, `coverage` and the `dashboard` path. Lead with what needs fixing: devices that went down recently, with how long and since when, then current alerts, then long-inactive devices as a separate group. Read `report.json` next to the dashboard for the rows, link each data source by its `url`, and end with the **Open the dashboard** line from [handing over local pages](../../references/local-pages.md). On a scheduled run with `notify: false`, reply in one line. `coverage.checksNeedingSetup` means count or trim checks are not configured. That is not a failure. Mention it at setup only, and point to `health-report` for those rules. An incomplete inventory or failed reads (exit 3) must be reported.

## Change, list, remove

- Change sites, time or delivery: run `create` again with the same `--name` and `--replace`, then update the existing host job with the same `taskId`. The comparison state is kept.
- `handoff --name NAME` reprints the prompt and timing. `list` shows saved monitors with their next run. `remove --name NAME` deletes the monitor and its state. Delete the host job too.
- Tasks, task automation, custom count or trim limits and sharing the dashboard belong to `health-report` with the same sites.

Exit codes: 0 done, 2 failed, 3 incomplete coverage (say what is missing), 4 blocked (the JSON explains; a sign-in block means the user signs in again). On HTTP 429, report the retry time and do not retry.
