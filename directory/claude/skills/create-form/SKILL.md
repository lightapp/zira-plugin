---
name: create-form
description: Draft a Zira operator form (such as downtime, inspection or quality checks) with the user and open Zira's form editor for the selected site to review and save it.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). The Home Assistant also finishes forms in Zira's form editor, because saving a form creates its site metrics and field schema there. Plan the form in chat, then hand it to the editor.

1. **Site and purpose.** Reuse the company and site, or discover and ask. Ask what the form records and who fills it in, unless already clear.
2. **Draft.** Propose a title, a one-sentence description and a field list close to the user's request, without invented rules or thresholds. Use the editor's field types: text, number, physical measurement (with unit), date, email, dropdown or radio (with options), checkbox, users, tasks, array, label, section, image, video, document, signature, color, location. Mark required fields and any min/max or length limits the user gave. Let the user adjust it.
3. **Open the editor.** Run `node ../../scripts/data-sources.mjs builder-link --company-id ID --site-id ID --kind form --name "<title>" --profile prod`. If `existingWithSameName` lists a form, offer it before creating another. Give `url`: it opens Zira's form editor for that site with its AI assistant. Tell the user to paste the draft there as one message (title, description, then one line per field), review the generated fields and save.

The form exists only after the user saves it in Zira. Do not claim a form, data source or task was created from the draft. A form that should create tasks is configured in the same editor. If the link cannot be built (for example `blocked: authorization`), offer the handoff with prompt “create form” and the draft.
