# Zira for Codex and Claude Code

Ask about production, check cameras, work with datasets and models, create reports,
and follow up on tasks from your AI chat. Sign in with your own Zira account;
you can access only the companies and sites your account permits.

This is Zira's public Git installation source (early access). It is separate from
the apps' official plugin directories.

## Install

**You don't type any commands. Claude or Codex installs Zira for you in about five minutes.**

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

No GitHub account, API key or terminal is needed. You see only the companies and sites your
Zira account can see. To update later, ask in the same place: **“Update the Zira plugin.”**

<details>
<summary>Manual installation commands</summary>

Requires Git, Node.js 20+ and a current Codex or Claude Code installation.

**Codex:**

```sh
codex plugin marketplace add lightapp/zira-plugin --ref preview && codex plugin add zira@zira
```

**Claude Code:**

```sh
claude plugin marketplace add lightapp/zira-plugin#preview && claude plugin install zira@zira
```

The plugin starts a local `zira` MCP server using Node.js. Approve the host's MCP connection when prompted. It runs the packaged tools on this computer and uses the same Zira browser sign-in. No npm install is needed for the server or Node.js helpers. Model evaluation optionally
installs its own Python dependencies when requested.

Prefer to click? Register the source with the first command above, then open the
app's plugin browser, choose the **Zira** source, open the **Zira** plugin and click **Install**.
In Claude Code, open `/plugin` and use its Marketplaces/Discover tabs to add
`lightapp/zira-plugin` and install Zira. There is no verified universal one-click
GitHub installation link for both clients.

</details>

If you already have an internal Zira plugin installed, disable that copy before
using this one so both copies do not answer the same requests. Both builds use `zira@zira`. Replace the configured Zira source when switching;
follow [the switching guide](references/distribution.md) to preserve Claude settings
and saved data. Do not install both copies.

## Updates and specific versions

Each released version gets an immutable `vVERSION` tag. Preview versions update
`preview`; approved stable versions update `stable`. There is no stable release yet. Updating this repository does not immediately update every person's installation.

```sh
# Codex
codex plugin marketplace upgrade zira && codex plugin add zira@zira

# Claude Code
claude plugin marketplace update zira && claude plugin update zira@zira
```

Start a new chat afterwards. Claude Code also offers marketplace auto-update in
`/plugin` → Marketplaces (enable it for Zira if desired).

To pin a version on a fresh installation, add the marketplace with
`codex plugin marketplace add lightapp/zira-plugin --ref vVERSION` or
`claude plugin marketplace add lightapp/zira-plugin#vVERSION`, replacing VERSION
with an existing tag, then run the matching plugin install command above.
For an existing installation, use the marketplace manager to remove/re-add the
source at that tag; preserve your saved data. Use the same method to roll back.

## What is included

Onboarding, device status, health and production reports, scheduling, site and
data-source discovery, tasks, dashboard creation and copying, forms, Vision setup,
dataset navigation, model evaluation, dataset subsets and human-reviewed defect search.
Offline Inspect Nail Images bundles its OpenCV tool. Public model evaluation supports
`.tflite` only. Claude Code includes the Device Status panel with manual refresh.
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

Assume the user is not technical. Follow [setup help](references/setup-help.md) for tone and
for everything beyond the plugin itself: which app and tab to use, installing Node.js or Git
for them, and what they will see. Never ask them to type commands; tell them what to click.

1. **Identify the current host.** Install only in the Codex or Claude Code app the user
   is using, even if both clients are installed. Use host context; ask which app only if
   it is unclear. Confirm you have access to the user's computer, not just a remote/cloud
   sandbox. Claude's Chat and Cowork tabs, web chats and cloud sessions cannot install or
   run Zira, even when they can see a folder. There, stop and give the steps from setup
   help's “Where Zira works” for their app (for the Claude desktop app: click **Code**,
   start a new session, paste the same message). Do not claim a cloud install reaches their computer.
2. **Check prerequisites and existing state.** Check Git, Node.js 20+ and the host's
   supported plugin commands. Use `codex plugin list --json` and
   `codex plugin marketplace list --json`, or the corresponding `claude` commands.
   If Node.js or Git is missing or too old, explain it in one plain sentence and, once the
   user agrees, install it for them as setup help describes; then continue. If a plugin
   command is unavailable, check the host's supported installation tools or plugin UI and
   walk the user through the specific missing click. Do not invent executable paths, edit
   client configuration files by hand, or install anything without the user's agreement.
3. **Select the source.** The public source is `lightapp/zira-plugin`, branch `preview`,
   identity `zira@zira`. For a fresh installation, run the matching commands in
   [Manual installation commands](#install) above. Use the current user's scope.
   If this exact source is already configured, refresh it with the matching commands in
   [Updates and specific versions](#updates-and-specific-versions); install the plugin if
   the source exists but the plugin is not installed. If a different Zira source or a pinned
   version is configured, explain the difference and resolve the user's intended switch
   before replacing it. Follow [the switching guide](references/distribution.md) to preserve
   settings and saved data. Never delete credentials, reports or schedules, and never leave
   two enabled Zira copies. Respect the app's permission prompts and managed installation policies.
4. **Verify the installed copy.** Read the host's plugin listing again; confirm `zira@zira`
   is installed and enabled. Resolve its actual installed path from the host's result and run
   `node <installed-plugin-root>/scripts/build-info.mjs`. Confirm public audience, preview
   channel and the version/source commit recorded in the selected source's `release.json`.
   Do not report success from a downloaded repository or an exit code alone. If a check
   fails, explain what remains and help resolve it; do not start sign-in or account operations
   just to prove installation.
5. **Finish in plain language.** In a few short lines and no technical terms: Zira is
   installed (version in passing); start a **new** session in this same place and say
   “Help me get started with Zira”; the first time, they click **Allow** and sign in to Zira
   in the page that opens. Then, on its own line, where to find Zira every time, in setup
   help's wording for their app (for the Claude desktop app: “Whenever you want Zira, open
   the Claude app, click **Code** and start a new session. Chat and Cowork can't see your
   Zira data.”). Mention any remaining click or restart. Installation itself does not sign
   in, create tasks or activate schedules.

Installation references: [Codex](https://developers.openai.com/plugins/build/plugins),
[Claude Code](https://code.claude.com/docs/en/discover-plugins).

## Data handling and local execution

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
