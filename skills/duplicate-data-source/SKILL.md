---
name: duplicate-data-source
description: Duplicate a Zira data source (Vision, Pallet QA, custom, form, sensor and other kinds) the way Zira web's Duplicate does, in the same site by default or in another site the user can change, and read the copy back. Use for "duplicate Saw 1", "copy Cam 1 Quality as Cam 2 Quality" or "copy this form to Plant 2". Use create-data-source for a new data source from a template, and show-data-sources to find existing ones.
---

Read [authorized browsing](../../references/browsing.md) and [guided actions](../../references/actions.md). This follows Zira web's data source Duplicate dialog: source → site → name → triggers → copy. The whole flow happens here; do not send the user to Zira's web assistant.

1. **Source.** Reuse the company and site. List data sources with `node ../../scripts/browse.mjs devices --company-id ID --site-id ID` and confirm the exact one by name when several match.
2. **Where.** The copy goes to the same site unless the user asks for another site. For another site, resolve it through authorized discovery (another company is allowed) and add `--target-site-id ID`, plus `--target-company-id ID` for another company.
3. **Name and triggers.** Suggest `<source> (copy)` unless the user named the copy. Triggers (alerts) are not copied unless the user asks; they copy only within the same company.
4. **Preview.** Run `node ../../scripts/data-sources.mjs copy --company-id ID --site-id ID --source-id ID [--name "…"] [--target-site-id ID] [--target-company-id ID] [--include-triggers] --profile prod`. Say what will be created and where, and read out `preview.notCopied` in plain words. A Vision or Pallet QA copy starts unpaired, without settings, models or datasets. For another site, say that Zira reuses metrics with the same name and unit there and creates the missing ones. If `duplicates` is not empty, ask for a different name.
5. **Copy.** After the user confirms, rerun with `--apply`. On `created`, give `url` and `channelUrl`: the site channel's Data Sources tab lists the copy. Relay `warnings`. On `unverified`, say it was copied but the read-back did not match, and link it so the user can check. For Vision or Pallet QA, offer setup-vision (`next`).

Say "channel", never "system". The copy is not added to sub-channels; the user can add it from the copy's page in Zira. On `blocked: authorization`, nothing was copied: give `handoff.pageUrl` (the source in Zira, then ⋯ → Duplicate). Other stops follow [guided actions](../../references/actions.md).
