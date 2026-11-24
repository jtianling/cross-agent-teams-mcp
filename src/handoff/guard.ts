import type Database from 'better-sqlite3'
import type { DeliverySpec } from '../lib/delivery-spec.js'
import { parseDeliveryRow } from '../lib/delivery-spec.js'
import { sameRuntimeAddress } from '../managed/coordinates.js'

export function exactHandoffDelivery(a: DeliverySpec, b: DeliverySpec): boolean {
  if (!sameRuntimeAddress(a, b)) return false
  if (a.kind !== 'codex-appserver' || b.kind !== a.kind) return true
  return new URL(a.ws_url).href === new URL(b.ws_url).href
}

export function handoffEpoch(db: Database.Database, agentId: string): number {
  const row = db.prepare(`SELECT MAX(committed_generation) AS generation
    FROM runtime_handoffs WHERE agent_id=?`)
    .get(agentId) as { generation: number | null }
  return row.generation ?? 0
}

export function handoffChannelTarget(db: Database.Database,
  device: string, channel: string,
): { runtime_ui_pid: number | null } | undefined {
  return db.prepare(`SELECT runtime_ui_pid FROM agents a WHERE device=?
    AND delivery_kind='claude-channel'
    AND json_extract(delivery_payload,'$.channel_session_id')=?
    AND EXISTS (SELECT 1 FROM runtime_handoffs h WHERE h.agent_id=a.agent_id
      AND h.committed_generation IS NOT NULL)`)
    .get(device, channel) as { runtime_ui_pid: number | null } | undefined
}

export function handoffRegistrationAllowed(db: Database.Database, input: {
  device: string; name: string; team: string; agent_type?: string
  identity_key?: string; runtime_ui_pid?: number; delivery?: DeliverySpec
  role?: string; claude_ui_pid?: number
}): boolean {
  const rows = db.prepare(`SELECT a.* FROM agents a WHERE a.device=?
    AND EXISTS (SELECT 1 FROM runtime_handoffs h WHERE h.agent_id=a.agent_id
      AND h.committed_generation IS NOT NULL)`).all(input.device) as Array<{
    name: string; team: string; agent_type: string; identity_key: string | null
    runtime_ui_pid: number | null; delivery_kind: string
    delivery_payload: string | null
  }>
  return rows.every(row => {
    const ownsName = row.name === input.name && row.team === input.team
    const ownsKey = input.identity_key !== undefined
      && row.identity_key === input.identity_key
    const delivery = parseDeliveryRow(row)
    if (!ownsName && !ownsKey) {
      if (input.role === '__channel_proxy__' && input.delivery
        && row.agent_type === 'claude-code'
        && row.runtime_ui_pid === input.claude_ui_pid
        && exactHandoffDelivery(delivery, input.delivery)) return true
      if (input.agent_type === 'claude-code'
        && input.role !== '__channel_proxy__'
        && input.runtime_ui_pid !== undefined
        && input.runtime_ui_pid === row.runtime_ui_pid) return false
      return !input.delivery || !sameRuntimeAddress(delivery, input.delivery)
    }
    if (!ownsName || row.agent_type !== input.agent_type
      || (input.identity_key !== undefined
        && input.identity_key !== row.identity_key)) return false
    if (input.delivery) return exactHandoffDelivery(delivery, input.delivery)
    return input.agent_type === 'claude-code'
      && input.runtime_ui_pid !== undefined
      && input.runtime_ui_pid === row.runtime_ui_pid
  })
}
