import type { AgentListRow } from '../storage/agents-repo.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'

export type PublicDelivery =
  | { kind: 'none' }
  | { kind: 'antigravity-pty' }
  | { kind: 'codex-appserver' }
  | { kind: 'opencode-server' }
  | { kind: 'kimi-server' }
  | { kind: 'claude-channel'; channel_session_id: string }

export interface PublicAgentListRow {
  agent_id: string
  agent_type: AgentListRow['agent_type']
  agent_type_name: AgentListRow['agent_type_name']
  device: string
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  delivery: PublicDelivery
  channel_session_id: string | null
  last_seen_at: string
  online: boolean
}

function projectDelivery(delivery: DeliverySpec): PublicDelivery {
  if (delivery.kind === 'claude-channel') {
    return {
      kind: 'claude-channel',
      channel_session_id: delivery.channel_session_id,
    }
  }
  return { kind: delivery.kind }
}

export function toPublicAgentRow(row: AgentListRow): PublicAgentListRow {
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    device: row.device,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    delivery: projectDelivery(row.delivery),
    channel_session_id:
      row.delivery.kind === 'claude-channel'
        ? row.delivery.channel_session_id
        : null,
    last_seen_at: row.last_seen_at,
    online: row.online,
  }
}
