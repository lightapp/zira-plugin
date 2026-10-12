// Claude Code mod (terminal and desktop Code tab; Codex has no equivalent): a Device Status band
// above the prompt, a /zira:device-status-panel pane, a status line entry and a toast when a data source
// changes state. A Live pane (/zira:live-panel, or the live_panel tool Claude calls) streams one
// camera's live counts from scripts/remote.mjs watch while it is open, for at most an hour. Data comes from scripts/fleet.mjs (read-only, the health report's own
// online/offline rules) for the account's saved default company and site (plugin settings
// only as a fallback), on request or every
// 10 minutes when the user enables automatic refresh in plugin settings. The
// result is shared across sessions in $.store, so several open sessions poll once.
import { automaticRefreshAllowed } from './distribution.mjs'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fleet, LiveTarget, LiveView } from '../types'
import { REFRESH_MS, changes, clean, fleetArgs, paneCounts, paneNote, paneTable, parseFleet, startFleetRefresh, summary } from './fleet-view.mjs'
import { endLive, failLive, liveArgs, liveHeadline, liveTable, liveTarget, reduceLive, sparkline, startLive, trendSvg } from './live-view.mjs'

const PANE = 'zira-device-status'
const fleet = atom({ plugin: 'zira', key: 'fleet' } as const, null as Fleet | null)
const isRefreshing = atom({ plugin: 'zira', key: 'isRefreshing' } as const, false)
const isBandHidden = atom({ plugin: 'zira', key: 'isBandHidden' } as const, false)
const LIVE_PANE = 'zira-live'
const live = atom({ plugin: 'zira', key: 'live' } as const, null as LiveView | null)
// The running watcher; leaving its loop (or a module reload) ends the child process.
let liveStream: { return?: () => unknown } | null = null


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

function stopLive() {
  const stream = liveStream
  liveStream = null
  void stream?.return?.()
}

async function watchLive($: EngineInterface, target: LiveTarget) {
  stopLive()
  await $.store.set('liveTarget', target)
  await update($, live, () => startLive(target, Date.now()))
  await $.ui.open({ id: LIVE_PANE, title: 'Zira Live' })
  const stream = $.process.spawn({ argv: ['node', `${$.plugin.root}/scripts/remote.mjs`, 'watch', ...liveArgs(target)] })
  liveStream = stream as unknown as { return?: () => unknown }
  void (async () => {
    let buffer = ''
    try {
      for await (const piece of stream) {
        if (liveStream !== (stream as unknown)) break
        if (piece.stream !== 'stdout') continue
        buffer += piece.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) await update($, live, s => reduceLive(s, line))
      }
    } catch (error) {
      await update($, live, s => failLive(s, `Couldn't run Node.js 20+: ${String((error as Error)?.message ?? error)}`))
    } finally {
      if (liveStream === (stream as unknown)) liveStream = null
      await update($, live, s => endLive(s))
    }
  })().catch(() => {}) // The session or module may be gone by the time the child ends.
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
    // Claude opens the Live pane through this tool when the user asks to watch a camera here.
    await $.tool.register({
      name: 'live_panel',
      description: 'Open the Zira Live panel in Claude Code: streams one Vision or Pallet Vision camera\'s live counts and status beside the chat while it is open (read-only; nothing is sent to the camera except the live-data heartbeat). Use only when the user asks to watch a camera here. Resolve the data source ID first (zira:live-view skill).',
      inputSchema: { type: 'object', properties: {
        dataSourceId: { type: 'string', description: 'Zira data source ID of the Vision or Pallet Vision camera' },
        identity: { type: 'string', description: 'Optional camera identity (us-west-2:…) when several paired cameras are online' },
        minutes: { type: 'integer', minimum: 1, maximum: 60, description: 'How long to stream (default 10)' },
        profile: { type: 'string', enum: ['prod', 'integ'] },
      }, required: ['dataSourceId'] },
    })
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

  on('tool.call', { tool: 'mcp__zira__live_panel' }, async ($, e) => {
    let target: LiveTarget
    try {
      target = liveTarget(e as Record<string, unknown>) as LiveTarget
    } catch (error) {
      return { deny: (error as Error).message }
    }
    await watchLive($, target)
    return { result: `Opened the Zira Live panel for data source ${target.deviceId} for ${target.minutes} min. It shows live counts and status; the user can stop it there.` }
  })

  on('command.run', { command: 'zira:live-panel' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    const saved = (await $.store.get('liveTarget')) as LiveTarget | undefined
    if (!arg && !saved) {
      await update($, live, () => null)
      await $.ui.open({ id: LIVE_PANE, title: 'Zira Live' })
      return { text: 'Opened the Zira Live panel. Ask Claude to watch a camera, or run /zira:live-panel <data source ID>.' }
    }
    try {
      const target = liveTarget(arg ? { dataSourceId: arg.split(/\s+/)[0], identity: arg.split(/\s+/)[1] } : saved)
      await watchLive($, target as LiveTarget)
      return { text: `Opened the Zira Live panel for data source ${target.deviceId}.` }
    } catch (error) {
      return { text: (error as Error).message }
    }
  })

  on('ui.render', { component: 'Pane', requestId: LIVE_PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Markdown, Text, Link } = table
    const state = await read($, live)
    const now = Date.now()
    const running = liveStream !== null
    const svg = state && 'Svg' in table ? trendSvg(state.points) : null
    const Svg = (table as { Svg?: typeof Text }).Svg
    const trend = state && !svg ? sparkline(state.points, 'units', Math.max(10, (e.props.bodyColumns ?? 40) - 12)) : ''

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold wrap="truncate-end">{state?.dataSource ? clean(state.dataSource.name) : 'Zira Live'}</Text>
          {state && (running
            ? <Button key="stop" label="Stop" onPress={() => { stopLive() }} />
            : <Button key="again" label="Watch again" onPress={() => watchLive($, state.target)} />)}
        </Box>
        {state?.dataSource && <Text dimColor wrap="truncate-end">{clean(state.dataSource.site)}{state.camera ? ` · camera ${clean(state.camera).slice(-12)}` : ''}</Text>}
        <Text color={state?.state === 'error' ? 'red' : undefined}>{liveHeadline(state, now)}</Text>
        {state?.latest && <Markdown key="values" text={liveTable(state)} />}
        {svg && Svg ? <Svg source={svg} alt="Units over time since the panel opened" /> : null}
        {trend ? <Text dimColor>Units per update {trend}</Text> : null}
        {state?.liveUrl && <Link key="open" href={new URL(state.liveUrl).href} label="Open live video in Zira" />}
      </Box>
    )
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
