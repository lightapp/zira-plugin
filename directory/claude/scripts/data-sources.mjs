#!/usr/bin/env node
// Create Vision / Pallet QA data sources from their approved templates, duplicate a data
// source and open the form or custom data-source builder, mirroring Zira web's flows.
import { parseArgs } from "node:util";
import {
  Blocked, ZiraApiError, argValue, fingerprint, guardedWrite, id, isMain, link, liveSession, normalizeName,
  originFor, receiptsFile, resolveSite, route, runCli, siteDataSources, siteSystem, text,
} from "./client.mjs";

const HELP = `Zira data sources and forms — guided creation
node scripts/data-sources.mjs templates --company-id ID --site-id ID --kind vision|pallet
node scripts/data-sources.mjs create --company-id ID --site-id ID --kind vision|pallet
    --template-id ID --name TEXT [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/data-sources.mjs copy --company-id ID --site-id ID --source-id ID [--name TEXT]
    [--target-company-id ID] [--target-site-id ID] [--include-triggers]
    [--apply] [--allow-repeat] [--resolve-pending none|ID] [--receipts FILE]
node scripts/data-sources.mjs builder-link --company-id ID --site-id ID --kind form|custom [--name TEXT]
Common: --profile prod|integ

create previews by default. --apply creates one data source from the template in the
selected site, attaches it to the site's system when possible and reads it back.
copy previews a duplicate of a data source of the selected site, in the same site unless a
target site is given (default name "<source> (copy)"). --apply copies it once, as Zira web's
Duplicate does, and reads it back. Triggers are copied only with --include-triggers and only
within the same company.
builder-link returns Zira's form/custom data-source editor for the site; it writes nothing.
--resolve-pending settles an earlier attempt with an unknown outcome after the user checked Zira.
Exit 0 success, 2 invalid/failed, 3 created but unverified, 4 blocked (JSON explains).
`;

// Same template families the web assistant offers (dataSource.server.js).
export const FLOWS = {
  vision: { title: "AI-Vision", applyingId: "7", templateIds: ["159", "160", "161", "162"] },
  pallet: { title: "AI-Pallet QA and Routing", applyingId: "10", templateIds: ["168"] },
};
export const BUILDERS = {
  form: { applyingIds: "2", title: "form", existingApplyingIds: "2,8", openAiOnMount: "true" },
  custom: { applyingIds: "3", title: "custom data source", existingApplyingIds: "3", openAiOnMount: "true" },
};

export const ROUTES = [
  ["GET", /^\/sites\/list$/], ["GET", /^\/channels\/[1-9]\d*$/], ["GET", /^\/devices\/template$/],
  ["GET", /^\/devices\/list$/], ["GET", /^\/devices\/all$/], ["POST", /^\/devices\/from-template$/],
  ["POST", /^\/devices\/copy$/], ["POST", /^\/systems\/[1-9]\d*\/attach-meter$/],
];

// What Zira's copy_device leaves out, so previews and results never imply a full clone.
const NOT_COPIED = {
  all: ["readings", "connected data sources", "sub-channels it is shown in", "webhook URL", "privacy setting"],
  "7": ["Vision settings, models and datasets (the copy starts unpaired, like a new Vision source)"],
  "10": ["Pallet QA settings, models and datasets (the copy starts unpaired, like a new Pallet QA source)"],
  "9": ["aggregation settings"],
};
export const notCopied = (applyingId, { includeTriggers, sameCompany }) => [
  ...(NOT_COPIED[applyingId] ?? []), ...NOT_COPIED.all,
  ...(!includeTriggers ? ["triggers (alerts)"] : sameCompany ? [] : ["triggers (alerts), which are copied only within the same company"]),
];

// Any kind of data source (forms, Vision, custom), not only meter device types.
async function dataSource(call, dataSourceId) {
  const rows = (await call("GET", route("/devices/all", { meterIds: dataSourceId, expand: "true", onlyMeters: "false" }))).data ?? [];
  return rows.find(d => String(d?.id) === dataSourceId) ?? null;
}
const metricIds = device => (device?.meterSchema?.metrics ?? []).map(m => String(m.metric?.id ?? "")).filter(v => id(v)).sort();

function flowFor(kind) {
  if (!Object.hasOwn(FLOWS, kind)) throw new Error("Choose --kind vision or pallet; custom sources use builder-link");
  return FLOWS[kind];
}

async function fetchTemplates(call, flow) {
  const rows = (await call("GET", route("/devices/template", { applyingIds: flow.applyingId, deviceTemplateIds: flow.templateIds.join(",") }))).data ?? [];
  return rows.filter(t => flow.templateIds.includes(String(t?.id)))
    .map(t => ({ id: String(t.id), name: String(t.name ?? "Template"), ...(t.description ? { description: text(t.description, 300) } : {}) }));
}

export async function templates({ call, companyId, siteId, kind }) {
  const flow = flowFor(kind);
  const site = await resolveSite(call, companyId, siteId);
  return { kind: "data-source-templates", flow: kind, title: flow.title, site: { id: site.id, name: site.name }, items: await fetchTemplates(call, flow) };
}

async function sameName(call, site, name) {
  return (await siteDataSources(call, site, { textSearch: name.slice(0, 100) }))
    .filter(d => normalizeName(d.name) === normalizeName(name))
    .map(d => ({ id: String(d.id), name: String(d.name) }));
}

const duplicateError = error =>
  error instanceof ZiraApiError && (error.status === 409 || /not unique|already exists/i.test(error.details ?? ""));

export async function createFromTemplate({ call, profile = "prod", companyId, siteId, kind, templateId, name, apply = false, allowRepeat = false, receipts, resolve }) {
  const flow = flowFor(kind);
  const targetName = text(name, 120);
  if (!targetName) throw new Error("A data source name is required");
  if (!id(templateId) || !flow.templateIds.includes(templateId)) throw new Error(`Template must be one of the ${flow.title} templates`);
  const site = await resolveSite(call, companyId, siteId);
  const template = (await fetchTemplates(call, flow)).find(t => t.id === templateId);
  if (!template) throw new Blocked("not_found", "That template is not available to this user");
  const duplicates = await sameName(call, site, targetName);
  const preview = { site: { id: site.id, name: site.name }, flow: flow.title, template, name: targetName };
  if (!apply) return { kind: "data-source-draft", profile, preview, duplicates, applied: false };
  const key = fingerprint({ op: "data-source-from-template", profile, siteId: site.id, templateId, name: normalizeName(targetName) });
  const outcome = await guardedWrite({
    file: receipts, key, allowRepeat, resolve, resolveField: "dataSourceId",
    summary: { kind: "data-source", siteId: site.id, name: targetName, templateId },
    precheck: async () => {
      const current = await sameName(call, site, targetName);
      if (current.length)
        throw new Blocked("duplicate", `A data source named "${targetName}" already exists in ${site.name}. Choose a different name.`, { duplicates: current });
    },
    // The precheck guaranteed no same-name source existed, so exactly one now is this attempt's.
    reconcile: async () => {
      const found = await sameName(call, site, targetName);
      return found.length === 1 ? { dataSourceId: found[0].id } : null;
    },
    run: async progress => {
      let createdId;
      try {
        createdId = String((await call("POST", "/devices/from-template", {
          deviceTemplateId: templateId,
          targetDeviceName: targetName,
          targetSiteId: site.id,
          nameSuffix: "",
          includeAlerts: false,
          allowCopySchema: true,
          publishToChannelIds: null,
        })).data ?? "");
      } catch (error) {
        if (duplicateError(error))
          throw new Blocked("duplicate", `A data source named "${targetName}" already exists in ${site.name}. Choose a different name.`);
        throw error;
      }
      if (!id(createdId)) throw new Error("Create returned no data source ID; check the site's data sources before retrying");
      await progress({ dataSourceId: createdId });
      const warnings = [];
      const systemId = await siteSystem(call, site);
      let attached = false;
      if (systemId) {
        try {
          await call("POST", `/systems/${systemId}/attach-meter`, { meter: { id: createdId }, associationType: { id: "1" } });
          attached = true;
        } catch (error) {
          warnings.push(`Created, but attaching it to the site's system failed (${error.status ? `HTTP ${error.status}` : "request error"}). Attach it from the site's data sources in Zira.`);
        }
      } else warnings.push("The site's system was not found, so the new data source was not attached to it.");
      let saved = null;
      try {
        saved = (await call("GET", route("/devices/all", { meterIds: createdId, expand: "true" }))).data?.[0];
      } catch (error) {
        warnings.push(`Read-back failed (${error.status ? `HTTP ${error.status}` : error.message}); open the data source to check it.`);
      }
      const verified = String(saved?.id ?? "") === createdId && String(saved?.site?.id ?? "") === site.id &&
        normalizeName(saved?.name) === normalizeName(targetName) && String(saved?.applying?.id ?? "") === flow.applyingId;
      return { receipt: { dataSourceId: createdId }, dataSourceId: createdId, verified, attached, warnings };
    },
  });
  if (["already-done", "reconciled"].includes(outcome.state)) {
    const dsId = outcome.receipt.dataSourceId;
    return { kind: "data-source", profile, applied: false, state: outcome.state, dataSourceId: dsId, attachedToSiteSystem: null,
      url: link(profile, `/data-sources/${dsId}`), message: "This exact data source was already created; nothing new was written.",
      warnings: ["Whether it is attached to the site's system was not checked here; confirm it in the site's data sources in Zira."] };
  }
  return {
    kind: "data-source", profile, applied: true, state: outcome.verified ? "created" : "unverified",
    verified: outcome.verified, dataSourceId: outcome.dataSourceId, attachedToSiteSystem: outcome.attached,
    warnings: outcome.warnings, preview,
    url: link(profile, `/data-sources/${outcome.dataSourceId}`, { tab: "overview" }),
    next: "Continue with the setup-vision skill: pairing, mounting, recording, datasets, training and validation.",
  };
}

// Zira web's data source Duplicate dialog (CopyDeviceDialog.js): a copy in the same site by
// default, or in another site the user can change. Like Zira web, it adds the copy to no
// channel: a site channel's Data Sources tab lists every source of the site.
export async function copyDataSource({ call, profile = "prod", companyId, siteId, sourceId, targetCompanyId, targetSiteId, name,
  includeTriggers = false, apply = false, allowRepeat = false, receipts, resolve }) {
  if (!id(sourceId)) throw new Error("Source data source ID required");
  const site = await resolveSite(call, companyId, siteId);
  const toCompany = targetCompanyId ?? companyId, toSite = targetSiteId ?? siteId;
  const target = toCompany === companyId && toSite === site.id ? site : await resolveSite(call, toCompany, toSite);
  const source = await dataSource(call, sourceId);
  if (!source || source.isDeleted || source.isTemplate || String(source.site?.id ?? "") !== site.id)
    throw new Blocked("scope", `Data source ${sourceId} is not a data source of ${site.name} that this user can see`);
  const sourceName = text(source.name, 200) || `Data source ${sourceId}`;
  const targetName = text(name, 120) || `${sourceName.slice(0, 113)} (copy)`;
  const applyingId = String(source.applying?.id ?? "");
  const sameSite = target.id === site.id, sameCompany = target.companyId === site.companyId;
  const preview = {
    source: { id: sourceId, name: sourceName, kind: source.applying?.name ?? null, metrics: metricIds(source).length },
    target: { siteId: target.id, siteName: target.name, sameSite, sameCompany },
    name: targetName,
    includeTriggers,
    notCopied: notCopied(applyingId, { includeTriggers, sameCompany }),
    ...(sameSite ? {} : { metrics: "Zira reuses metrics with the same name and unit at the target and creates the missing ones." }),
  };
  const duplicates = await sameName(call, target, targetName);
  if (!apply) return { kind: "data-source-copy-draft", profile, preview, duplicates, applied: false };
  const key = fingerprint({ op: "data-source-copy", profile, sourceId, targetSiteId: target.id, name: normalizeName(targetName) });
  const taken = (details = {}) => new Blocked("duplicate", `A data source named "${targetName}" already exists in ${target.name}. Choose a different name.`, details);
  const outcome = await guardedWrite({
    file: receipts, key, allowRepeat, resolve, resolveField: "dataSourceId",
    summary: { kind: "data-source-copy", sourceId, siteId: target.id, name: targetName },
    precheck: async () => {
      const current = await sameName(call, target, targetName);
      if (current.length) throw taken({ duplicates: current });
    },
    // The precheck guaranteed no same-name source existed, so exactly one now is this attempt's.
    reconcile: async () => {
      const found = await sameName(call, target, targetName);
      return found.length === 1 ? { dataSourceId: found[0].id } : null;
    },
    run: async progress => {
      let copyId;
      try {
        const created = (await call("POST", "/devices/copy", {
          sourceDeviceId: sourceId,
          targetDeviceName: targetName,
          targetSiteId: target.id,
          nameSuffix: "",
          includeAlerts: includeTriggers,
          allowCopySchema: true,
          publishToChannelIds: null,
        })).data;
        copyId = String((created && typeof created === "object" ? created.id : created) ?? "");
      } catch (error) {
        if (duplicateError(error)) throw taken();
        throw error;
      }
      if (!id(copyId)) throw new Error("Copy returned no data source ID; check the target site's data sources before retrying");
      await progress({ dataSourceId: copyId });
      const warnings = [];
      let saved = null;
      try {
        saved = await dataSource(call, copyId);
      } catch (error) {
        warnings.push(`Read-back failed (${error.status ? `HTTP ${error.status}` : error.message}); open the copy to check it.`);
      }
      // Same site: the copy keeps the source's metrics. Another site: matched or new metrics, same count.
      const want = metricIds(source), got = metricIds(saved);
      const schemaMatches = sameSite ? got.join() === want.join() : got.length === want.length;
      if (saved && !schemaMatches) warnings.push("The copy's metrics differ from the source's; check its fields in Zira.");
      const verified = !!saved && String(saved.id) === copyId && String(saved.site?.id ?? "") === target.id &&
        normalizeName(saved.name) === normalizeName(targetName) && String(saved.applying?.id ?? "") === applyingId && schemaMatches;
      return { receipt: { dataSourceId: copyId }, dataSourceId: copyId, verified, warnings };
    },
  });
  const links = dsId => ({
    url: link(profile, `/data-sources/${dsId}`, { tab: "overview" }),
    ...(target.channelId ? { channelUrl: link(profile, `/channels/${target.channelId}`, { tab: "dataSources" }) } : {}),
  });
  if (["already-done", "reconciled"].includes(outcome.state))
    return { kind: "data-source-copy", profile, applied: false, state: outcome.state, dataSourceId: outcome.receipt.dataSourceId,
      ...links(outcome.receipt.dataSourceId), message: "This exact copy was already made; nothing new was written." };
  return {
    kind: "data-source-copy", profile, applied: true, state: outcome.verified ? "created" : "unverified",
    verified: outcome.verified, dataSourceId: outcome.dataSourceId, warnings: outcome.warnings, preview,
    ...links(outcome.dataSourceId),
    ...(["7", "10"].includes(applyingId) ? { next: "The copy is not paired with a camera. Continue with the setup-vision skill to pair it, record and train." } : {}),
  };
}

export async function builderLink({ call, profile = "prod", companyId, siteId, kind, name }) {
  if (!Object.hasOwn(BUILDERS, kind)) throw new Error("Choose --kind form or custom");
  const builder = BUILDERS[kind];
  const site = await resolveSite(call, companyId, siteId);
  const systemId = kind === "custom" ? await siteSystem(call, site) : null;
  const similar = name ? (await siteDataSources(call, site, { applyingIds: builder.existingApplyingIds, textSearch: text(name, 100) }))
    .filter(d => normalizeName(d.name) === normalizeName(name)).map(d => ({ id: String(d.id), name: String(d.name), url: link(profile, `/data-sources/${d.id}`) })) : [];
  return {
    kind: "builder-link", profile, builder: kind,
    site: { id: site.id, name: site.name },
    url: link(profile, "/forms/new", {
      applyingIds: builder.applyingIds, siteId: site.id, siteName: site.name, openAiOnMount: builder.openAiOnMount,
      ...(site.channelId ? { channelId: site.channelId, fromChannel: site.channelId } : {}),
      ...(systemId ? { attachSystemId: systemId } : {}),
    }),
    existingWithSameName: similar,
    note: `This opens Zira's ${builder.title} editor for the site with its AI builder. Nothing is created until the user reviews and saves it there.`,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) { process.stdout.write(HELP); return; }
  const { values: o } = parseArgs({ args: args.slice(1), options: {
    "company-id": { type: "string" }, "site-id": { type: "string" }, kind: { type: "string" },
    "template-id": { type: "string" }, name: { type: "string" }, apply: { type: "boolean" },
    "allow-repeat": { type: "boolean" }, receipts: { type: "string" }, profile: { type: "string" },
    "resolve-pending": { type: "string" }, "source-id": { type: "string" }, "target-company-id": { type: "string" },
    "target-site-id": { type: "string" }, "include-triggers": { type: "boolean" },
  } });
  const profile = o.profile ?? process.env.ZIRA_PROFILE ?? "prod";
  originFor(profile);
  const scope = { call: await liveSession(profile, { allow: ROUTES }), profile, companyId: o["company-id"], siteId: o["site-id"], kind: o.kind };
  if (args[0] === "templates") return templates(scope);
  if (args[0] === "create")
    return createFromTemplate({ ...scope, templateId: o["template-id"], name: o.name, apply: !!o.apply,
      allowRepeat: !!o["allow-repeat"], resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) });
  if (args[0] === "copy")
    return copyDataSource({ ...scope, sourceId: o["source-id"], targetCompanyId: o["target-company-id"], targetSiteId: o["target-site-id"],
      name: o.name, includeTriggers: !!o["include-triggers"], apply: !!o.apply, allowRepeat: !!o["allow-repeat"],
      resolve: o["resolve-pending"], receipts: receiptsFile(o.receipts) });
  if (args[0] === "builder-link") return builderLink({ ...scope, name: o.name });
  throw new Error("Choose templates, create, copy or builder-link");
}

const cliProfile = () => argValue("profile") ?? process.env.ZIRA_PROFILE ?? "prod";

// A blocked copy points to the source's page, where Zira's own Duplicate does the same thing.
export function handoffInfo(argv = process.argv) {
  const source = argv[2] === "copy" ? argValue("source-id", argv) : undefined;
  if (id(source ?? "")) {
    const profile = ["prod", "integ"].includes(cliProfile()) ? cliProfile() : "prod";
    return { pageUrl: link(profile, `/data-sources/${source}`), details: "Open the data source in Zira and use ⋯ → Duplicate there. Nothing was copied here." };
  }
  return { prompt: argValue("kind", argv) === "form" ? "create form" : "create data source" };
}

if (isMain(import.meta)) runCli(main, { profile: cliProfile, handoffInfo: () => handoffInfo() });
