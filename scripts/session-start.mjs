#!/usr/bin/env node
// Claude Code SessionStart hook (wired only from .claude-plugin/plugin.json).
// First session after install: a one-line notice for the user and a hint for the model
// to offer getting-started. Every session: saved default company/site from userConfig.
// Node too old: a plain "set up Zira" notice instead (no Node at all: hooks/needs-node.json).
// Prints nothing when there is nothing to say. Never fails the session.
import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 100);

const MIN_NODE = 20;

// Where Zira lives in this host, in the user's words (Chat and Cowork never load the plugin).
const WHERE = {
  "claude-desktop":
    "Whenever you want Zira, open the Claude app, click Code and start a new session. Chat and Cowork can't see your Zira data.",
  cli: "Start Claude Code as usual and ask about Zira.",
};

export function needsNode(version = process.versions.node) {
  return {
    systemMessage: 'Zira needs a newer version of a free helper program called Node.js. Say "set up Zira" and Claude will update it with you. No typing commands.',
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `Node.js ${clean(version)} is older than the ${MIN_NODE} the Zira plugin needs, so Zira's tools cannot start in this session. ` +
        'When the user says "set up Zira" or asks for anything Zira, use the zira:getting-started skill and follow its setup guide (references/setup-help.md) to update Node.js with them first, in plain words. ' +
        "Do not click through Zira in a web browser as a substitute unless the user asks for that.",
    },
  };
}

export function sessionStart({ env = process.env, now = new Date(), nodeVersion = process.versions.node } = {}) {
  if (Number.parseInt(nodeVersion, 10) < MIN_NODE) return needsNode(nodeVersion);
  const dataDir = env.CLAUDE_PLUGIN_DATA;
  const company = clean(env.CLAUDE_PLUGIN_OPTION_DEFAULT_COMPANY);
  const site = clean(env.CLAUDE_PLUGIN_OPTION_DEFAULT_SITE);
  let firstRun = false;
  if (dataDir) {
    const marker = join(dataDir, "onboarding.json");
    if (!existsSync(marker)) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(marker, JSON.stringify({ welcomedAt: now.toISOString() }) + "\n");
      firstRun = true;
    }
  }
  const where = WHERE[env.CLAUDE_CODE_ENTRYPOINT];
  const context = [];
  if (firstRun)
    context.push(
      "The Zira plugin was just installed and this is the user's first session with it. " +
        "In your first reply, offer the getting-started skill in one sentence (choose what matters, sign in and try one useful action). " +
        "If their first message is about something else, answer it normally and add that one-sentence offer at the end. Do not repeat it later. " +
        (where
          ? `Also tell them once, in plain words, where to find Zira next time: "${where}"`
          : "Also tell them once, in plain words, where to find Zira next time, following the Zira plugin's references/setup-help.md (Where Zira works)."),
    );
  if (company || site)
    context.push(
      `Saved Zira defaults from the plugin settings: company "${company || "not set"}", site "${site || "not set"}". ` +
        "When a Zira skill needs a company or site the user has not named, resolve these names through authorized discovery, " +
        "use them when exactly one record matches and say which one you are using; otherwise ask. They are preferences, not authorization. Read references/preferences.md when a Zira skill needs defaults: account-scoped shared defaults take precedence over these legacy defaults; empty shared defaults stay cleared.",
    );
  if (!context.length) return undefined;
  return {
    ...(firstRun && {
      systemMessage:
        "Zira is ready. Say \"get started\" for a two-minute first run, or type /zira: to see every action." +
        (env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop" ? " Zira works here in the Code tab, not in Chat or Cowork." : ""),
    }),
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context.join("\n\n") },
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const out = sessionStart();
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (error) {
    process.stderr.write(`zira session-start: ${error.message}\n`);
  }
}
