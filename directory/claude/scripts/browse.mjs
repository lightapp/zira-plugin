#!/usr/bin/env node
import { assertProfile } from "./build-info.mjs";
import { parseArgs } from "node:util";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { discover, healthProfile, liveClient, pages } from "../skills/health-report/scripts/api.mjs";
import { id } from "../skills/health-report/scripts/config.mjs";

const ORIGINS = { prod: "https://my.zira.us", integ: "https://zira-webinteg.zira.us" };
const HELP = `Zira inventory — read-only browsing
node scripts/browse.mjs menu|companies|sites|devices|dashboards
  --company-id ID       Required for sites, devices and dashboards
  --site-id ID          Required for devices and dashboards
  --profile prod|integ  Defaults to ZIRA_PROFILE, then prod
  --health-profiles     devices only: also read each device (within the cap) and add
                        healthProfile trimsaw|bandsaw|pallet-qa, null (not covered by
                        health checks) or "unknown" (cap reached)

menu makes no API calls. Lists require the health-report browser login.
At most 20 API reads per invocation; 429 stops without retrying.
JSON stdout contains safe names, IDs and links, never full settings.
Exit 0: complete, 2: failed/invalid input, 3: coverage incomplete.
`;

export function originFor(profile) {
  assertProfile(profile);
  if (!Object.hasOwn(ORIGINS, profile)) throw new Error("Choose prod or integ profile");
  return ORIGINS[profile];
}

export async function browse(get, kind, { companyId, siteId, profile = "prod", healthProfiles = false } = {}) {
  const origin = originFor(profile);
  if (!["companies", "sites", "devices", "dashboards"].includes(kind))
    throw new Error("Choose companies, sites, devices or dashboards");
  if (kind !== "companies" && !id(companyId)) throw new Error("Company ID required");
  if (["devices", "dashboards"].includes(kind) && !id(siteId)) throw new Error("Site ID required");
  let requests = 0;
  const boundedGet = async route => {
    if (requests >= 20) throw new Error("Local request cap reached; narrow the scope before trying again");
    requests++;
    return get(route);
  };
  let rows, excluded = 0;
  if (["devices", "dashboards"].includes(kind)) {
    const sites = await discover(boundedGet, "sites", companyId);
    if (!sites.some(s => s.id === siteId)) throw new Error("Site outside selected company");
    const raw = await pages(boundedGet, `/${kind}/list`, { siteIds: siteId,
      ...(kind === "dashboards" ? { dashboardTypeIds: "3" } : { companyIds: companyId, applyingIds: "1,3,7,9,10,11" }) });
    rows = raw.filter(d => {
      const company = d.company?.id ?? d.companyId;
      return !d.isDeleted && !d.isTemplate &&
        String(d.site?.id ?? d.siteId ?? "") === siteId &&
        (company == null || String(company) === companyId) &&
        (kind !== "dashboards" || String(d.dashboardType?.id ?? d.dashboardTypeId ?? d.type?.id ?? d.typeId ?? "") === "3");
    });
    excluded = raw.filter(d => !d.isDeleted && !d.isTemplate).length - rows.length;
  } else {
    const raw = await pages(boundedGet, `/${kind}/list`, kind === "sites" ? { companyIds: companyId } : {});
    rows = raw.filter(x => !x.isDeleted && !x.isTemplate && (kind === "companies" || String(x.company?.id ?? x.companyId ?? "") === companyId));
    excluded = raw.filter(x => !x.isDeleted && !x.isTemplate).length - rows.length;
  }
  const items = [];
  for (const row of rows) {
    const entityId = String(row.id ?? "");
    if (!id(entityId)) { excluded++; continue; }
    const url = kind === "sites" && id(String(row.channelId ?? ""))
      ? `${origin}/channels/${row.channelId}?tab=posts`
      : ["devices", "dashboards"].includes(kind)
        ? `${origin}/${kind === "devices" ? "data-sources" : "dashboards"}/${entityId}` : undefined;
    const type = kind === "devices" && typeof row.applying?.name === "string" ? row.applying.name : undefined;
    items.push({ id: entityId, name: String(row.name ?? "Unnamed"),
      ...(companyId ? { companyId } : {}), ...(siteId ? { siteId } : {}),
      ...(url ? { url } : {}), ...(type ? { type } : {}) });
  }
  let profilesComplete;
  if (kind === "devices" && healthProfiles) {
    profilesComplete = true;
    for (const item of items) {
      if (requests >= 20) { item.healthProfile = "unknown"; profilesComplete = false; continue; }
      const detail = (await boundedGet(`/devices/${item.id}`))?.data ?? {};
      item.healthProfile = healthProfile(detail.cv?.settings) ?? null;
    }
  }
  return { kind, profile, complete: excluded === 0, excluded, requests,
    ...(profilesComplete === undefined ? {} : { profilesComplete }), items };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) {
    process.stdout.write(HELP); return 0;
  }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, profile: { type: "string" },
    "health-profiles": { type: "boolean" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  const origin = originFor(profile);
  if (args[0] === "menu") {
    console.log(JSON.stringify({ profile, assistantUrl: `${origin}/ai-assistant`,
      helpUrl: "https://help.zira.us/docs", websiteUrl: "https://zira.us" }, null, 2));
    return 0;
  }
  const result = await browse(await liveClient(profile), args[0], {
    companyId: o["company-id"], siteId: o["site-id"], profile, healthProfiles: o["health-profiles"],
  });
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 3;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 2;
  });
}
