---
name: duplicate-dashboard
description: Duplicate a next-generation Zira dashboard the way Zira web's Duplicate does, in the same site or to another site, where Claude reviews the target site's data sources and metrics and proposes the mapping for the user to confirm. Use for "copy the Band Saw 1 dashboard to South Charleston", "duplicate this dashboard" or "make the same dashboard for Plant 2". Use build-dashboard for a new dashboard and show-dashboards to find existing ones.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows Zira web's next-generation Duplicate dialog: dashboard → target site → data source and metric mapping → name → copy. The whole flow happens here; do not send the user to Zira's web assistant.

1. **Source.** Reuse the company and site. Find the dashboard with `node ../../scripts/browse.mjs dashboards --company-id ID --site-id ID` and confirm the exact one. Classic dashboards are duplicated in Zira.
2. **Where.** The same site unless the user names another. Resolve another site (or company) through authorized discovery.
3. **Mapping (another site).** Run `node ../../scripts/dashboards.mjs copy-mapping --company-id ID --site-id ID --dashboard-id ID --target-site-id ID [--target-company-id ID] --out FILE --profile prod`. It lists each source data source with the metrics its widgets use, the proposed target data source of the same kind, alternatives, and each metric's match. Targets are chosen one to one: the same unit by name first (type and number, so "Band Saw 1" fits "Bandsaw 1 | Cam 44"), then matching metrics. `widgets` shows what each copied widget gets: its description and its chart's data source. Review it yourself before showing it:
   - Check every proposed data source against the source's name, kind and metrics. Prefer an alternative when it clearly fits better, and say why.
   - `ambiguous` sources fit several targets equally and are left out of `deviceMapping`; `copy` refuses the mapping until each one is chosen. Ask the user, never pick by order.
   - For each unresolved metric, pick from its `candidates` (same unit) when one clearly means the same thing; otherwise leave it and say which widgets may show no data.
   - A data source with no fit maps to null: Zira copies it to the target site.
   Show the user a short table (source → target, metrics matched, open questions) and ask them to confirm or change it. Write the confirmed mapping (`deviceMapping`, `metricMapping`) back to FILE.
   In the same site, skip this step: every data source maps to itself.
4. **Preview.** Run `dashboards.mjs copy --company-id ID --site-id ID --dashboard-id ID [--target-site-id ID --target-company-id ID --mapping FILE] [--name "…"] --profile prod`. The default name is `<name> (copy)`; if `nameTaken`, offer `suggestedName`. Say what will be created, what `afterCopy` restores (descriptions and chart data sources that Zira's Duplicate loses; `notRestored` lists widgets it cannot), and read out `notCopied` and any `warning` (Filter widgets).
5. **Copy.** After the user confirms, rerun with `--apply`. It copies once, then re-saves only the widgets whose description or chart data source changed in the copy, and reads them back. On `created`, give `url` and relay `warnings`; `orphanedMetrics` lists widgets whose metrics are not on the copy's data sources, `widgetFixes` what was restored. Offer schedule-ai-report, since AI reports are not copied.
6. **Restore an existing copy.** For a copy made with Zira web's Duplicate, or when `widgetFixes` is incomplete, run `dashboards.mjs fix-copy --company-id ID --site-id ID --dashboard-id SOURCE --copy-id COPY [--target-site-id ID --mapping FILE] --profile prod`. Show its `changes` (only empty descriptions and charts still on the source's data source change) and `skipped`, then rerun with `--apply` after the user approves.

Say "channel", never "system". On `blocked: authorization`, nothing was copied: give `handoff.pageUrl` and its Duplicate instructions. Other stops follow [guided actions](../../references/actions.md).
