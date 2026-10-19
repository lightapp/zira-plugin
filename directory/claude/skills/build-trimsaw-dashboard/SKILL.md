---
name: build-trimsaw-dashboard
description: Create a native Zira trimsaw validation dashboard after asking the user to select one or more data sources. Shows cut/uncut counts, original stop buckets, pre-cut and post-cut lengths, uncut reasons, weighted stop summaries, neighboring-stop comparisons, source readings and an AI summary. Use for "create a trimsaw validation dashboard" or "build this trimsaw dashboard for my saws". Use validate-trimsaw-sizes for the local diagnostic report and calibrate-trimsaw-stops for calibration instructions.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md), then use
[Build a Dashboard](../build-dashboard/SKILL.md) for all dashboard creation, widget payloads,
preview/apply receipts and verification. This skill owns the trimsaw selection and blueprint;
it reuses that skill's API helpers. The result is a saved Zira dashboard, not a local report.

1. **Ask for the sources.** Reuse any company/site the user supplied. Discover accessible
   sites if needed, then list candidate sources using
   `node ../readings-report/scripts/readings.mjs sources --company-id ID --site-id ID --metrics`.
   Show names and source links and ask which **one or more** sources to include. If the user
   already selected them, use that selection without asking again. Qualify candidates by their
   actual schemas: quantity/Units, average Precut Length, average Postcut Length, Target Length
   and No Cut. Do not pick a camera merely because its name contains “saw.” Explain missing
   metrics and retain valid selections rather than quietly substituting another source.
2. **Establish the time and meaning.** Use the supplied range; otherwise suggest the last seven
   days in site time. If calibration/labels changed, prefer a populated interval after the change
   and explain that choice. Use the local validation skill's read-only `windows`/`check` when
   change-point evidence is useful, but do not create its HTML report as the requested deliverable.
   Verify flag encodings and quantities with a bounded sample. Reuse confirmed length units;
   ask if units are ambiguous, or use “recorded length” pending confirmation. Keep measured values
   and original stop labels: this dashboard does not silently rescale, merge labels or calibrate.
3. **Plan the sections.** Read the [dashboard blueprint](references/blueprint.md). Create one
   dashboard for selected sources in the same site, with a separate validation section per source
   and an explicit source filter in every analytical widget. Separate sources remain separate
   even when they share metric IDs or stop labels. A dashboard belongs to one site; for selections
   spanning sites, explain that separate dashboards are required and agree on the site scope.
   Use a short title such as “Trimsaw validation · <site>”. Explain the intended sections and any
   missing data or unavailable widget capability. The user's request to create the dashboard
   supplies authorization for that stated scope; reuse it rather than repeatedly asking to save.
4. **Create and populate through the API.** Create the next-generation container using the
   shared helper with **all selected source IDs**, then read its widget context. Draft native
   specs from real metric IDs, following the blueprint and build-dashboard references. Use one
   batch per source (at most 20 widgets / 256 KiB); read a fresh context and preview before each
   batch. Save with the reviewed revision. Add an AI Insights summary for each source using
   `aiSummary` and explicit analytical widget keys/IDs. If backend admission is unavailable,
   retain that draft and report the missing summary instead of using browser editing or claiming
   completion. Do not copy a customer dashboard, fixed metric/source IDs or stored results.
5. **Verify and deliver.** Read back all widgets and layouts, then inspect the dashboard in the
   browser. For **each source**, compare a total, cut/uncut share, weighted stop mean and length
   distribution with independent readings for identical site-time bounds and filters. Exercise
   its stop filter and check other source sections remain unchanged. Check a narrower populated
   range, an empty range and a mobile layout. Verify the AI answer uses the selected source/range
   and states uncertainty; a saved question alone is not a verified generated summary. Return the
   dashboard link, selected source names, time basis, units and validation status. State any
   omitted neighbor pairs or incomplete widgets explicitly.

When asked to develop or test this skill itself, use synthetic/offline fixtures unless live
dashboard writes are separately requested. Creating this dashboard never authorizes camera
changes, editing readings, notifications or recurring reports. Do not infer current stock,
physical stop intent or a calibration failure from the dashboard alone.
