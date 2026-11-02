import type Database from 'better-sqlite3'
import { CodexBindingRepo } from './codex-binding-repo.js'
import { AgentsRepo } from '../storage/agents-repo.js'

export type LaunchBindingReason =
  | 'challenge_expired' | 'challenge_invalid' | 'pre_registration_missing'
  | 'launch_changed' | 'verification_failed' | 'binding_not_verified'
  | 'registration_changed'

export type CodexLaunchBinding =
  | { status: 'bound'; pane_id: string; launch_id: string }
  | { status: 'unbound'; reason: LaunchBindingReason;
      retry?: 'launcher_pre_register' }

export interface CodexPaneBindAttempt {
  bound: boolean
  feedback: CodexLaunchBinding
}

export function unboundLaunch(
  reason: LaunchBindingReason, hasChallenge = true
): CodexPaneBindAttempt {
  return { bound: false, feedback: {
    status: 'unbound', reason,
    ...(hasChallenge ? { retry: 'launcher_pre_register' as const } : {}),
  } }
}

export function verifiedLaunchBinding(
  db: Database.Database, agentId: string, localDevice: string,
  runtimeVerified: boolean, expectedGeneration: number, hasChallenge = false,
): CodexLaunchBinding {
  const registration = db.prepare(
    'SELECT register_generation FROM agents WHERE agent_id=?'
  ).get(agentId) as { register_generation: number } | undefined
  if (registration?.register_generation !== expectedGeneration) {
    return unboundLaunch('registration_changed', hasChallenge).feedback
  }
  const agent = new AgentsRepo(db).findById(agentId)
  const repo = new CodexBindingRepo(db)
  const row = runtimeVerified && agent?.tmux_pane_id
    ? repo.read(agent.tmux_pane_id) : undefined
  if (!row || row.agent_id !== agentId || row.thread_id === null
    || !repo.matchesAgent(row, localDevice)) {
    return unboundLaunch('binding_not_verified', hasChallenge).feedback
  }
  return { status: 'bound', pane_id: row.pane_id, launch_id: row.launch_id }
}

export const LAUNCH_BINDING_RETRY_HINT =
  'Identity registration succeeded, but launch binding is incomplete. ' +
  'Ask the launcher to pre_register_codex_pane for its verified current ' +
  'pane and launch, then register the same explicit identity with the new ' +
  'challenge. Do not infer a binding from cwd, old pane metadata or loaded threads.'
