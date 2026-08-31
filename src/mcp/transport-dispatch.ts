import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { sendChannelWake } from '../daemon/channel-wake-send.js'
import type { AgentType } from '../lib/agent-type.js'
import type { DeliverySpec } from '../lib/delivery-spec.js'
import { resolveAgentType } from '../lib/agent-runtime.js'
import {
  dispatchCodexAppserverPoke,
  type CodexAppserverDispatchResult,
} from './codex-appserver-dispatch.js'
import {
  dispatchOpencodeServerPoke,
  type OpencodeServerDispatchResult,
} from './opencode-server-dispatch.js'
import {
  dispatchKimiServerPokeGated,
  type KimiServerDispatchResult,
} from './kimi-server-dispatch.js'
import type { PaneHostVerdict } from './pane-host-verify.js'

export interface DispatchDeps {
  channelWakeFanout?: ChannelWakeFanout
  tmuxPoke: (args: {
    pane_id: string
    content: string
    skipGuard?: boolean
    confirmOwnership?: () => boolean
  }) => Promise<TmuxPokeResult>
  /** Synchronous current-ownership read, re-run by tmuxPoke just before writing. */
  confirmPaneOwnership?: (args: { row: TargetRow; paneId: string }) => boolean
  // Single gate for every tmux fallback below; omitted only by legacy callers
  // that supply no pane snapshot (tests, in-process fixtures).
  verifyPaneHost?: (args: { row: TargetRow; paneId: string }) => Promise<PaneHostVerdict>
  codexAppserverDispatch?: (args: {
    delivery: Extract<DeliverySpec, { kind: 'codex-appserver' }>
    content: string
  }) => Promise<CodexAppserverDispatchResult>
  opencodeServerDispatch?: (args: {
    delivery: Extract<DeliverySpec, { kind: 'opencode-server' }>
    content: string
  }) => Promise<OpencodeServerDispatchResult>
  kimiServerDispatch?: (args: {
    delivery: Extract<DeliverySpec, { kind: 'kimi-server' }>
    content: string
  }) => Promise<KimiServerDispatchResult>
}

export type TmuxPokeResult =
  | { ok: true; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

export interface TargetRow {
  agent_id: string
  agent_type: AgentType | null
  device: string
  delivery: DeliverySpec
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  opencode_runtime_generation?: number
}

export interface DispatchInput {
  content: string
  meta: Record<string, string>
  skipGuard?: boolean
}

export type DispatchResult =
  | {
      ok: true
      transport_used: 'claude-channel'
      channel_session_id: string
    }
  | {
      ok: true
      transport_used: 'tmux-poke'
      pane_id: string
      pane_tail_before: string
      pane_tail_after: string
    }
  | {
      ok: true
      transport_used: 'codex-appserver'
      thread_id: string
    }
  | {
      ok: true
      transport_used: 'opencode-server'
      session_id: string
    }
  | {
      ok: true
      transport_used: 'kimi-server'
      session_id: string
    }
  | {
      error: string
      detail?: unknown
      transport_used?: 'tmux-poke' | 'codex-appserver' | 'opencode-server' | 'kimi-server'
    }

export async function dispatchPoke(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const agentType = resolveAgentType(target)
  if (agentType === 'claude-code') return dispatchClaude(deps, target, input)
  if (agentType === 'codex') return dispatchCodex(deps, target, input)
  if (agentType === 'opencode') return dispatchOpencode(deps, target, input)
  if (agentType === 'kimi-code') return dispatchKimi(deps, target, input)
  return dispatchUnknown(deps, target, input)
}

// Exported so the poke-side codex carrier gate keys off the same effective
// type this dispatcher routes by (legacy rows may have agent_type=NULL).
export { resolveAgentType } from '../lib/agent-runtime.js'

async function dispatchTmux(
  deps: DispatchDeps,
  target: TargetRow,
  paneId: string,
  content: string,
  skipGuard?: boolean
): Promise<DispatchResult> {
  if (deps.verifyPaneHost) {
    const verdict = await deps.verifyPaneHost({ row: target, paneId })
    if (!verdict.ok) {
      // Unknown ownership is never a licence to inject: an unqueryable tmux is
      // reported as unavailable, which is also what the paste would hit.
      const error = verdict.reason === 'undecidable' ? 'tmux_unavailable' : verdict.reason
      return { error, transport_used: 'tmux-poke' }
    }
  }
  const tmuxResult = await deps.tmuxPoke({
    pane_id: paneId,
    content,
    skipGuard,
    confirmOwnership: deps.confirmPaneOwnership
      ? () => deps.confirmPaneOwnership!({ row: target, paneId })
      : undefined,
  })
  if ('ok' in tmuxResult && tmuxResult.ok) {
    return {
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: paneId,
      pane_tail_before: tmuxResult.pane_tail_before,
      pane_tail_after: tmuxResult.pane_tail_after,
    }
  }
  return {
    ...(tmuxResult as { error: string; detail?: unknown }),
    transport_used: 'tmux-poke',
  }
}

async function dispatchClaude(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const paneId = target.tmux_pane_id
  const channelSubscribed =
    target.delivery.kind === 'claude-channel' &&
    (deps.channelWakeFanout?.has(target.delivery.channel_session_id) ?? false)

  let sinkFailed = false
  if (target.delivery.kind === 'claude-channel' && channelSubscribed && deps.channelWakeFanout) {
    const result = sendChannelWake(
      deps.channelWakeFanout,
      target.delivery.channel_session_id,
      input
    )
    if (result.ok) {
      return {
        ok: true,
        transport_used: 'claude-channel',
        channel_session_id: target.delivery.channel_session_id,
      }
    }
    sinkFailed = result.reason === 'sink_failed'
  }

  if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
  // A subscribed sink that threw is NOT the same as having no transport: the
  // subscriber is still attached and the next attempt may well land, whereas
  // no_transport_available maps to a terminal `no_pane` skip that is never
  // retried.  Collapsing the two would recreate, one layer up, the false
  // signal that fixing the swallowed sink error was meant to remove.
  if (sinkFailed) {
    return {
      error: 'channel_sink_failed',
      detail: { channel_session_id: (target.delivery as { channel_session_id?: string }).channel_session_id },
    }
  }
  return {
    error: 'no_transport_available',
    detail: {
      channel_subscribed: channelSubscribed,
      tmux_pane_set: false,
    },
  }
}

async function dispatchCodex(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const paneId = target.tmux_pane_id
  if (target.delivery.kind === 'codex-appserver') {
    const result = await (deps.codexAppserverDispatch ?? dispatchCodexAppserverPoke)({
      delivery: target.delivery,
      content: input.content,
    })
    if ('ok' in result && result.ok) return result
    if (
      'error' in result &&
      (result.error === 'codex_turn_start_unconfirmed' ||
        result.error === 'codex_wake_unconfirmed')
    ) {
      return result
    }
    if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
    return result
  }
  if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
  return {
    error: 'no_transport_available',
    detail: {
      codex_bound: false,
      tmux_pane_set: false,
    },
  }
}

async function dispatchOpencode(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  if (target.delivery.kind === 'opencode-server') {
    const fence = target.opencode_runtime_generation ?? 0
    const deliveryGeneration = target.delivery.runtime_generation ?? 0
    if (fence > deliveryGeneration) {
      return {
        error: 'runtime_recovering',
        transport_used: 'opencode-server',
      }
    }
    const result = await (deps.opencodeServerDispatch ?? dispatchOpencodeServerPoke)({
      delivery: target.delivery,
      content: input.content,
    })
    return result
  }
  // opencode agent without an opencode-server delivery falls back to tmux
  // (legacy `agent_type='opencode'` callers that did not pass base_url used
  // the tmux runtime-bind path; this branch preserves that behavior).
  const paneId = target.tmux_pane_id
  if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
  return {
    error: 'no_transport_available',
    detail: {
      opencode_bound: false,
      tmux_pane_set: false,
    },
  }
}

async function dispatchKimi(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  if (target.delivery.kind === 'kimi-server') {
    const result = await (deps.kimiServerDispatch ?? dispatchKimiServerPokeGated)({
      delivery: target.delivery,
      content: input.content,
    })
    return result
  }
  // kimi-code agent without a kimi-server delivery falls back to tmux
  // (mirrors the legacy opencode branch: only an explicit kimi-server
  // delivery pins the HTTP transport and forbids tmux fallback).
  const paneId = target.tmux_pane_id
  if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
  return {
    error: 'no_transport_available',
    detail: {
      kimi_bound: false,
      tmux_pane_set: false,
    },
  }
}

async function dispatchUnknown(
  deps: DispatchDeps,
  target: TargetRow,
  input: DispatchInput
): Promise<DispatchResult> {
  const paneId = target.tmux_pane_id
  if (paneId) return dispatchTmux(deps, target, paneId, input.content, input.skipGuard)
  return {
    error: 'no_transport_available',
    detail: {
      channel_subscribed: false,
      tmux_pane_set: false,
    },
  }
}
