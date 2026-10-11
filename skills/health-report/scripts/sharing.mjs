import path from "node:path";
import { readdir, lstat } from "node:fs/promises";
import { dashboardHtml } from "./dashboard.mjs";
import { readJson, writePrivate } from "./storage.mjs";

export async function prepareShare(reportFile, outputDirectory) {
  if (!reportFile || !outputDirectory) throw new Error("--report and --out are required");
  const report = await readJson(reportFile);
  if (report.version !== 1 || !Array.isArray(report.devices) ||
      !report.companyId || !report.monitorId || !Number.isFinite(Date.parse(report.assessedAt)))
    throw new Error("Expected a generated health report JSON file");
  const out = path.resolve(outputDirectory);
  const manifest = path.join(out, ".openai", "hosting.json");
  const identityFile = path.join(out, ".openai", "health-report.json");
  const identity = { companyId: report.companyId, monitorId: report.monitorId };
  const previous = await readJson(identityFile, null);
  const entries = await readdir(out).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  if (entries.length && (!previous || previous.companyId !== identity.companyId || previous.monitorId !== identity.monitorId))
    throw new Error("Use an empty output directory or the same monitor's prepared site directory");
  for (const folder of [out, path.join(out, ".openai"), path.join(out, "dist")]) {
    const info = await lstat(folder).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Site output directories must be real directories");
  }
  const hosting = await readJson(manifest, { static: { directory: "dist" } });
  if (hosting.static?.directory !== "dist") throw new Error("Prepared site must use static.directory dist");
  await writePrivate(path.join(out, "dist", "index.html"), dashboardHtml(report));
  await writePrivate(manifest, hosting);
  await writePrivate(identityFile, identity);
  return {
    state: "prepared-local-only", directory: out,
    dashboard: path.join(out, "dist", "index.html"), manifest,
    projectId: hosting.project_id ?? null,
    assessedAt: report.assessedAt,
    next: "Publish through an available hosting tool using the user's chosen destination and audience; verify search and access before sharing its HTTPS URL.",
  };
}
