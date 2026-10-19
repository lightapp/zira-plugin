---
name: schedule-readings-report
description: Set up a recurring report over one or more Zira data sources at a site in a few guided steps. Each source is recognized as Pallet QA, trimsaw, bandsaw or custom/form, and gets a matching template of key numbers and charts. Every run compares the last day, week or month with the one before, flags quiet sources and bad days, and runs on this computer's scheduler. Use for "send me Cam 1's quality report every morning", "weekly report for my saws" or "schedule a report on these data sources", and to run, change or list those reports. Use readings-report for a one-off analysis, schedule-health-report for device health, and schedule-ai-report for Zira's own emailed AI summaries.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) (including "Asking the user to choose") and [scheduling](../../references/scheduling.md). Run `node scripts/scheduled-report.mjs …` from this skill's directory with the same `--profile`. It reads Zira and writes only to this computer: the readings cache, HTML reports and the saved job. Nothing is written to Zira.

**Scheduled run.** When a scheduled task asks you to run a saved report, run `scheduled-report.mjs run --name NAME` and follow that task's prompt. Do not ask setup questions.

## Set up (keep it to about four questions)

1. **Data sources.** Resolve company and site through authorized discovery, reusing supplied or saved scope. List sources with `node ../readings-report/scripts/readings.mjs sources --company-id ID --site-id ID [--search NAME]`. The user picks 1-10 sources. Share their Zira links.
2. **What goes in it.** Run `plan --company-id ID --site-id ID --device-ids A,B`. Show each group as one short line: the group's name, its sources, and its default blocks (marked `default: true`) in plain words. For example: "Pallet QA (Cam 1 Quality): pallets per day and hour, fail rate, fails by rule, running share, stop reasons". Offer the optional blocks by label. If a source looks misclassified (such as a saw recognized as custom), ask and pass `--kinds ID=trimsaw`. Saws and cameras of one kind share a group. Each custom source or form gets its own group (`key` like `custom-44252`), with submissions counted for forms.
3. **Period and alerts.** Ask the span each run covers: `24h` (daily), `7d` (weekly) or `4w`. Each run compares it with the span before. Mention the alert defaults in one line and change them only on request: fail rate above 8% on a day, more than 60 minutes of stops with no reason entered, quiet after 30 minutes, offline after a day.
4. **Create.** Pick a short kebab-case name (such as `sample-cam1-weekly`), then run `create --name NAME --company-id ID --site-id ID --device-ids A,B --last 7d --choices '<json>'`. The JSON holds `title`, `blocks` keyed by group key, `kinds` and `thresholds` (see `--help`). It builds the first report right away. Show it (`node ../readings-report/scripts/readings.mjs open --report <report>`, or `serve` it). Give the summary's main points from `digest`.
5. **When.** Ask the frequency, time and time zone (default: the site's zone; weekdays at 07:00 is a good suggestion for `24h`, Monday 07:00 for `7d`). Optional: in Claude Code, offer once to keep a private claude.ai page updated on each run. Publish `latest` with the Artifact tool only if the user says yes, then pass its URL as `--artifact-url`. Reports hold customer readings, so never publish one by default. Run `schedule --name NAME --frequency … --time HH:MM --timezone IANA [--day mon] [--artifact-url URL]`, then follow [scheduling](../../references/scheduling.md) to create the host job from the handoff and verify it.

Finish with one line per item: what the report holds, when it runs (site time and this computer's time), the next run, where the latest report lands, and how to change or stop it.

## Run, change, list

- `run --name NAME` refetches the span plus the one before it, rebuilds the report and writes `latest.html`. It prints `digest`: each key number with `current`, `previous`, `change` and `direction` (`better`/`worse`), each source's `state` (`live`, `quiet`, `offline`, `no-readings`) with `lastReading` and `quietFor`, and `flags`. Report from these numbers only, and end with the **Open the report** line ([handing over local pages](../../references/local-pages.md)) for `latest.html`. A source quiet for more than a day is offline: say since when.
- To change contents, run `create` again with the same `--name` (it replaces the job, so reuse its choices). Then run `schedule` again: its `taskId` is the same, so update the existing host job instead of adding one.
- `list` shows saved reports with their schedule and next run. `remove --name NAME` deletes the saved job only. Delete the host job too.

Times are site time. Empty days are gaps (no readings), not zero. The page's date pickers reach both spans, and its controls work offline. The template blocks and their metrics are listed in [templates](references/templates.md). For questions the template does not cover, use `readings-report` on the same sources, or add sections through `choices.extra` (a readings-report spec fragment). Exit codes: 0 done, 2 failed, 3 incomplete coverage (say so), 4 blocked (the JSON explains; a sign-in block means the user signs in again).
