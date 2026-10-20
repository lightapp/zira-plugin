# Setting up Zira for someone who is not technical

Most Zira users are not technical. Do the setup for them, one step at a time, in plain words.
Never hand them terminal commands to run, and never use words like MCP, marketplace, plugin root,
PATH or CLI. Before anything appears on their screen (an installer window, a password prompt, an
Allow button, a sign-in page), tell them what they will see and what to click. Ask before you
install anything; once they agree, you do the work.

## Where Zira works

Zira runs on the user's computer, so it works only where the assistant can run things there:

| App | Use Zira here | Zira is not available here |
| --- | --- | --- |
| Claude desktop app | The **Code** tab (next to Chat and Cowork): start a new session, pick any folder (Documents is fine) and keep it on this computer (**Local**), not cloud/remote | The Chat and Cowork tabs, claude.ai in a web browser, the Claude phone app |
| Claude Code in a terminal | Any session | Cloud sessions |
| Codex app | A new thread that runs on this computer (**Local**) | Cloud tasks, ChatGPT chats |

In the places where Zira is not available, the assistant can't see Zira data. It may offer to
click through Zira in a web browser instead, which is slow. When a user is in the wrong place, say
so plainly and give the steps for their app, for example: “Zira works in the Claude app's **Code**
tab. Click **Code** next to Chat and Cowork, start a new session and ask me again there.” Don't
browse Zira's website as a substitute unless they ask for that.

After Zira is installed or updated, it appears in **new** sessions only. Whenever you finish
setting something up, tell the user in one sentence where to find Zira next time, using their app:

- Claude desktop app: “Whenever you want Zira, open the Claude app, click **Code** and start a new session. Chat and Cowork can't see your Zira data.”
- Claude Code in a terminal: “Start Claude Code as usual and ask about Zira.”
- Codex app: “Whenever you want Zira, start a new Local thread in Codex. ChatGPT chats can't see your Zira data.”

## Helper programs: Node.js and Git

Zira needs **Node.js 20 or newer** (a free, widely used program that runs Zira's tools). Installing
from GitHub also needs **Git**. Check quietly first (`node --version`, `git --version`). If both are
present, don't mention them.

If Node.js is missing or older than 20, explain it once in plain words and ask, for example:
“Zira needs a free helper program called Node.js to run on your computer. I can set it up for you
now. It takes about two minutes: you'll see a standard installer and may be asked for your computer
password. Shall I go ahead?” Wait for a yes. Then:

- **Mac with Homebrew already installed** (`brew` exists): run `brew install node`. No window or password.
- **Otherwise, use the official installer from nodejs.org.** Read `https://nodejs.org/dist/index.json`
  and take the first entry whose `lts` is not `false`. Download its installer into the user's
  Downloads folder: `node-vX.Y.Z.pkg` on a Mac, or `node-vX.Y.Z-x64.msi` (`-arm64.msi` on ARM) on
  Windows, from `https://nodejs.org/dist/vX.Y.Z/`. Check its SHA-256 against `SHASUMS256.txt` in the
  same folder, and stop if it doesn't match. Open it (`open` on a Mac, `Start-Process` on Windows) and
  tell them what to click: Continue or Next through each screen, accept the license, then Install. On
  a Mac they type their own computer password (you never see it); on Windows they click **Yes** when
  asked to allow changes. Then Close.
- Check that `node --version` now reports 20 or newer. On a Mac the official installer puts it in
  `/usr/local/bin/node`.

If Git is missing on a Mac, running `git` (or `xcode-select --install`) opens Apple's window offering
the “command line developer tools”. Tell them to click **Install**, wait until it finishes (a few
minutes) and let you know. On Windows, Claude Code already needs Git, so it is usually present. If it
is missing, offer the official installer from `https://git-scm.com` and walk them through it.

If their computer is managed by IT and blocks installers, don't try to work around it. Offer a short
message they can send to IT, for example: “Please install Node.js LTS (version 20 or newer) from
nodejs.org on my computer. I need it to use the Zira plugin in Claude/Codex.”

Zira only notices a newly installed helper in a **new** session. If Zira still isn't there in a new
session, ask them to quit and reopen the Claude or Codex app, then start a new session.

## If Zira's tools are missing in this session

The skills are loaded but the Zira tools are not available. Work out why in this order, and fix it
with the user instead of only reporting an installation problem:

1. **Wrong place**, such as Chat, Cowork, a web chat or a cloud session: follow “Where Zira works”.
2. **Node.js missing or too old:** follow “Helper programs”.
3. **Installed or updated during this session:** ask them to start a new session.
4. **Not installed or turned off:** offer to install or turn it on for them, following the public
   installation steps at `https://github.com/lightapp/zira-plugin#install`.
5. **Still failing:** say plainly that Zira couldn't start on this computer, offer to open the
   matching Zira page in their browser for today's task, and suggest contacting Zira support.

Never fall back to running Zira's scripts some other way to get around a missing tool.

## Updating Zira

When the user asks to update Zira, do it for them with the host's plugin commands, then ask them to
start a new session in the same place:

- Claude Code (including the Claude desktop app's Code tab): `claude plugin marketplace update zira`, then `claude plugin update zira@zira`.
- Codex: `codex plugin marketplace upgrade zira`, then `codex plugin add zira@zira`.

## What users see the first time

- **Allow prompts:** Claude or Codex asks before using Zira's tools. Tell them to click **Allow**.
  Choosing to always allow Zira is fine: Zira still shows a preview and asks in the chat before it
  creates or changes anything.
- **Sign-in:** the first time Zira needs their data, a browser window opens on Zira's normal sign-in
  page. They sign in as usual, and the assistant never sees their password. If no window appears,
  share the sign-in link from the tool's output.
- **Reports and dashboards** open as pages in their browser or beside the chat. Nothing is published
  or shared unless they ask.
