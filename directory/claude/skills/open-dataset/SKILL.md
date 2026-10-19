---
name: open-dataset
description: Open a Zira Vision or Pallet Vision dataset for annotation, or its versions, models, training or validation, in Zira with the context filled in. Finds the site and camera by name and lets the user choose the data source, dataset, version and model. Use for requests like "open Example Manufacturing's Cam 1 Quality dataset for annotation", "annotate the cam 2 dataset", "which dataset versions/models do we have", or "open the models"; to score a model on a dataset use evaluate-model; not for device setup, fleet health or offline image analysis.
---

Use the [local MCP tools](../../references/local-mcp.md) for the packaged commands below. The command examples describe arguments; invoke the corresponding MCP tool instead of running them in a shell.

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This skill only reads and builds links. It never runs a model, changes labels or publishes edits.

Run every command from this skill's directory as `node ../../scripts/<helper>.mjs …`, with the same `--profile` throughout (production; integration is available only in internal builds).

Ask the user to choose at each step below with the host's choice UI, as described in browsing.md → "Asking the user to choose": Claude Code's `AskUserQuestion`, or Codex's `request_user_input` when it is listed. Pass the helper's `question` object as is and continue with the chosen option's `value`. A typed answer is a name or part of one: rerun with it (`--source`, `--name` or `--dataset`). When there is exactly one match (no `question`), say which one you are using and continue. Don't ask again for something the user already said, and don't print the choices as a numbered list.

Show, then work: as soon as the data source is known, open its most relevant page (the dataset page when one is named, otherwise the Datasets tab) with the host's browser tool, then continue resolving; switch the page when the user picks something else.

1. **Data source.**
   - **From a link.** If the user pasted a Zira link (a `/data-sources/ID` page or a `/vision-hub/dataset?…` page, including `http://localhost:PORT` from a local zira-web), pass it as `--url` to `datasets` and `open`. It sets the data source, profile and web origin.
   - **From names**, as in "Example Manufacturing's Cam 1 Quality". Run one command: `datasets.mjs find --place "Example Manufacturing" --source "Cam 1 Quality"`. The place can be a company or site name; the source matches by name or by its words. One match returns `chosen` and its `datasets` (go to step 2 with that data). Several matches return `items` with a `question`: ask it. `too_broad` returns a site `question`: ask it, then rerun `find` with the chosen site name. `available` lists the site's sources when the camera name didn't match.
   - **No names**: reuse a company, site and data source already known in the conversation, or ask for the customer/site and camera.
   - Don't search the local disk, the repository or other tools for Zira datasets; they live only in Zira.
2. **Dataset.** Use `find`'s `datasets` when present, otherwise run `datasets.mjs datasets --url LINK` (or `--device-id ID`).
   - Ask the dataset `question`: the three newest datasets, each with its version count and latest version date. Say in one line how many datasets there are (`totals.datasets`).
   - If the user types a name or part of one, rerun `datasets --name TEXT` and ask again from its `question`, or use the single match.
   - A dataset with no version yet doesn't appear (`notReadableHere`). If the user names a dataset that isn't listed, use their name anyway and say it wasn't checked.
   - Never say the list is complete, and never report image counts or annotation progress as zero.
3. **Version or model, only when it matters.** For training or evaluation questions, rerun `datasets --dataset NAME` and ask its `versionQuestion` (if the user's version isn't there, it may be among `otherVersions`, the merge results and staged copies), then ask the `modelQuestion`. It lists models trained on this dataset first, then ones with the same classes; each option says which. When the user already named the model ("the newest"), don't ask: resolve it, but still apply step 5's class check. Pass the chosen values as `--version ID` and `--model ID`. For annotation, versions don't matter: the dataset page always shows the current images.
4. **Open.** Run `datasets.mjs open --device-id ID --view dataset --dataset NAME` to annotate. Other views are `datasets`, `models`, `training`, `validation` and `evaluate`.
   - When the user asked to open it ("open …"), open the returned `url` with the host's own browser tool when it has one (for example the Claude desktop app's built-in browser), so the user sees it in this app. Use `--launch` (the system default browser) only when there is no such tool or the user asks for their own browser. Otherwise give the `url`.
   - Say "opened dataset X" only after a browser tool or `--launch` (`launched: true`) actually opened it; otherwise say "here is the link".
5. **Evaluation.** For "evaluate" or "how good is this model" requests, follow the `evaluate-model` skill: it opens the Models page first, checks the model's classes, and runs the model on the version's images on this computer. Never present opening pages or Zira's recorded training metrics as an evaluation.

Opening a page never means a model ran, labels changed or anything was published. Setup progress uses setup-vision. Offline nail/ring image analysis uses inspect-nail-images.
