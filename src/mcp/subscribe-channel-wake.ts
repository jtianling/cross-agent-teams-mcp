import type Database from 'better-sqlite3'
import { managedDeliveryExists } from '../managed/guard.js'
import { handoffChannelTarget } from '../handoff/guard.js'
import type { ChannelWakeFanout, ChannelWakeSink } from '../daemon/channel-wake-fanout.js'

export const CHANNEL_PROXY_ROLE = '__channel_proxy__'

export interface SubscribeInput {
  callerAgentId: string
  channel_session_id: string
  sessionId: string
  sink: ChannelWakeSink
}

export type SubscribeResult =
  | { ok: true }
  | { error: 'unknown_agent' | 'forbidden_role' | 'invalid_channel_session_id' }

export class SubscribeChannelWakeService {
  constructor(private readonly db: Database.Database, private readonly fanout: ChannelWakeFanout) {}

  subscribe(input: SubscribeInput): SubscribeResult {
    const csid = input.channel_session_id?.trim()
    if (!csid) return { error: 'invalid_channel_session_id' }
    const row = this.db
      .prepare(`SELECT role, device, delivery_kind, claude_ui_pid,
        json_extract(delivery_payload, '$.channel_session_id') AS channel
        FROM agents WHERE agent_id=?`)
      .get(input.callerAgentId) as {
        role: string; device: string; delivery_kind: string; channel: string | null
        claude_ui_pid: number | null
      } | undefined
    if (!row) return { error: 'unknown_agent' }
    if (row.role !== CHANNEL_PROXY_ROLE) return { error: 'forbidden_role' }
    const target = handoffChannelTarget(this.db, row.device, csid)
    if (target && (row.delivery_kind !== 'claude-channel' || row.channel !== csid
      || target.runtime_ui_pid !== row.claude_ui_pid
      || (this.fanout.owner(csid) !== undefined
        && this.fanout.owner(csid) !== input.callerAgentId))) {
      return { error: 'invalid_channel_session_id' }
    }
    if (managedDeliveryExists(this.db, row.device, {
      kind: 'claude-channel', channel_session_id: csid,
    }) && (row.delivery_kind !== 'claude-channel' || row.channel !== csid)) {
      return { error: 'invalid_channel_session_id' }
    }
    this.fanout.attach(csid, input.sink, input.sessionId, input.callerAgentId)
    return { ok: true }
  }
}
