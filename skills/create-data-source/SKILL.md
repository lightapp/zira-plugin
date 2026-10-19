---
name: create-data-source
description: Create a Zira Vision or Pallet QA data source from its template at a selected site, or open the custom data-source builder. Use for creation; use Zira Help for instructions alone, Show Data Sources for existing inventory and duplicate-data-source to copy an existing data source.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows the Home Assistant data-source flow: site → type → template → name → create.

1. **Site and type.** Reuse the company and site. Ask which kind to create unless supplied: **Vision**, **Pallet QA** or **Custom**. Other kinds (PLC, sensors, aggregators and similar) are created from the site's data sources page in Zira; use Zira Help for guidance.
2. **Vision / Pallet QA.** Run `node ../../scripts/data-sources.mjs templates --company-id ID --site-id ID --kind vision|pallet --profile prod` and let the user choose a template. Ask for a name. Preview with `data-sources.mjs create --company-id ID --site-id ID --kind … --template-id ID --name "…"`. If `duplicates` is not empty, ask for a different name. Confirm, then rerun with `--apply`.
3. **Result.** On `created`, give the data source link. If `attachedToSiteSystem` is false, relay the warning: the source exists but should be attached to the site from Zira. Offer setup-vision for pairing, mounting, recording and training. A created data source is not connected equipment.
4. **Custom.** Run `data-sources.mjs builder-link --company-id ID --site-id ID --kind custom [--name "…"]` and give its URL: Zira's editor opens with its AI builder. Draft the fields from the user's description (names, types, units) for them to paste, and point out `existingWithSameName`. Saving happens in the editor. Afterwards readings can be posted through the Zira API; use Zira Help for the API guide. Never ask for or paste API keys in chat.

On `blocked: authorization`, nothing was created: offer the handoff with prompt “create data source” and the chosen type, template and name. Do not claim equipment is connected or reporting because its page opens.
