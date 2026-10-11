# Zira installation, prerequisites and build identity

Use a local Codex or Claude Code session with filesystem and shell access and Node.js 20+.
Ordinary chat without a local execution environment can explain workflows but cannot run these
scripts or the browser sign-in callback. No npm install is needed for the Node.js helpers.

Before starting, run `node scripts/build-info.mjs` from the loaded plugin root. From a skill,
use `node ../../scripts/build-info.mjs`. Report the version, channel, audience and source commit;
`pluginRoot` identifies the actual copy being used. A source checkout reports `channel: local`.
An artifact records `preview` or `stable`, its skill inventory and distribution restrictions.
`sourceDirty: true` means the artifact includes local changes beyond its recorded commit.
Packaging is not release approval: `releaseApproved: false` is intentional until the separate
security, licensing and directory checks are complete. These candidates are for acceptance testing.

## Before using a feature

| Feature | Required setup | If unavailable |
| --- | --- | --- |
| Zira account data and actions | Node.js 20+, browser sign-in with your own account, authorized company/site/action access | Run Health Report `auth status` then `auth login`; for a denied route explain the denial and use the supported Zira web page. Installation grants no new permissions. |
| Model evaluation, subsets and rare-defect review | Local Python 3.10+, the feature's separate pinned environment, supplied local files or permission to download Zira files | Run Evaluate a Model `status` first. Ask before `setup` downloads packages. Public builds support `.tflite`; `.pt` is not released. |
| Inspect Nail Images | Local images with nail regions; Python 3.10+ (3.12 tested); separate pinned OpenCV/NumPy environment | Run the skill's `node scripts/runtime.mjs status`, then explicitly requested `setup --python PATH`. The tool/assets are bundled. No private GitHub or Zira account is needed for offline analysis. |
| Scheduled reports | A supported host scheduler and a computer available at run time, plus report permissions | Follow the scheduling reference; explain the host, how to inspect/stop jobs and that installation creates no jobs. |
| Device Status panel | Claude Code with mod support | Use the Device Status skill when a panel is unavailable. Public builds refresh only on request. |

Internal developer builds include one additional private development skill and allow the integration
environment and explicitly enabled panel refresh. Those capabilities are absent or disabled in
public builds. A public preview has the same restrictions as a public stable package.
Dependencies and account access are checked when relevant; never silently install software or
substitute a different environment to get around a denial. Keep credentials, reports, schedules,
review decisions and Python environments outside the replaceable plugin directory.

## Choose one build at a time

The plugin and marketplace names stay `zira` across builds. Stable users must receive a selected,
approved stable version. Previews are explicitly selected prerelease versions, never the stable
feed. Do not install a private repository's moving branch as the public stable source.

For an unpacked, verified marketplace artifact, use its root (containing `.agents` and
`.claude-plugin`), not the nested plugin directory. Before switching, record the current
marketplace source and exact version with your client's plugin/marketplace listing commands.
Keep its approved archive and checksum for rollback. Remove the previous Zira registration,
register the chosen artifact and install `zira@zira`. Avoid two enabled Zira copies or an
additional standalone Health Report skill.

Codex CLI:

```sh
codex plugin list --json
codex plugin marketplace list --json
codex plugin remove zira@zira --json
codex plugin marketplace remove zira --json
codex plugin marketplace add /absolute/path/to/chosen-marketplace --json
codex plugin add zira@zira --json
```

Claude Code CLI (use the scope shown by `plugin list`; this example uses user scope):

```sh
claude plugin list --json
claude plugin marketplace list --json
claude plugin configure zira@zira --json > /absolute/private/folder/zira-settings.json
node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p)); fs.writeFileSync(p,JSON.stringify({default_company:x.inputs.default_company || "",default_site:x.inputs.default_site || ""}));' /absolute/private/folder/zira-settings.json
claude plugin uninstall zira@zira --scope user --keep-data
claude plugin marketplace remove zira
claude plugin marketplace add /absolute/path/to/chosen-marketplace --scope user
claude plugin install zira@zira --scope user
claude plugin configure zira@zira --values-stdin --json < /absolute/private/folder/zira-settings.json
```

Start a new session after switching. Ask the loaded Zira skill to run its build-info helper and
check the expected version, audience, channel and plugin root. A direct Claude developer session
can instead use `claude --plugin-dir /absolute/path/to/checkout/plugins/zira` after disabling or
removing the marketplace copy. Codex developers register the private checkout's marketplace root.
Return to stable by repeating the replacement steps using the saved, approved stable artifact,
then verify its identity in a new session. Never run an auth logout or delete Zira data folders
as part of switching. Claude uninstall clears client-owned plugin settings even with `--keep-data`; the commands above
save and restore the company/site preferences. Use an existing private folder for the backup.
The backup contains only those preferences, never authentication tokens.

The selected public Git source is `https://github.com/lightapp/zira-plugin`.
Use an explicitly selected preview tag/branch until a stable release is approved. Verify the
remote version exists before claiming it is available. Directory submission is a separate step.
The public repository README gives direct Git installation commands; the switching procedure
above also accepts that Git source in place of an extracted local directory.
