// What the review page can choose from and start by itself: the camera's dataset versions, QA sessions
// and models (read with the plugin's sign-in), and a search that downloads what it needs, prepares
// nail slices and ranks candidates on this computer. Only Zira reads; nothing is written to Zira.
import { randomBytes } from "node:crypto";
import { Blocked, liveSession } from "../../../scripts/client.mjs";
import { ROUTES as DATASET_ROUTES, catalog, listSources, loadDevice, summarize } from "../../../scripts/datasets.mjs";
import { ROUTES as FILE_ROUTES, fetchFile, status } from "../../evaluate-model/scripts/evaluate.mjs";
import { ROUTES as SESSION_ROUTES, fetchSessions, listSessions, prepareSessions } from "../../evaluate-model/scripts/sessions.mjs";

export const ROUTES = [...DATASET_ROUTES, ...FILE_ROUTES, ...SESSION_ROUTES].filter(([m]) => m === "GET");
const SLICE_CLASSES = ["raisedNail", "protrudeNail", "flushNail", "nail", "knot"];
const SESSION_SET = /^\d{4}-\d{2}-\d{2}::(?:\d{4}-\d{2}-\d{2}-)?\d{2}-\d{2}(?:-\d{2})?$/;
const OPTIONS_TTL = 5 * 60000;
const PLURALS = { nail: "nails", protrudeNail: "protruding nails", flushNail: "flush nails", raisedNail: "raised nails", knot: "knots" };
const plural = t => PLURALS[t] ?? `${t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}s`;

const DEPS = { fetchFile, fetchSessions, listSessions, listSources, prepareSessions, status };
const SIBLINGS = 8; // other cameras at the site whose models are offered too

export function createWorkspace({ deviceId, profile = "prod", origin, env = process.env, scan,
  session = () => liveSession(profile, { allow: ROUTES, maxRequests: 1000 }), now = () => Date.now(), deps = {} }) {
  const { fetchFile: getFile, fetchSessions: copySessions, listSessions: sessionsOf, listSources: sourcesAt, prepareSessions: prepare,
    status: runtimeStatus } = { ...DEPS, ...deps };
  let cached = null, job = null;

  // Everything the page offers, newest first. Models are the camera's own, with the classes Zira recorded.
  async function options({ refresh = false } = {}) {
    if (cached && !refresh && now() - cached.at < OPTIONS_TTL) return cached.value;
    const call = await session();
    const device = await loadDevice(call, String(deviceId));
    const camera = summarize(device);
    const cat = catalog(device, { max: 500 });
    const versions = [...cat.datasets.flatMap(d => d.versions.map(v => ({ ...v, dataset: d.name }))), ...cat.otherVersions]
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
      .map(({ id, name, dataset, createdAt, labels, images }) => ({ id, name, dataset: dataset ?? null, createdAt: createdAt ?? null,
        ...(labels ? { labels } : {}), ...(images ? { images: Object.values(images).reduce((n, v) => n + (v ?? 0), 0) } : {}) }));
    // Models are often trained on one camera and used on its neighbours, so the site's other cameras'
    // models are offered too, each with the camera it belongs to.
    const usable = (all, source) => all.filter(m => m.labels?.length).map(({ id, name, createdAt, labels, trainedOn }) => ({
      id, name, createdAt: createdAt ?? null, labels, deviceId: source.id, camera: source.name, ...(trainedOn ? { trainedOn: trainedOn.version } : {}) }));
    const models = usable(cat.allModels, camera);
    let siblings = [];
    try {
      siblings = (await sourcesAt({ call, profile, origin, companyId: camera.companyId, siteId: camera.site.id })).items
        .filter(s => s.id !== camera.id).slice(0, SIBLINGS);
    } catch { /* the site's other cameras are a convenience */ }
    for (const source of siblings) {
      try { models.push(...usable(catalog(await loadDevice(call, source.id), { max: 500 }).allModels, source)); } catch { /* skip that camera */ }
    }
    // A nail slice is a 320 px crop around one board x stringer intersection, so only what fits there
    // is offered (board-level defects of combined models are not), in a fixed order.
    const known = new Set(models.flatMap(m => m.labels));
    const targets = SLICE_CLASSES.filter(c => known.has(c));
    let sessions = { available: false, note: "QA sessions exist only on Pallet Vision cameras." };
    if (camera.type === "Pallet Vision") {
      try {
        const listed = await sessionsOf({ call, deviceId: String(deviceId), limit: 60, origin });
        sessions = { available: true, list: listed.sessions };
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        sessions = { available: false, note: error.reason === "sessions_unavailable"
          ? "QA session frames can't be searched from here yet. You can search a dataset in the meantime." : error.message };
      }
    }
    // Only models this computer can run: .tflite always, .pt once the PyTorch runtime is set up.
    const runtime = await runtimeStatus({ env });
    const formats = runtime.runtime?.ready ? runtime.runtime.models : [".tflite"];
    const runnable = models.filter(m => formats.some(f => m.name.toLowerCase().endsWith(f)));
    // web: where the page opens a session frame in Zira's image review.
    const value = { camera, web: origin, versions, models: runnable, targets, sessions };
    cached = { at: now(), value };
    return value;
  }

  const current = () => job && { id: job.id, state: job.state, steps: job.steps, ...(job.message ? { message: job.message } : {}),
    ...(job.run ? { run: job.run } : {}), ...(job.confirm ? { confirm: job.confirm } : {}) };

  // One search at a time: download the model and the source, prepare nail slices, rank candidates.
  async function search(request, { onDone = async () => {} } = {}) {
    if (job?.state === "running") throw Object.assign(new Error("A search is already running; wait for it to finish."), { status: 409 });
    const { source, modelId, frames, confirm } = request ?? {};
    const targets = [...new Set((Array.isArray(request?.targets) ? request.targets : [request?.target]).filter(t => typeof t === "string" && t))];
    if (!targets.length) throw Object.assign(new Error("Choose what you are looking for."), { status: 400 });
    const opts = await options();
    if (request.modelIds !== undefined && !Array.isArray(request.modelIds)) throw Object.assign(new Error("Models must be a list."), {status: 400});
    const modelIds = [...new Set(request.modelIds ?? [modelId])];
    if (!modelIds.length || modelIds.length > 5) throw Object.assign(new Error("Choose one to five models."), {status: 400});
    const models = modelIds.map(key => opts.models.find(m => m.id === String(key ?? "")));
    if (models.some(m => !m)) throw Object.assign(new Error("Choose one of the models offered."), {status: 400});
    for (const model of models) {
      const unknown = targets.filter(t => !model.labels.includes(t));
      if (unknown.length) throw Object.assign(new Error(`${model.name} was not trained with ${unknown.join(", ")}; choose a model that was.`), {status: 400});
    }
    const model = models[0];
    const words = targets.map(plural).join(" and ");
    let version = null, sessionIds = null;
    if (source?.kind === "version") {
      version = opts.versions.find(v => v.id === String(source.id ?? ""));
      if (!version) throw Object.assign(new Error("Choose one of this camera's dataset versions."), { status: 400 });
    } else if (source?.kind === "sessions") {
      sessionIds = [...new Set((Array.isArray(source.ids) ? source.ids : []).map(String))];
      const known = new Set((opts.sessions.list ?? []).map(s => s.id));
      if (!sessionIds.length || !sessionIds.every(s => SESSION_SET.test(s) && known.has(s)))
        throw Object.assign(new Error("Choose sessions from the list."), { status: 400 });
    } else throw Object.assign(new Error("Choose a dataset version or QA sessions."), { status: 400 });
    if (frames !== undefined && frames !== null && !(Number.isInteger(frames) && frames > 0 && frames <= 5000))
      throw Object.assign(new Error("Frames per session must be a whole number from 1 to 5000."), { status: 400 });

    job = { id: randomBytes(6).toString("hex"), state: "running", steps: [] };
    const step = text => { job.steps.push({ at: new Date(now()).toISOString(), text }); };
    const running = job;
    (async () => {
      try {
        const call = await session();
        step(`Getting the model ${model.name}`);
        const modelFile = await getFile({ call, deviceId: model.deviceId, fileId: model.id, origin, env });
        let dataset;
        if (version) {
          step(`Getting the dataset version ${version.name}`);
          dataset = (await getFile({ call, deviceId: String(deviceId), fileId: version.id, origin, env })).path;
        } else {
          step(`Copying ${sessionIds.length} QA session(s)`);
          const copied = await copySessions({ call, deviceId: String(deviceId), sessions: sessionIds, frames: frames ?? undefined,
            confirm: Boolean(confirm), origin, env, log: step });
          if (copied.needsConfirmation) {
            running.state = "confirm";
            running.confirm = { frames: copied.sessions.reduce((n, s) => n + s.frames, 0), megabytes: Math.round(copied.totalBytes / 1048576) };
            running.message = `That is ${running.confirm.frames} frames, about ${running.confirm.megabytes} MB. Download them, or choose fewer frames per session.`;
            return;
          }
          step("Cutting the frames into nail slices");
          const prepared = await prepare({ deviceId: String(deviceId), sessions: sessionIds, outputs: "nails", name: `review-${running.id}`, replace: false, env, log: step });
          dataset = prepared.outputs.nails.path;
        }
        const results = [];
        for (const [index, selected] of models.entries()) {
          const file = index === 0 ? modelFile : await getFile({call, deviceId: selected.deviceId, fileId: selected.id, origin, env});
          step(`Looking for ${words} with ${selected.name}`);
          results.push(await scan({ dataset, model: file.path, target: targets.join(","), deviceId: String(deviceId), env, log: step }));
        }
        const result = results[0];
        running.run = result.run;
        running.message = `${result.totals.toReview} slices to review, with ${result.totals.candidateBoxes} possible ${words}.` + (results.length > 1 ? ` Comparing ${results.length} models.` : "");
        await onDone(result.run, results.slice(1).map(r => r.run));
        running.state = "done";
      } catch (error) {
        running.state = "failed";
        running.message = error.message;
      }
    })();
    return current();
  }

  return { options, search, job: current };
}
