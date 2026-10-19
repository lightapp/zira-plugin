---
name: show-data-sources
description: List or find Zira data sources and devices at a selected site. Use for equipment inventory, not live health or raw-reading analysis.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md). Resolve the user's company and site through authorized discovery, reusing supplied scope. Run `node ../../scripts/browse.mjs devices --company-id ID --site-id ID` with the selected profile. Present names and returned data-source links. Inventory presence does not establish that a device is online or healthy. If the user requests a health check, use the sibling [health-report skill](../health-report/SKILL.md).
