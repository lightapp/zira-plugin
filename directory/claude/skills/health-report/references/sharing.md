# Dashboard and hosted sharing

Every report includes `report.html`: KPI cards, status colors, linked device names,
search and category filters. Device rows split issues, power/temperature, network,
and camera/error indicators into compact columns, with accessible labels and full
status under expandable Details. It is a snapshot, not a live connection. Deliver the
local dashboard with the summary by default; offer a hosted link once when none
exists. A `file://` URL works only on the generating computer. Attachment previews
may block JavaScript: the full table still renders, but search/filtering requires
opening the downloaded HTML in a browser or a hosted HTTPS page.

## Destination and audience

Reuse the user's chosen destination and audience. If missing, ask where to host
and who should see the report, offering available hosting tools. Reports contain
customer inventory and device status. Permission to check health is not permission
to publish it. A public choice applies to this report/site, not other users or
future monitors. Do not make public hosting the default. A private owner-only page
is not a link a teammate can use. Follow the host's access controls for recipients.

When hosting is unavailable, deliver the local file and explain the missing
hosting connection. Do not promise a hosted link to every installation: Codex and
Claude Code may expose different tools. Never use a chat-share link, Drive preview,
or a raw repository-file URL as a substitute for a functioning dashboard page.

## Prepare only the report for hosting

Run from the installed skill, using private paths outside the plugin/repository:

```sh
node scripts/health-report.mjs prepare-share --report /private/report/report.json --out /private/report-site
```

This local-only command regenerates `dist/index.html` from the report, writes
`.openai/hosting.json` with `{"static":{"directory":"dist"}}`, and records the
monitor identity in `.openai/health-report.json`. It preserves an existing
`project_id` and manifest fields when reusing that monitor's prepared directory.
It rejects unrelated nonempty directories or another monitor's output directory.
It does not collect data, publish, create credentials, or grant access.

Only `dist/index.html` is served. Never copy the whole report directory, monitor
configuration, state, task ledger, credentials, or production data into the plugin's
source/distribution. Keep the prepared site directory separate from the tool repo.

## Sites workflow, when its tools are available

Use current Sites hosting skill/tool instructions; the following details avoid
common packaging failures. Other hosting providers should use their own workflow.

1. Read `.openai/hosting.json`; reuse its `project_id`. Create a site once only if
   absent, then atomically persist the returned opaque ID. Do not recreate it on a
   failed upload. Keep short-lived repository tokens in memory, never in files,
   logs, or committed Git remotes.
2. Commit and push the exact prepared source to the source repository/branch
   returned by Sites. Its HTTP-extra-header credential uses `Authorization: Bearer`
   without persisting that header in Git configuration. The manifest's `static`
   value is an object with `directory: "dist"`; do not add a `version` field.
3. Package only `.openai/hosting.json` and `dist/` from that pushed commit, e.g.
   `git archive --format=tar.gz -o /private/site-deploy.tar.gz HEAD .openai/hosting.json dist`.
   Save a version using the exact pushed commit SHA and archive. Save is not publish.
4. Set the user-authorized audience using Sites access tools; preserve the current
   audience when refreshing a report. Use the appropriate private/public deployment
   tool for that audience with the returned saved-version ID. Poll a nonterminal
   deployment until success or a concrete failure. Do not claim an expected URL is live.
5. Verify the resulting HTTPS page and saved access mode. For public links, check
   an unauthenticated request. For restricted links, verify the selected recipients
   or groups; do not broaden access to fix a failed access test.

## Verify and deliver

In a browser, check the default Needs check selection (All devices if none need
attention), choose All devices, search for an existing site/device, confirm matching
rows/counts, clear the search, then test a category card. Search intersects the
selected card; explain that if a user cannot find a device outside that category.
Return the page to its initial view. If controls do not work, inspect script errors
and the host's Content Security Policy; a readable static table alone is not proof
that the interactive page works.

Return the verified HTTPS link prominently, with the audience and snapshot time.
Data-source links still require the recipient's own Zira access. State explicitly
that this is a snapshot. Keep the same hosting project for authorized refreshes;
regenerating a local report does not update the hosted page. Scheduling a report
alone does not authorize publishing later reports: save a recurring publishing
choice separately if the user requests it.
