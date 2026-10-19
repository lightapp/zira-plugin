# Zira

Run Zira from your chat: check cameras, analyze production, manage tasks and dashboards,
work with datasets and models, and create local reports. Sign in with your own Zira account.

This is the Claude directory candidate, generated from the same source as the full Git plugin.
It contains all 29 public skills and the declared local `zira` MCP server. It has no startup
hook, mod or native side-panel command. All packaged action scripts are invoked through MCP;
the server reuses the existing Node/Python tools on this computer. No remote MCP hosting is
required. The full Git package at the repository root retains the optional Claude panels.

Requires Claude Code, Node.js 20+ and the user's approval to connect the local MCP server.
No npm install is needed. Image/model analysis can install its dedicated pinned Python
environment after consent. Start with “Help me get started with Zira.” An ordinary web chat
without a local executor cannot run this package. This candidate is not yet directory-approved.

Writes keep their existing preview/approval/receipt/read-back safeguards. Installation does
not create tasks, activate schedules or change devices. Public builds use production and
support `.tflite` models; internal device-control/development actions are excluded.

Website: <https://zira.us>

Support and documentation: <https://help.zira.us/docs>

Privacy: <https://zira.us/privacy>

Terms: <https://zira.us/terms.html>

Zira retains all rights. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
The [local MCP reference](references/local-mcp.md) documents tools and long-running jobs.

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

