#!/usr/bin/env node
// Read identity from this installed artifact, never from a nearby checkout.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = new URL('../', import.meta.url);
export function buildInfo() {
  let metadata;
  try { metadata = JSON.parse(readFileSync(new URL('build.json', root), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    metadata = {
      version: JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', root), 'utf8')).version,
      audience: 'internal', channel: 'local', sourceCommit: null, sourceDirty: null,
      skills: readdirSync(new URL('skills/', root), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(),
      restrictions: { profiles: ['prod', 'integ'], ptModels: true, automaticRefresh: true },
      releaseApproved: false,
    };
  }
  return { ...metadata, pluginRoot: fileURLToPath(root) };
}
export const allowsPt = () => buildInfo().restrictions.ptModels === true;
export function assertProfile(profile) {
  if (!buildInfo().restrictions.profiles.includes(profile))
    throw new Error(`Zira profile ${profile} is unavailable in this build. Use prod for the public plugin.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  console.log(JSON.stringify(buildInfo(), null, 2));
