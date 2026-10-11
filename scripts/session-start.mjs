#!/usr/bin/env node
// Claude Code SessionStart hook (wired only from .claude-plugin/plugin.json).
// First session after install: a one-line notice for the user and a hint for the model
// to offer getting-started. Every session: saved default company/site from userConfig.
// Prints nothing when there is nothing to say. Never fails the session.
import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f"]/g, " ").trim().slice(0, 100);

export function sessionStart({ env = process.env, now = new Date() } = {}) {
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
  const context = [];
  if (firstRun)
    context.push(
      "The Zira plugin was just installed and this is the user's first session with it. " +
        "In your first reply, offer the getting-started skill in one sentence (choose what matters, sign in and try one useful action). " +
        "If their first message is about something else, answer it normally and add that one-sentence offer at the end. Do not repeat it later.",
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
      systemMessage: "Zira is ready. Say \"get started\" for a two-minute first run, or type /zira: to see every action.",
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
