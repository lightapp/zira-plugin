# Scheduling Zira reports on the host

The scheduling skills save a job on this computer and print a **handoff**: a self-contained `prompt`, the schedule in the site's time zone (`when`), the same time as cron in this computer's zone (`hostCron`, `hostZone`), `nextRun` and, when the two zones change clocks on different dates, a `note`. The handoff creates nothing. Only the host's scheduler does, and only after the user confirms the time.

## Where the job must run

Scheduled Zira reports use this computer's Zira browser sign-in, the local readings cache and the saved job. Run them with a **local** scheduler on this computer:

| Host | Use | Do not use |
| --- | --- | --- |
| Claude desktop app (Code tab) | The scheduled-tasks tool (`create_scheduled_task` with `cronExpression` = `hostCron`, `taskId`, `title`, `description`, `prompt`; then `list_scheduled_tasks`) | Cloud routines (`/schedule`): they run elsewhere without this sign-in |
| Codex app | A local automation with the same prompt, at `hostCron` local time | A cloud task |
| Claude Code CLI only | No local scheduler: offer the desktop app, or a system scheduler the user sets up themselves (`cron`/`launchd` running `claude -p "<prompt>"`), and say the job is not active until they do | Claiming it is scheduled |

Desktop scheduled tasks run while the app is open; a run missed while it was closed starts on the next launch. Tell the user this. The computer must be on, and the Zira sign-in valid: when it expires, a run stops and asks the user to sign in again.

## Steps

1. Confirm the frequency (`daily`, `weekdays`, `weekly` + day), time and IANA time zone. Default to the site's zone; for sites in several zones, offer one job per zone or one time in a named zone.
2. Run the skill's schedule step and show `when`, the computer-local time, `nextRun` (in the site zone) and any `note`.
3. Create the job with the host tool, or update the existing one with the same `taskId`. Never create a second job for the same saved name.
4. List the host's jobs and confirm the task ID, schedule and next run. Only then say it is scheduled.
5. Offer "Run now" once (the host's run-now action, or the skill's `run` command) so the user sees the first result.

Changing or stopping: update or delete the host job (`update_scheduled_task`, or the Codex automation), then update or `remove` the saved job. Removing the saved job alone leaves a host job that will fail.

A scheduled run is unattended: it must not ask questions, broaden scope, create tasks, publish to a new place or share data. It reports sign-in, rate-limit (HTTP 429 with the retry time) and coverage problems instead of working around them.
