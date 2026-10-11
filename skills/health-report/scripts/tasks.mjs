import { createHash } from "node:crypto";
import { assertConfig, id } from "./config.mjs";
import { taskCreateBody, taskUpdateBody, ZiraApiError } from "./task-api.mjs";
import { fingerprint } from "./engine.mjs";
import { pages } from "./api.mjs";
import { readJson, writePrivate, withLock } from "./storage.mjs";
export function taskDrafts(report, config) {
  assertConfig(config);
  if (
    report.companyId !== config.companyId ||
    report.monitorId !== config.monitorId ||
    report.configHash !== fingerprint(config)
  )
    throw new Error("Report/configuration mismatch; run a fresh report");
  if (config.tasks.mode === "report-only") return [];
  return report.findings.map((f) => {
    const d = report.devices.find(
      (d) =>
        d.id === f.deviceId &&
        d.siteId === f.siteId &&
        d.identity === f.identity,
    );
    if (
      !d ||
      !id(d.id) ||
      !id(d.siteId) ||
      (config.siteIds !== "all" && !config.siteIds.includes(d.siteId))
    )
      throw new Error("Finding has no in-scope device");
    const incident = createHash("sha256")
      .update(`${config.companyId}:${f.key}:${f.firstSeen}`)
      .digest("hex")
      .slice(0, 24);
    const marker = `[health-report:${incident}]`;
    return {
      incident,
      findingKey: f.key,
      marker,
      deviceId: d.id,
      siteId: d.siteId,
      body: {
        name: `${f.title} — ${d.name} ${marker}`,
        siteId: d.siteId,
        typeId: "3",
        deviceId: d.id,
        assigneeId: config.tasks.assigneeId,
        priorityId: f.severity === "critical" ? "15" : "10",
        description: `Health report ${config.monitorId}\n${marker}\nObserved: ${report.assessedAt}\nSite: ${d.siteName}\nDevice: ${d.name} (#${d.id})\nFinding: ${f.title}\nEvidence: ${JSON.stringify(f.evidence)}\nNext step: inspect the reported condition and record the action taken.\nRecovery: rerun the affected health check with fresh evidence. Task creation is not repair verification.`,
      },
    };
  });
}
export async function handleTasks({
  report,
  config,
  client,
  ledgerFile,
  apply = false,
  verifyAssignment,
}) {
  const drafts = taskDrafts(report, config);
  if (!drafts.length) return { writes: 0, items: [] };
  if (!ledgerFile) throw new Error("A persistent ledger path is required");
  return withLock(`${ledgerFile}.lock`, async () => {
    const ledger = await readJson(ledgerFile, { version: 1, actions: {} });
    const profile = report.sourceProfile;
    if (!["prod", "integ"].includes(profile)) throw new Error("Run a fresh report with a prod/integ source profile");
    const savedProfile = ledger.sourceProfile ?? (Object.keys(ledger.actions).length ? "prod" : profile);
    if (savedProfile !== profile) throw new Error("Task ledger belongs to a different environment; use its original profile or a separate ledger");
    ledger.sourceProfile = profile;
    const items = [];
    let writes = 0, stopped = false;
    const sites = [...new Set(drafts.map((x) => x.siteId))];
    const existing = await pages((route) => client("GET", route), "/tasks/list", {
      siteIds: sites.join(","),
    });
    for (const draft of drafts) {
      const actionKey = `${config.companyId}:${draft.incident}`;
      const exact = existing.filter(
        (t) =>
          String(t.site?.id) === draft.siteId &&
          String(t.device?.id) === draft.deviceId &&
          String(t.name ?? "").includes(draft.marker),
      );
      const old = ledger.actions[actionKey];
      if (exact.length > 1) {
        items.push({
          incident: draft.incident,
          state: "blocked",
          reason: "Multiple matching tasks; reconcile manually",
        });
        continue;
      }
      if (exact.length === 1) {
        ledger.actions[actionKey] = {
          ...old,
          state: "linked",
          taskId: String(exact[0].id),
        };
        items.push({
          incident: draft.incident,
          state: "existing",
          taskId: String(exact[0].id),
        });
        continue;
      }
      if (old) {
        items.push({
          incident: draft.incident,
          state: "blocked",
          reason:
            "Prior write/link needs reconciliation; do not create a duplicate",
          taskId: old.taskId,
        });
        continue;
      }
      const related = existing.filter(
        (t) =>
          String(t.site?.id) === draft.siteId &&
          String(t.device?.id) === draft.deviceId &&
          !["20", "25"].includes(String(t.status?.id)),
      );
      if (related.length) {
        items.push({
          incident: draft.incident,
          state: "review-existing",
          taskIds: related.map((t) => String(t.id)),
          draft: draft.body,
        });
        continue;
      }
      if (!apply) {
        items.push({
          incident: draft.incident,
          state: "draft",
          draft: draft.body,
        });
        continue;
      }
      if (
        !verifyAssignment ||
        !(await verifyAssignment(
          draft.siteId,
          config.tasks.assigneeId,
          draft.deviceId,
        ))
      ) {
        items.push({
          incident: draft.incident,
          state: "blocked",
          reason:
            "Verify site/company access and assignee before notifying them",
        });
        continue;
      }
      ledger.actions[actionKey] = {
        state: "submitting",
        at: new Date().toISOString(),
      };
      await writePrivate(ledgerFile, ledger);
      try {
        const res = await client("POST", "/tasks/new", taskCreateBody(draft.body));
        writes++;
        const taskId = String(res.data);
        if (!id(taskId)) throw new Error("Create returned no task ID");
        ledger.actions[actionKey] = { state: "awaiting-readback", taskId };
        await writePrivate(ledgerFile, ledger);
        const found = await pages((route) => client("GET", route), "/tasks/list", {
          siteIds: draft.siteId,
          textSearch: draft.marker,
        });
        const t = found.find((t) => String(t.id) === taskId);
        const verified =
          t &&
          String(t.site?.id) === draft.siteId &&
          String(t.device?.id) === draft.deviceId &&
          String(t.assignee?.id) === config.tasks.assigneeId &&
          String(t.name ?? "").includes(draft.marker);
        ledger.actions[actionKey] = {
          state: verified ? "linked" : "readback-mismatch",
          taskId,
        };
        if (verified) existing.push(t);
        items.push({
          incident: draft.incident,
          state: verified ? "created" : "needs-verification",
          taskId,
        });
      } catch (error) {
        const rejected = ledger.actions[actionKey].state === "submitting" &&
          ((error instanceof ZiraApiError && [401, 403, 429].includes(error.status)) || error.code === "HEALTH_REQUEST_LIMIT");
        if (rejected) delete ledger.actions[actionKey];
        else ledger.actions[actionKey] = { ...ledger.actions[actionKey], state: "uncertain" };
        items.push({
          incident: draft.incident,
          state: rejected ? "blocked" : "uncertain",
          reason: rejected
            ? `${error.message}. Resolve internal API authorization or the stated limit before continuing; no API-key fallback is supported.`
            : "Write or read-back failed; reconcile the ledger before retrying. Earlier accepted writes are not undone.",
        });
        stopped = true;
      }
      await writePrivate(ledgerFile, ledger);
      if (stopped) break;
    }
    await writePrivate(ledgerFile, ledger);
    return { writes, items, ...(stopped ? { stopped: true } : {}) };
  });
}
export async function updateTask({
  client,
  taskId,
  siteId,
  patch,
  apply = false,
}) {
  if (!id(taskId) || !id(siteId))
    throw new Error("Valid task/site IDs required");
  const body = taskUpdateBody(taskId, patch);
  const before = (
    await pages((route) => client("GET", route), "/tasks/list", { siteIds: siteId })
  ).find((t) => String(t.id) === taskId && String(t.site?.id) === siteId);
  if (!before) throw new Error("Task not found in the selected site");
  if (!apply)
    return {
      state: "draft",
      taskId,
      before: {
        description: before.description,
        priorityId: before.priority?.id,
        dueDate: before.dueDate,
      },
      patch,
    };
  await client("PUT", `/tasks/${taskId}`, body);
  const after = (
    await pages((route) => client("GET", route), "/tasks/list", { siteIds: siteId })
  ).find((t) => String(t.id) === taskId);
  const verified =
    after &&
    String(after.site?.id) === siteId &&
    Object.entries(patch).every(
      ([k, v]) =>
        String(k === "priorityId" ? after.priority?.id : after[k]) === v,
    );
  return { state: verified ? "updated" : "needs-verification", taskId };
}
