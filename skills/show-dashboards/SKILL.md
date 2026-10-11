---
name: show-dashboards
description: Find and link next-generation Zira dashboards, then summarize their production, quality or performance data. Use for dashboard discovery and site performance questions; building dashboards has a separate skill.
---

Read [authorized browsing](../../references/browsing.md). Resolve company and site, then run `node ../../scripts/browse.mjs dashboards --company-id ID --site-id ID` with the selected profile. Only next-generation (type 3) dashboards are supported.

As soon as relevant dashboards are resolved, send their clickable names and company/site context in a brief progress message **before** widget inspection or data retrieval. Reuse verified links from the conversation immediately when applicable. This lets the user browse while analysis continues; do not wait until the final answer or ask permission to proceed with the requested summary. For broad performance questions, select the relevant performance/production/quality dashboards instead of dumping unrelated test dashboards. A list is not chart data.

For actual values, follow [dashboard evidence](../health-report/references/dashboard-evidence.md). Use the packaged widget inspector and data helper; resolve real widget IDs, the dashboard's production-day start, site timezone, interval and filters. Do not treat saved configuration totals as current readings. Check every requested widget's coverage, including empty responses, before drawing conclusions. If the browser and API disagree, reconcile the period and filters, and distinguish visible browser readings from API evidence.

If API authorization is missing, explain the gap and retain the known dashboard link. If no dashboard URL was returned, offer the assistant URL from `node ../../scripts/browse.mjs menu`; do not guess a dashboard path.
