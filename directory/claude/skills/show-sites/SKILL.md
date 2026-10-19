---
name: show-sites
description: List or find Zira sites for a selected company. Use when the user asks for plants, sites, or their site links.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md). Reuse the user's company, or discover companies and ask them to choose. Run `node ../../scripts/browse.mjs sites --company-id ID` with the selected profile. Show sites with their returned links and company context. If a site name matches more than once, ask the user to select the intended one.
