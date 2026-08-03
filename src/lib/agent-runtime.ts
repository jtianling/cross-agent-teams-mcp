import type { AgentType } from './agent-type.js'
import type { DeliverySpec } from './delivery-spec.js'

export interface EffectiveAgentTypeRow {
  agent_type: AgentType | null | undefined
  delivery: DeliverySpec
}

export interface OpencodeRuntimeStateRow extends EffectiveAgentTypeRow {
  opencode_runtime_generation?: number | null
}

export function resolveAgentType(
  row: EffectiveAgentTypeRow
): AgentType | null {
  if (row.agent_type) return row.agent_type
  if (row.delivery.kind === 'claude-channel') return 'claude-code'
  if (row.delivery.kind === 'codex-appserver') return 'codex'
  if (row.delivery.kind === 'opencode-server') return 'opencode'
  if (row.delivery.kind === 'kimi-server') return 'kimi-code'
  return null
}

export function isGenerationAwareOpencodeRow(
  row: OpencodeRuntimeStateRow | undefined
): boolean {
  if (!row || resolveAgentType(row) !== 'opencode') return false
  const deliveryGeneration = row.delivery.kind === 'opencode-server'
    ? row.delivery.runtime_generation ?? 0
    : 0
  return (row.opencode_runtime_generation ?? 0) > 0
    || deliveryGeneration > 0
}
