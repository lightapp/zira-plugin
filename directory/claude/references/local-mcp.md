# Run Zira through its local MCP server

The declared `zira` MCP server runs on this computer. Use its tools for packaged Zira code.
Existing command examples in skills/references remain the CLI option specification: remove `node`
and the script path, put the first command in `command`, and pass the rest as separate strings in
`args`. Do not pass shell quotes, pipes, environment assignments or redirection. Use absolute paths
for user input/output files. The server does not accept arbitrary executables, scripts or HTTP routes.

For `node ../../scripts/browse.mjs sites --company-id 123`, call `inventory` with:

```json
{"command":"sites","args":["--company-id","123"]}
```

The host may prefix tool names, for example `mcp__zira__inventory`. Discover the tools of this
plugin's local server; do not substitute the separate remote Zira connector. If the server is absent
or fails to start, follow “If Zira's tools are missing” in [setup help](setup-help.md) and fix it with
the user in plain words (wrong app or tab, missing Node.js, new session needed); do not silently fall
back to shell execution or to clicking through Zira in a browser.
The standalone legacy health-report skill archive is a CLI-only artifact, not this MCP plugin.

| Helper in the existing recipe | Local MCP tool |
| --- | --- |
| `build-info.mjs` | `build_info` with `command: "show"` |
| `health-report.mjs auth status/login/logout/profiles` | `auth` with that auth command |
| `browse.mjs` | `inventory` |
| `tasks.mjs` | `tasks` |
| `preferences.mjs` | `preferences` |
| `data-sources.mjs` | `data_sources` |
| `dashboards.mjs` | `dashboards` |
| `dashboard-widgets.mjs` | `dashboard_widgets` |
| `ai-report.mjs` | `ai_report` |
| `vision.mjs` | `vision` |
| `datasets.mjs` | `datasets` |
| `remote.mjs` read commands | `live_view` |
| `health-report.mjs` other commands | `health_report` |
| `device-status.mjs` | `device_status` |
| `monitor.mjs` | `health_monitor` |
| `readings.mjs` | `readings` |
| `scheduled-report.mjs` | `scheduled_readings` |
| `trimsaw-sizes.mjs` | `trimsaw_sizes` |
| `calibration.mjs plan` | `trimsaw_calibration` |
| `evaluate.mjs` | `evaluate_model` |
| `sessions.mjs` | `snapshot_sessions` |
| `subset.mjs` | `subset_dataset` |
| `defects.mjs` | `find_defects` |
| Inspect Nail Images `runtime.mjs` and packaged Python analyses | `nail_images` |

Call a tool with `command: "help"` for its options. For preference updates, pass the JSON patch
as the tool's `input` object, not a shell heredoc. For `health_report` discovery, use
`command: "discover", args: ["users", "--company-id", "123", "--site-id", "456"]`.
For image analysis, use `nail_images` with `command: "run"` and args such as
`["--script", "inspect_rings", "--args", "[\"--input\",\"/absolute/input.json\",\"--output\",\"/absolute/new-report\"]"]`.
User-authored JSON specs/manifests can still be saved using the host's file tools. Browser navigation,
file previews, human review and activating a schedule use the host's corresponding facilities.

A call returns `status`, `stdout`, `stderr`, `exit_code` when finished, and a `job_id`.
While `status` is `running`, poll `job_status` with that ID. Browser sign-in can continue while you
poll; never read credentials or ask for tokens. Parse the helper's JSON in `stdout` and respect its
coverage, blocked/partial outcome and receipts. Exit 3/4 may carry useful incomplete/blocked data.
Do not repeat the original action to wait for it. A missing job after a server restart does not prove
that a write failed: reconcile saved receipts and Zira state before any new write.

All existing preview, authorization, scope, duplicate and read-back rules still apply. `--apply`
is only for an approved concrete change; dependency setup requires consent. The MCP server does
not grant permissions or retry writes. Production-only and `.pt` restrictions remain in public
builds. It intentionally exposes no camera-control, live calibration, Android development, raw
credential/token or arbitrary API tool. Internal developer workflows keep their documented private
entrypoints; they are not added to the public MCP surface.

Jobs keep bounded output in memory, expire after 30 minutes and stop on server shutdown. Save large
reports to their documented output files. Inspect saved results if output was truncated. Local
report/review servers explicitly started by helpers retain their existing idle/stop lifecycle.

Device Status also supports `command: "movement"` with company/site scope and `--days 7`
(or offset-qualified `--from`/`--to`), and `command: "acknowledge"` with the reviewed report path,
company ID, exact incident IDs and a note. Acknowledge previews by default; `--apply` saves only
local review receipts. Follow the Device Status skill's authorization and coverage rules.
