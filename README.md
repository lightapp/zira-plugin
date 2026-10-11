# Zira for Codex and Claude Code

Ask about production, check cameras, work with datasets and models, create reports,
and follow up on tasks from your AI chat. Sign in with your own Zira account;
you can access only the companies and sites your account permits.

This is Zira's public Git installation source (early access). It is separate from
the apps' official plugin directories.

## Install

**Ask your agent to install it. You do not need to open a terminal.**

1. Open a local chat in **Codex** or **Claude Code** on your computer.
2. Copy the prompt below, paste it into the chat and send it.
3. Approve any installation permission the app requests. When the agent confirms
   installation, start a new chat and say **“Help me get started with Zira.”**

```text
Install the Zira plugin for the app I am using from https://github.com/lightapp/zira-plugin. Read its README and follow the “For agents: install Zira” instructions. Do the installation for me, preserve any existing Zira settings and data, and verify that it worked. I do not use the terminal; guide me through any clicks or permissions you need.
```

You can also simply send your agent: **“Install this plugin for me:
https://github.com/lightapp/zira-plugin”**. Include the install request when sharing
the link so the agent knows what you want it to do.

Use a local chat that can make changes on your computer. A regular Claude or ChatGPT
web chat cannot install this plugin on your computer. Your agent will check the
required software and explain any setup needed. No GitHub account, private repository
access or API key is needed. Sign in with your own Zira account when you first use Zira.

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

No npm install is needed for the plugin's Node.js helpers. Model evaluation optionally
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
The exact installed skill inventory is in [`skills`](skills).

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

1. **Identify the current host.** Install only in the Codex or Claude Code app the user
   is using, even if both clients are installed. Use host context; ask which app only if
   it is unclear. Confirm you have access to the user's computer, not just a remote/cloud
   sandbox. If local execution is unavailable, explain how to open a local Codex or Claude
   Code chat and reuse the same prompt. Do not claim a cloud install reaches their computer.
2. **Check prerequisites and existing state.** Check Git, Node.js 20+ and the host's
   supported plugin commands. Use `codex plugin list --json` and
   `codex plugin marketplace list --json`, or the corresponding `claude` commands.
   If a command is unavailable, check the host's supported installation tools or plugin UI;
   help the user through the specific missing setup. Do not invent executable paths,
   edit client configuration files by hand, or silently install system dependencies.
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
5. **Finish in plain language.** Report the installed version and ask the user to start a new
   chat and say “Help me get started with Zira.” Explain any remaining clicks, restart or
   missing prerequisite. Installation itself does not sign in, create tasks or activate schedules.

Installation references: [Codex](https://developers.openai.com/plugins/build/plugins),
[Claude Code](https://code.claude.com/docs/en/discover-plugins).
