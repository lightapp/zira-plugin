---
name: build-dashboard
description: Start a new next-generation Zira dashboard from a site's data sources, then continue widget drafting in the dashboard's AI builder. Use for dashboard creation; use Show Dashboards to find existing ones and duplicate-dashboard to copy one.
---

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows the Home Assistant dashboard builder: site → data sources → name and purpose → create → AI widget draft.

1. **Site and data sources.** Reuse the company and site. List data sources with `node ../../scripts/browse.mjs devices --company-id ID --site-id ID`. Reuse sources the user named; otherwise ask which to include (“all” is allowed). If the site has no data sources, offer create-data-source.
2. **Purpose, name and time.** Ask what the dashboard should show if the request is vague. Suggest a short, title-like name and a one-sentence description from that purpose. Map stated defaults: `--range today|yesterday|this-week|last-week|last-7-days|last-14-days|last-21-days|last-30-days|last-60-days|last-365-days|last-60-minutes` and `--interval last-reading|1-minute|5-minutes|15-minutes|hourly|daily|weekly|monthly` (defaults: today, hourly).
3. **Preview.** Run `node ../../scripts/dashboards.mjs create --company-id ID --site-id ID --name "…" --description "…" --data-source-ids ID,ID [--range … --interval …] --profile prod`. If `nameTaken`, offer `suggestedName` or another name. Confirm before creating.
4. **Create.** Rerun with `--apply`. On `created`, give `url` and `builderUrl`. Explain that the dashboard exists with its data sources but no widgets yet: `builderUrl` opens its AI builder, where the user can paste the purpose (“Dashboard goals: …”), review the drafted widgets and save them.

Widgets are drafted and saved only in Zira's builder; never invent KPI readings or claim widgets exist. Next-generation dashboards only. On `blocked: authorization`, nothing was created: offer the handoff. Its prompt (`Create a dashboard` plus `data-source-ids: …`) lets the web assistant start from the same data sources after the user selects the site. Scheduled summaries of a dashboard use schedule-ai-report.
