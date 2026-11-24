export const agentTypes = [
  'codex', 'claude-code', 'opencode', 'kimi-code', 'antigravity', 'custom',
] as const

export type AgentType = typeof agentTypes[number]
