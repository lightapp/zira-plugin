// Fixed package entrypoints. Never accept a script, executable, shell command or API URL.
import { buildInfo } from './build-info.mjs';

const entries = [
  ['build_info', 'scripts/build-info.mjs', ['show'], 'Read the installed Zira version, audience and restrictions.', true],
  ['auth', 'skills/health-report/scripts/health-report.mjs', ['status', 'login', 'logout', 'profiles'], 'Check sign-in, open browser login, or sign out. Never returns tokens. Login/logout change local credentials.'],
  ['inventory', 'scripts/browse.mjs', ['menu', 'companies', 'sites', 'devices', 'dashboards'], 'Find authorized Zira companies, sites, data sources and dashboards.', true],
  ['tasks', 'scripts/tasks.mjs', ['list', 'get', 'create'], 'Read tasks or preview/create a task. Creating can notify the assignee; apply only the user-approved preview.'],
  ['preferences', 'scripts/preferences.mjs', ['show', 'update', 'forget'], 'Read or preview/save confirmed account preferences. update takes its JSON patch in input.'],
  ['data_sources', 'scripts/data-sources.mjs', ['templates', 'create', 'copy', 'builder-link'], 'Find templates, preview/create/copy a data source, or obtain the form editor link.'],
  ['dashboards', 'scripts/dashboards.mjs', ['create', 'copy-mapping', 'copy'], 'Preview/create/copy a dashboard using the existing scope, duplicate and receipt safeguards.'],
  ['dashboard_widgets', 'scripts/dashboard-widgets.mjs', ['context', 'save'], 'Read dashboard context or preview/save widgets. Apply requires the reviewed revision.'],
  ['ai_report', 'scripts/ai-report.mjs', ['dashboards', 'widgets', 'people', 'create', 'draft', 'show', 'update-draft', 'schedule'], 'Preview/create or schedule Zira AI reports. Scheduling can send email; use only approved recipients and schedule.'],
  ['vision', 'scripts/vision.mjs', ['list', 'status', 'mark'], 'Guide vision setup; preview/apply a completed setup step.'],
  ['datasets', 'scripts/datasets.mjs', ['scope', 'find', 'sources', 'datasets', 'open'], 'Find a Zira dataset/model and obtain or open its Zira page.'],
  ['live_view', 'scripts/remote.mjs', ['find', 'open', 'devices', 'status', 'watch'], 'Read camera live status or open live video. Sends the ordinary watcher heartbeat; cannot send camera commands.'],
  ['health_report', 'skills/health-report/scripts/health-report.mjs', ['questions', 'discover', 'inspect', 'validate', 'run', 'prepare-share', 'tasks', 'update-task', 'schedule', 'dashboard-widgets', 'agent-data'], 'Run health reports locally. Task operations preview by default and require approved --apply; schedule only prepares a host handoff.'],
  ['device_status', 'skills/device-status/scripts/device-status.mjs', ['sites', 'check', 'schedule', 'run', 'handoff', 'list', 'remove'], 'Check camera health and manage local status monitors. Does not change devices.'],
  ['health_monitor', 'skills/schedule-health-report/scripts/monitor.mjs', ['sites', 'create', 'run', 'handoff', 'list', 'remove'], 'Manage local recurring health-report configurations. The host activates schedules separately.'],
  ['readings', 'skills/readings-report/scripts/readings.mjs', ['sources', 'fetch', 'datasets', 'describe', 'query', 'report', 'saved', 'reports', 'open', 'serve'], 'Download readings, query the local cache and build/open local HTML reports.'],
  ['scheduled_readings', 'skills/schedule-readings-report/scripts/scheduled-report.mjs', ['plan', 'create', 'run', 'schedule', 'list', 'remove'], 'Build and manage local scheduled readings reports; the host activates schedules separately.'],
  ['trimsaw_sizes', 'skills/validate-trimsaw-sizes/scripts/trimsaw-sizes.mjs', ['windows', 'check', 'report', 'compare'], 'Validate trimsaw sizes from cached readings; write local reports only.'],
  ['trimsaw_calibration', 'skills/calibrate-trimsaw-stops/scripts/calibration.mjs', ['plan'], 'Calculate a historical calibration plan. Does not change a camera.', true],
  ['evaluate_model', 'skills/evaluate-model/scripts/evaluate.mjs', ['status', 'setup', 'fetch', 'find-download', 'run', 'open', 'local-files', 'choose', 'inspect'], 'Prepare/download/evaluate model files locally. setup downloads pinned dependencies and needs user consent; public builds reject .pt.'],
  ['snapshot_sessions', 'skills/evaluate-model/scripts/sessions.mjs', ['list', 'fetch', 'prepare'], 'List/download QA sessions and prepare local evaluation datasets.'],
  ['subset_dataset', 'skills/subset-dataset/scripts/subset.mjs', ['preview', 'create', 'upload'], 'Preview/build a subset locally and prepare its Zira upload. Follow the skill approval and upload handoff.'],
  ['find_defects', 'skills/find-defects/scripts/defects.mjs', ['scan', 'review', 'progress', 'export', 'runs'], 'Rank defect candidates, serve the local human review page and export reviewed data.'],
  ['nail_images', 'skills/inspect-nail-images/scripts/runtime.mjs', ['status', 'setup', 'run'], 'Check/setup the pinned OpenCV runtime or run a packaged nail-image analysis. Setup downloads dependencies and needs user consent.'],
];

export function catalog(info = buildInfo()) {
  return entries.filter(([, script]) => !script.startsWith('skills/') || info.skills.includes(script.split('/')[1]))
    .map(([name, script, commands, description, readOnly = false]) => ({
      name, script, commands,
      tool: { name, description: `${description} Use the matching Zira skill. command=help describes options. Arguments are separate CLI values, without node or a script path. Long calls return a job_id; poll job_status, never resubmit a write.`,
        inputSchema: { type: 'object', properties: {
          command: { type: 'string', enum: [...commands, 'help'] },
          args: { type: 'array', items: { type: 'string', maxLength: 65536 }, maxItems: 128, description: 'CLI arguments after the command, e.g. ["--company-id","123"]. Use absolute file paths.' },
          ...(name === 'preferences' ? { input: { type: 'object', description: 'JSON preference patch for update; passed to stdin.' } } : {}),
        }, required: ['command'], additionalProperties: false },
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !['build_info', 'trimsaw_calibration'].includes(name) },
      },
    }));
}

export function invocation(entry, input, info = buildInfo()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(input)) if (!['command', 'args', ...(entry.name === 'preferences' ? ['input'] : [])].includes(key)) throw new Error(`Unsupported input: ${key}`);
  if (![...entry.commands, 'help'].includes(input.command)) throw new Error('Unsupported command. Use this tool\'s command enum.');
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > 128 || args.some(a => typeof a !== 'string' || a.length > 65536 || a.includes('\0'))) throw new Error('args must be at most 128 bounded strings without NUL.');
  // These options can select executable code or override trusted endpoints; they are not MCP inputs.
  for (const value of args) {
    if (/^--(?:python|tool-root|web-origin)(?:=|$)/.test(value)) throw new Error('Executable and service-origin overrides are unavailable through MCP.');
    if (info.audience === 'public' && /^--with-pt(?:=|$)/.test(value)) throw new Error('Public builds do not support .pt models.');
  }
  if (input.input !== undefined && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw new Error('input must be a JSON object.');
  if (entry.name === 'build_info') {
    if (args.length) throw new Error('build_info takes no args.');
    return [];
  }
  if (entry.name === 'auth') return input.command === 'help' ? ['help'] : ['auth', input.command, ...args];
  // discover is the one supported positional subcommand. No auth/token/request passthrough.
  if (entry.name === 'health_report' && input.command === 'discover' && !['companies', 'sites', 'devices', 'users'].includes(args[0])) throw new Error('discover needs companies, sites, devices or users as its first argument.');
  return [input.command, ...args];
}
