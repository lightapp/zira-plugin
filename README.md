# Zira for Codex and Claude Code

Ask about production, check cameras, work with datasets and models, create reports,
and follow up on tasks from your AI chat. Sign in with your own Zira account;
you can access only the companies and sites your account permits.

This is Zira's public Git installation source (early access). It is separate from
the apps' official plugin directories. Requires Git, Node.js 20+ and a current
Codex or Claude Code installation on the computer running the plugin.

## Install

**Codex — paste into Terminal:**

```sh
codex plugin marketplace add lightapp/zira-plugin --ref preview && codex plugin add zira@zira
```

**Claude Code — paste into Terminal:**

```sh
claude plugin marketplace add lightapp/zira-plugin#preview && claude plugin install zira@zira
```

Start a new chat and say **“Help me get started with Zira.”** No GitHub account,
private repository access, API key or npm install is needed for this public source.
Model evaluation optionally installs its own Python dependencies when requested.
Use a local Codex or Claude Code session; ordinary cloud chat is a different installation.

Prefer to click? Register the source with the first command above, then open the
app's plugin browser, select **Zira**, select **Zira**, and click **Install**.
In Claude Code, open `/plugin` and use its Marketplaces/Discover tabs to add
`lightapp/zira-plugin` and install Zira. There is no verified universal one-click
GitHub installation link for both clients.

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

Installation references: [Codex](https://developers.openai.com/plugins/build/plugins),
[Claude Code](https://code.claude.com/docs/en/discover-plugins).
