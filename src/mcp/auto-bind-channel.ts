import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { CHANNEL_PROXY_ROLE } from './subscribe-channel-wake.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import { isGenerationAwareOpencodeRow } from '../lib/agent-runtime.js'

const LIVE_WINDOW_MS = 5 * 60 * 1000

export interface AutoBindInput {
  callerAgentId: string
  ui_pid: number
  device?: string
}

export interface LookupInput {
  ui_pid: number
  device: string
}

export interface AutoBindSuccess {
  ok: true
  channel_session_id: string
}

export interface AutoBindMiss {
  ok: false
  reason:
    | 'no_proxy_row'
    | 'proxy_payload_corrupt'
    | 'sink_not_live'
    | 'opencode_runtime_coordinates_required'
}

export type AutoBindResult = AutoBindSuccess | AutoBindMiss

export interface LookupSuccess {
  ok: true
  channel_session_id: string
}

export interface LookupMiss {
  ok: false
  reason: 'no_proxy_row' | 'proxy_payload_corrupt'
}

export type LookupResult = LookupSuccess | LookupMiss

interface ProxyRow {
  delivery_payload: string | null
}

/**
 * Best-effort: match a live __channel_proxy__ row keyed on claude_ui_pid, and
 * write the caller's delivery to that proxy's csid.  Failure returns `ok:false`
 * with a reason — the caller treats this as "no auto-bind performed" and leaves
 * existing delivery unchanged.
 */
export class AutoBindChannelService {
  private readonly repo: AgentsRepo

  constructor(
    private readonly db: Database.Database,
    private readonly fanout: ChannelWakeFanout
  ) {
    this.repo = new AgentsRepo(db)
  }

  lookup(input: LookupInput): LookupResult {
    return this.findLiveProxyCsid(input)
  }

  run(input: AutoBindInput): AutoBindResult {
    const callerDevice = input.device !== undefined
      ? { device: input.device }
      : this.db.prepare(
          `SELECT device FROM agents WHERE agent_id = ?`
        ).get(input.callerAgentId) as { device: string } | undefined
    const device = callerDevice?.device
    if (!device) return { ok: false, reason: 'no_proxy_row' }
    const found = this.findLiveProxyCsid({ ui_pid: input.ui_pid, device })
    if (!found.ok) return found
    const csid = found.channel_session_id
    if (!this.fanout.has(csid)) return { ok: false, reason: 'sink_not_live' }
    const tx = this.db.transaction((): AutoBindResult => {
      const caller = this.repo.findById(input.callerAgentId)
      if (!caller) return { ok: false, reason: 'no_proxy_row' }
      if (isGenerationAwareOpencodeRow(caller)) {
        return {
          ok: false,
          reason: 'opencode_runtime_coordinates_required',
        }
      }
      this.repo.setDelivery(input.callerAgentId, {
        kind: 'claude-channel',
        channel_session_id: csid,
      })
      return { ok: true, channel_session_id: csid }
    })
    return tx()
  }

  private findLiveProxyCsid(input: LookupInput): LookupResult {
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS).toISOString()
    const row = this.db
      .prepare(
        `SELECT delivery_payload
         FROM agents
         WHERE role = ?
           AND device = ?
           AND claude_ui_pid = ?
           AND last_seen_at > ?
         ORDER BY last_seen_at DESC
         LIMIT 1`
      )
      .get(CHANNEL_PROXY_ROLE, input.device, input.ui_pid, cutoff) as ProxyRow | undefined
    if (!row) return { ok: false, reason: 'no_proxy_row' }
    const csid = extractCsid(row.delivery_payload)
    if (!csid) return { ok: false, reason: 'proxy_payload_corrupt' }
    return { ok: true, channel_session_id: csid }
  }
}

function extractCsid(payload: string | null): string | null {
  if (payload === null) return null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const csid = parsed.channel_session_id
    if (typeof csid !== 'string' || csid.length === 0) return null
    return csid
  } catch {
    return null
  }
}
