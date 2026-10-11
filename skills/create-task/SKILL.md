---
name: create-task
description: Create a general Zira task at a selected site, with a reviewed title, description, assignee and optional data source, and return its link. For a follow-up to an existing health-report finding, use health-report's task flow instead.
---

If this follows an existing health-report finding, use [health-report](../health-report/SKILL.md) and its task-handling reference, preserving that report, scope and write authorization. Otherwise read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows the Home Assistant task creation flow.

1. **Site.** Reuse the company and site, or discover and ask. A task always belongs to one site.
2. **What.** If the user gave no description, ask “What is the task description?”. Draft a title of 2–6 words and a one-sentence description that stay very close to the user's wording. Do not invent facts, dates, owners, procedures, checklists or reasons.
3. **Who and how.** The web assistant assigns the creator. Offer that (`--assignee me`), another active site member (find IDs with `node ../health-report/scripts/health-report.mjs discover users --company-id ID --site-id ID`), or `none`. Priority defaults to medium; add `--due` (ISO with offset) or `--data-source-id` only when the user supplies them. For a task about a specific data source, resolve it with Show Data Sources.
4. **Preview.** Run `node ../../scripts/tasks.mjs create --company-id ID --site-id ID --title "…" --description "…" --assignee me|none|USER_ID --profile prod`. Show the draft, `notifies`, and any same-title open tasks in `duplicates` with links. Ask for confirmation: creating the task notifies its assignee.
5. **Create.** After a clear yes, rerun with `--apply`. Report `created` with the task link, or the `partial` / `already-done` outcome as the guided-actions reference describes. On `blocked: duplicate`, offer the existing task; add `--allow-duplicate` only if the user wants a separate one (plus `--allow-repeat` if this exact task was already created in an earlier run). An `unverified` result means the task exists but read-back did not confirm it: give the link and do not create it again.

Use browser sign-in and internal task APIs only. Never switch to an API key or a legacy public-API MCP tool when access is denied. On `blocked: authorization`, nothing was created: explain that task creation is not yet enabled for this sign-in and offer the handoff. Its prompt (`create task: <title> — <description>`) makes the web assistant create the task assigned to the user once they select the same site. Do not say a task exists or anyone was notified until `--apply` reports `created`.
