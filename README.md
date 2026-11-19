# Zira for Codex and Claude Code

Ask about production, check cameras, work with datasets and models, create reports,
and follow up on tasks from your AI chat. Sign in with your own Zira account;
you can access only the companies and sites your account permits.

This is Zira's public installation source (early access). It is separate from
the apps' official plugin directories.

## Install

**You don't type any commands. Claude or Codex installs Zira and its helpers for you.**

1. **Open the right place.** Zira runs on your computer, so it only works here:
   - **Claude desktop app:** click **Code** (next to Chat and Cowork) and start a new session.
     Pick any folder, such as Documents, and keep it on this computer (**Local**).
   - **Codex app:** start a new thread that runs on this computer (**Local**), not a Cloud task.
2. **Paste this message and send it:**

   ```text
   Install the Zira plugin from https://github.com/lightapp/zira-plugin for the app I'm using. Read its README and follow "For agents: install Zira". I'm not technical: do everything for me, including any helper programs Zira needs, explain each step in plain words and tell me exactly what to click. Keep my existing Zira settings.
   ```

3. **Click Allow** when asked. If your computer needs a free helper program called Node.js,
   your assistant offers to set it up for you: you just click through a standard installer.
4. When it says Zira is installed, **start a new session in the same place** and say
   **“Help me get started with Zira.”** A Zira sign-in page opens the first time; sign in as usual.

> **Every time you use Zira, come back to the same place:** the **Code** tab in the Claude app,
> or a Local thread in Codex. Claude's Chat and Cowork tabs, claude.ai in a browser and ChatGPT
> can't see your Zira data. There, the assistant may try to click through Zira in a browser,
> which is slow.

No Git, GitHub account, API key or terminal is needed. You see only the companies and sites your
Zira account can see. To update later, ask in the same place: **“Update the Zira plugin.”**

## Updates

Zira checks for a newer release when you use it, and tells you what changed. Say **“Update Zira”**
and your assistant downloads the new public ZIP, verifies it and updates your installation.
Your sign-in, preferences, reports and schedules stay in place. Start a new local chat afterwards.
Older installations need one update to receive these notices. There is no background installation
or notification while your AI app is closed. Checks use public release metadata, with no Zira account data.

Each release has an immutable `vVERSION` tag. Preview updates stay on `preview`; approved stable
updates stay on `stable`. There is no stable release yet. ZIP installations do not automatically
fetch the next ZIP through the host's marketplace updater. Use the chat update flow.

For a deliberate source or channel switch, follow [the switching guide](references/distribution.md).
Both public and internal copies use `zira@zira`; never leave two enabled copies.

<details>
<summary>Manual installation commands after downloading the ZIP</summary>

Download a published version ZIP from [Tags](https://github.com/lightapp/zira-plugin/tags), verify
its `release.json` hashes and extract it into a persistent user-owned folder. Keep hidden files.
Register that extracted folder, replacing PATH below with its absolute location:

```sh
# Codex
codex plugin marketplace add "PATH"
codex plugin add zira@zira

# Claude Code
claude plugin marketplace add "PATH"
claude plugin install zira@zira
```

For an update, download and verify the next ZIP, preserve the previous source for rollback,
and replace the contents of the same persistent source folder. Then use `codex plugin add zira@zira`,
or `claude plugin marketplace update zira` followed by `claude plugin update zira@zira`.
Codex's `marketplace upgrade` requires a Git source and must not be used for this ZIP setup.
Verify the installed build and start a new session. These commands do not install Node.js or Python;
the guided setup includes their installation and the separate public analysis packages.

</details>

## What is included

This marketplace holds two plugins that share one Zira sign-in. Install only what you use.

| Plugin | For | Includes |
| --- | --- | --- |
| **Zira** (`zira@zira`) | Everyone | Onboarding, device status, health and production reports, scheduling, site and data-source discovery, tasks, dashboard creation and copying, forms, Vision setup, dataset navigation and trimsaw size checks. Needs Node.js only. Claude Code includes the Device Status panel with manual refresh. |
| **Zira Vision** (`zira-vision@zira`, in [`plugins/zira-vision`](plugins/zira-vision)) | AI vision teams | Model evaluation, dataset subsets, human-reviewed defect search and offline Inspect Nail Images with its bundled OpenCV tool. Adds Python. Public model evaluation supports `.tflite` only. |

Add Zira Vision next to Zira with `claude plugin install zira-vision@zira` or
`codex plugin add zira-vision@zira`, or tick it on <https://help.zira.us/ai-plugins>.
Public builds use the production Zira environment.
The separately generated Claude directory candidate is in `directory/claude`. It keeps all public skills and local MCP tools, but omits the startup hook and optional panels. Root Git installations keep those features. Neither package is a directory approval.
The exact installed skill inventory is in [`skills`](skills). Skills invoke the declared local MCP server for packaged actions; [tool usage and job handling](references/local-mcp.md) describes the interface. The separate remote Zira MCP service is not required. The Claude panels and session-start hook retain their documented local execution paths.

Installing does not grant Zira access, create tasks, activate schedules or change devices.
Some actions depend on your account permissions and enabled server APIs; unavailable
steps explain the limitation or open the relevant Zira page. Early-access distribution
does not imply that all live workflows or server-side quotas have been verified.

## Share and get help

Share [this repository](https://github.com/lightapp/zira-plugin), its
[installation steps](https://github.com/lightapp/zira-plugin#install), or a specific
version from [Tags](https://github.com/lightapp/zira-plugin/tags).
Learn more at [Zira](https://zira.us) and [Zira Help](https://help.zira.us/docs).
Do not include customer data, credentials or private reports in GitHub issues.

This repository is generated from Zira's maintained plugin source. Release updates
replace its generated contents; propose changes through the Zira team.
Zira retains all rights; this is publicly available source, not an open-source license.
See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

## For agents: install Zira

Use these steps when the user asks to install Zira from this repository. A bare link
without an installation request is not permission to change the user's computer.
Carry out the setup with your available local tools; do not just give the user shell commands.

Assume the user is not technical. Follow [setup help](references/setup-help.md) for tone and app
selection. Do the work with host tools; never require the user to type commands.

1. **Use the current local host.** Install in the selected Codex or Claude Code client only.
   Web/cloud chats cannot install on the user's computer. Use the Code tab in Claude desktop.
2. **Check existing state.** Read native plugin/marketplace lists. Preserve existing Zira settings,
   credentials, reports, schedules and runtime environments. Explain a source switch; do not
   replace an internal/managed source or a pinned channel without authorization.
3. **Use the public ZIP, without Git.** Read the selected channel's public `build.json`, confirm
   public audience, clean source, production-only profiles, no .pt support and the expected channel.
   Download `https://github.com/lightapp/zira-plugin/archive/refs/tags/vVERSION.zip`, substituting the
   validated published version. Extract safely to staging, rejecting traversal, absolute paths and
   symlinks. Check the release identity and all `release.json` file hashes before running code.
   Put the complete extracted package in a persistent user-owned folder, such as
   `~/.zira/plugins/public/preview/current`, outside Downloads/temp/plugin caches. Register it with
   the selected native marketplace manager and install `zira@zira`, using the commands above.
4. **Prepare all helpers.** Install a supported Node.js LTS (20+) and compatible Python (3.12 is
   tested) from official sources if missing. Use each installed public helper's documented setup:
   model evaluation, Inspect Nail Images and trimsaw camera-view check (`scene-setup --confirm`).
   Keep all three pinned environments separate and outside the plugin cache. No npm install or
   PyTorch/.pt support. A full-setup request authorizes these helpers; honor OS approval prompts,
   never ask for passwords in chat and never bypass IT protections. Report unsupported dependencies.
5. **Verify and begin.** Read the actual installed path/version and `scripts/build-info.mjs`, check
   the public identity against the selected release, MCP startup and helper readiness. If tools
   are loaded, start getting-started: browser sign-in, the user's priority and one useful read-only
   first task. Otherwise give the exact new-session/restart step and this continuation:
   “Finish my Zira setup, check any pending dependencies, and help me get started.” Do not create
   tasks, change devices, publish reports or start schedules as an installation test.

For updates, use `plugin_updates` with `command: plan` (or `node scripts/plugin-updates.mjs plan`)
and carry out its native ZIP procedure after authorization. It prepares a plan; the host assistant
performs the update. Keep the previous source until the installed version is verified.

Installation references: [Codex](https://developers.openai.com/plugins/build/plugins),
[Claude Code](https://code.claude.com/docs/en/discover-plugins).

## Data handling and local execution

Public installations check GitHub release metadata at most once a day per local cache, with a short
timeout. The request contains no Zira account or customer data. It downloads no executable code.
Checks are skipped for internal and directory builds; set `ZIRA_CHECK_UPDATES=0` to disable them.

Zira runs packaged Node.js helpers on your computer. Browser sign-in uses Zira's
Cognito domain (`https://zira.auth.us-west-2.amazoncognito.com`); API requests go to
`https://api.zira.us` using your Zira account. Requested readings, images and datasets
may download from presigned object-storage URLs without forwarding the API token.
Live data uses Cognito Identity and short-lived AWS credentials for Zira's AWS IoT
service. Video opens on Zira's web live page.

Sign-in tokens are stored outside the plugin folder, by default in
`~/.config/zira/credentials.json`, with private file/directory modes where supported.
This is file-based storage, not keychain encryption. Reports, preferences, datasets,
review decisions and schedule configuration also remain outside the plugin cache.
Signing out removes the local credential profile; it does not delete those files,
cancel host schedules or promise remote token revocation. Remove unwanted outputs
and cancel schedules in their owning host. Selected results can enter the AI chat
and are subject to that host's data controls. See [Zira's privacy policy](https://zira.us/privacy)
and [support documentation](https://help.zira.us/docs).

Python image/model dependencies are installed separately only when needed. Public
builds do not enable `.pt`/Ultralytics setup. Report/review pages use loopback servers;
they can contain customer data. Sharing to a hosting service, recurring schedules,
task writes and AI-report email schedules are separate user-requested actions.
Installation alone does not publish reports or schedule work.

### Claude panel and hook review notes

The Device Status panel launches the packaged `node scripts/fleet.mjs` with explicit
company/site arguments to fetch requested read-only status. The Live panel launches
`node scripts/remote.mjs watch` with camera/scope arguments and consumes JSON lines
while the panel is open. Commands use argument arrays. Public builds disable automatic
panel refresh. These helpers use Zira authentication and the API/IoT destinations above;
they do not upload conversation transcripts. The mod accesses panel state and the
arguments of its targeted tool; it contains no conversation-fetching calls.

The mod handles only its own `mcp__zira__live_panel` tool to open the Live pane and
return the pane result. Its command hooks open Zira's own panels. The session-start
hook runs `node scripts/session-start.mjs` for local welcome/default context; it does
not log in over the network automatically. If Node.js cannot run, the hook prints the bundled
`hooks/needs-node.json` notice instead, so the user is offered help installing Node.js. OpenAI directory ZIPs omit Claude hooks
and panels while retaining the same public skill/runtime selection.

ECharts is vendored for offline report charts, with its version/hash in the bundled
vendor README and license in `THIRD_PARTY_NOTICES.md`. Vendor download instructions
are source-maintenance provenance; opening a report does not execute them. Zira owns
the plugin brand; the public repository address is the existing publisher account,
not a claim of affiliation with another marketplace listing.

Product terms: <https://zira.us/terms.html>. Zira retains service records created through the plugin
for longer than 30 days, according to the customer agreement and privacy policy. Local files
remain under the user's control until removed.
