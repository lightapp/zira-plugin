# Task follow-up and scheduling

## Task credentials and preview

Task endpoints use browser sign-in and internal APIs, through the same credentials as device reads. Pass `--profile prod|integ` consistently; the selected profile must match the report's `sourceProfile`. A legacy report without an environment must be rerun before live task handling. No API key, key file or public-API MCP fallback is supported. A 401/403 requires sign-in or backend authorization work; do not switch credentials to bypass it.

`tasks --config FILE --report FILE --profile integ` reads existing tasks before proposing writes. Explicit `--offline` returns local drafts with `duplicatesChecked: false` and needs no sign-in; it cannot be combined with `--apply`. `--apply` performs the agreed writes, with a persistent `--ledger` (default alongside config). The engine checks report/config identity and authorized site membership, requires a fresh report, revalidates device ownership, verifies the assignee through authenticated site-member discovery and reads tasks back after creation. Assignees/followers are notified by the API. Resolve a failed ownership check instead of bypassing it.

Assignee discovery uses `discover users --company-id ID --site-id ID --profile integ`. Task routes and site-member access must accept the agent's browser-login client before live handling works. Mock tests verify the client contract; the internal pilot has not exercised live task writes.

One incident marker and ledger prevent repeat tasks. A ledger is bound to its environment; old nonempty ledgers without an environment are treated as production because the previous public task path supported only production. Use a separate ledger for integration. Existing device tasks without an exact marker are returned for review so the agent can reuse relevant work. Reconciliation is required after timeouts, uncertain writes, missing previously linked tasks or duplicate markers. Never clear the ledger merely to retry. A local lock protects one state directory only; multiple hosts need one coordinated runner/state store before fleet-wide automatic task creation.

The task client refreshes credentials before sending writes and never automatically replays POST or PUT, including after 401. A rejected or uncertain write stops the remaining batch. Earlier accepted writes remain recorded. Read-back failures preserve the task ID where available, so resolve that outcome instead of recreating the task.

`update-task --task-id ID --site-id ID --patch FILE --profile prod` previews description/priority/due-date changes, converting the patch into the internal `PUT /tasks/{id}` schema. Add `--apply` for an authorized update and verify read-back. Preserve prior description when appending evidence. Reassignment and completion are not implemented here; task completion must honor human work/acceptance criteria. An HTTP acknowledgement does not resolve the health finding.

## Fix handling

The package can collect/recheck data and manage follow-up work. No hardware remedy is implemented. Use only other documented, available tools for actions already authorized by the user, and show a concrete blocker where a required capability is absent. Do not fake a device repair by writing its status, widening limits or suppressing a finding. For physical checks create an assigned task with observed evidence, qualified cause, suggested action and recovery criteria.

## Schedule handoff

A schedule in the saved config looks like:

```json
{"frequency":"daily","time":"15:00","timezone":"America/Chicago","delivery":"changes-only","allowTaskWrites":false}
```

After an unscheduled on-demand report, the skill offers this once with a concrete default time and timezone. The user's confirmation, not the offer, authorizes creating the job. Ask which timezone “3 pm” means. For 3 pm at each site, group sites by IANA timezone and use separate saved configurations/jobs, presented as one user request. Do not silently use the developer computer's timezone. Only add `allowTaskWrites: true` when recurring automatic tasks are explicitly authorized. `draft` produces task proposals at each run for later review; it does not stop unattended execution to ask.

Run `schedule --config FILE` to produce the prompt and timing for the host. In Codex use the available native automation tool, following its current schema; prefer updating an existing monitor schedule and a same-conversation heartbeat where supported. In the Claude desktop app use its local scheduled tasks (they run on this computer, with its Zira sign-in); a cloud routine (`/schedule`) runs elsewhere without that sign-in and the saved state, so it does not fit. These are host capabilities, not CLI API calls. Inspect and verify the saved schedule/next run; never claim the handoff file scheduled anything.

A local runtime needs the computer/app running. A hosted runtime needs this package, private saved config/state, approved network access and unattended credentials available there; a local login does not transfer automatically. Confirm the actual client's scheduling/plan capability. If any prerequisite is missing, keep run-on-demand working and clearly mark scheduling as not activated. Scheduled runs must not broaden remediation authority or recipients. Report execution failures and incomplete coverage. Changes-only delivery stays quiet for unchanged/non-actionable state.
