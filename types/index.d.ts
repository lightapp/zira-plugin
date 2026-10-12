// State contract of the Zira Claude Code mod (mods/register.tsx).
// Fleet mirrors the JSON that scripts/fleet.mjs prints.

export type FleetDevice = {
  id: string
  name: string
  type: string | null
  state: 'online' | 'offline' | 'never' | 'unknown'
  bucket: string
  since: string | null
  hours: number | null
  lastSignal: string | null
  reason: string
  url: string | null
  statusFreshness: 'Current' | 'Last known' | 'Unavailable'
  statusText: string
  indicators: Record<'power' | 'network' | 'camera', { label: string; title: string; tone: string }[]>
  statusWarnings: { code: string; title: string }[]
  currentAlerts: { code: string; title: string }[]
}

export type Fleet =
  | {
      ok: true
      profile: string
      company: { id: string; name: string }
      site: { id: string; name: string }
      assessedAt: string
      freshnessMinutes: number
      batteryMinimum: number
      complete: boolean
      omitted: number
      counts: { total: number; online: number; offline: number; never: number; unknown: number; newOffline: number;
        currentAlerts: number; lastKnown: number; unavailable: number; needsCheck: number }
      devices: FleetDevice[]
    }
  | { ok: false; needs: 'sign-in' | 'company' | 'site' | 'error'; message: string; choices?: string[] }

// The Live panel's state, folded from scripts/remote.mjs watch --jsonl lines (mods/live-view.mjs).
export type LiveTarget = { deviceId: string; identity: string | null; minutes: number; profile: 'prod' | 'integ' }
export type LivePoint = { at: string; units: number | null; shiftCount: number | null }
export type LiveView = {
  target: LiveTarget
  dataSource: { id: string; name: string; site: string } | null
  camera: string | null
  liveUrl: string | null
  state: 'connecting' | 'waiting' | 'live' | 'ended' | 'error'
  message: string | null
  latest: { at: string | null; status: string | null; units: number | null; shiftCount: number | null; trigger: string | null;
    values: Record<string, string | number | boolean | null> } | null
  points: LivePoint[]
  messages: number
  startedAt: number
  endsAt: number
}

declare module 'claude-code' {
  interface PluginState {
    zira: { fleet: Fleet | null; isRefreshing: boolean; isBandHidden: boolean; live: LiveView | null }
  }
}
