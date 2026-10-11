// Claude Code mod (terminal and desktop Code tab; Codex has no equivalent): a Device Status band
// above the prompt, a /zira:device-status-panel pane, a status line entry and a toast when a data source
// changes state. Data comes from scripts/fleet.mjs (read-only, the health report's own
// online/offline rules) for the account's saved default company and site (plugin settings
// only as a fallback), on request or every
// 10 minutes when the user enables automatic refresh in plugin settings. The
// result is shared across sessions in $.store, so several open sessions poll once.
import { automaticRefreshAllowed } from './distribution.mjs'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fleet } from '../types'
import { REFRESH_MS, changes, clean, fleetArgs, paneCounts, paneNote, paneTable, parseFleet, startFleetRefresh, summary } from './fleet-view.mjs'

const PANE = 'zira-device-status'
const fleet = atom({ plugin: 'zira', key: 'fleet' } as const, null as Fleet | null)
const isRefreshing = atom({ plugin: 'zira', key: 'isRefreshing' } as const, false)
const isBandHidden = atom({ plugin: 'zira', key: 'isBandHidden' } as const, false)


// The saved defaults, set by register (a change in plugin settings reloads the module).
let args: string[] = []
let cacheKey = '[]'

async function show($: EngineInterface, result: Fleet) {
  await update($, fleet, () => result)
  await $.ui.status(summary(result, await $.clock.now()).status)
}

async function refresh($: EngineInterface, isForced = false) {
  if (await read($, isRefreshing)) return
  const now = await $.clock.now()
  const cached = (await $.store.get('fleet')) as { key: string; at: number; result: Fleet } | undefined
  if (cached?.key === cacheKey && (await read($, fleet)) === null) await show($, cached.result)
  if (!isForced && cached?.key === cacheKey && now - cached.at < REFRESH_MS - 30000) return
  await update($, isRefreshing, () => true)
  try {
    let result: Fleet
    try {
      result = parseFleet(await $.process.run(['node', `${$.plugin.root}/scripts/fleet.mjs`, ...args], { timeoutMs: 180000 }))
    } catch (error) {
      result = { ok: false, needs: 'error', message: `Couldn't run Node.js 20+: ${String((error as Error)?.message ?? error).slice(0, 120)}` }
    }
    const previous = cached?.key === cacheKey ? cached.result : null
    for (const line of changes(previous, result)) $.ui.toast(line)
    // A failed refresh keeps the last good result instead of blanking the band.
    if (!result.ok && previous?.ok && result.needs === 'error') {
      $.ui.toast(`Device Status refresh failed: ${clean(result.message)}`)
      return
    }
    await $.store.set('fleet', { key: cacheKey, at: await $.clock.now(), result })
    await show($, result)
  } finally {
    await update($, isRefreshing, () => false)
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Device Status' })
}

async function setBandHidden($: EngineInterface, isHidden: boolean) {
  await $.store.set('bandHidden', isHidden)
  await update($, isBandHidden, () => isHidden)
}

export const register: Register = (on, options) => {
  const autoRefresh = automaticRefreshAllowed && options.fleet_auto_refresh === true
  args = fleetArgs(options)
  cacheKey = `device-status-v3:${JSON.stringify(args)}`

  on('session.start', async ($, e, next) => {
    const isHidden = (await $.store.get('bandHidden')) === true
    await update($, isBandHidden, () => isHidden)
    if (autoRefresh) $.ui.status(summary(null, 0).status)
    startFleetRefresh({
      after: (ms: number, callback: () => void) => $.clock.after(ms, callback),
      every: (ms: number, callback: () => void) => $.clock.every(ms, callback),
    }, () => refresh($), autoRefresh)

    return next(e)
  })

  // A normal commands/ entry puts this in both Desktop's and the terminal's catalog.
  // Handling an unknown dynamic name can open the pane yet leave a Desktop warning.
  on('command.run', { command: 'zira:device-status-panel' }, async $ => {
    await openPane($)
    await refresh($, true)

    return { text: 'Opened the Device Status pane.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    if (!autoRefresh && !(await read($, fleet))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = summary(await read($, fleet), await $.clock.now())

    return (
      <Box>
        <Text color={s.tone === 'alert' ? 'red' : undefined} dimColor={s.tone !== 'alert'} wrap="truncate-end">
          {s.band}{' '}
        </Text>
        <Button key="open" label="Open panel" onPress={() => openPane($)} />
        <Button
          key="hide"
          label="Hide"
          onPress={async () => {
            await setBandHidden($, true)
            $.ui.toast('Zira Device Status band hidden. Type /zira:device-status-panel to see device status or bring the band back.')
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const result = await read($, fleet)
    const now = await $.clock.now()
    const busy = await read($, isRefreshing)
    const hidden = await read($, isBandHidden)
    const note = result?.ok ? paneNote(result) : ''

    // A Markdown table gives every surface real rows and columns, one row per device.
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">{result?.ok ? clean(result.site.name) : 'Device Status'}</Text>
          <Button key="refresh" label={busy ? 'Refreshing…' : 'Refresh'} onPress={() => refresh($, true)} />
        </Box>
        {result?.ok && <Text dimColor>{clean(result.company.name)} · {busy ? 'refreshing…' : paneCounts(result, now)}</Text>}
        {!result && <Text dimColor>{busy ? 'Refreshing…' : 'Checking devices…'}</Text>}
        {result && !result.ok && <Text>{summary(result, now).band.replace(/^Device Status · /, '')}</Text>}
        {result && !result.ok && result.choices?.length ? <Text dimColor>Available: {result.choices.map(clean).join(', ')}</Text> : null}
        {result?.ok && result.devices.length > 0 && <Markdown key="devices" text={paneTable(result, now)} />}
        {note && <Text dimColor>{note}</Text>}
        {hidden && (
          <Box marginTop={1}>
            <Button key="band" label="Show band" onPress={() => setBandHidden($, false)} />
          </Box>
        )}
      </Box>
    )
  })
}
