import type { DeliveryOpencodeServer } from '../lib/delivery-spec.js'
import { canonicalOpencodeBaseUrl } from '../lib/opencode-url.js'
import { resolveAgentType } from '../lib/agent-runtime.js'
import {
  AgentsRepo,
  type OpencodeRuntimeRow,
} from '../storage/agents-repo.js'
import type { OpencodeServerDispatchResult } from './opencode-server-dispatch.js'

export const OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION = 1

export type ExactSessionProbeResult =
  | { ok: true }
  | { error: string; detail?: unknown }

export interface OpencodeRuntimeRecoveryDeps {
  localDevice: string
  probeTimeoutMs?: number
  promptTimeoutMs?: number
  probeExactSession: (args: {
    base_url: string
    session_id: string
    auth_token_ref?: string
  }) => Promise<ExactSessionProbeResult>
  sendRecoveryPrompt: (args: {
    delivery: DeliveryOpencodeServer
    content: string
    signal: AbortSignal
  }) => Promise<OpencodeServerDispatchResult>
}

interface PromptEntry {
  generation: number
  registerGeneration: number
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
  complete?: (result: PromptSendResult) => void
  result?: Promise<PromptSendResult>
  abortController: AbortController
}

type PromptSendResult = { ok: true } | { error: string; detail?: unknown }

const promptSchedules = new Map<string, PromptEntry>()
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_PROMPT_TIMEOUT_MS = 10_000

async function withWallTime<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutResult: T,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => {
      resolve(timeoutResult)
      onTimeout?.()
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function clearAllOpencodeRecoveryPromptSchedules(): void {
  for (const entry of promptSchedules.values()) {
    entry.cancelled = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.abortController.abort()
    entry.complete?.({ error: 'recovery_prompt_cancelled' })
  }
  promptSchedules.clear()
}

export function cancelOpencodeRecoveryPrompt(
  agentId: string,
  generation?: number
): void {
  const entry = promptSchedules.get(agentId)
  if (!entry || (generation !== undefined && entry.generation !== generation)) {
    return
  }
  entry.cancelled = true
  if (entry.timer) clearTimeout(entry.timer)
  entry.abortController.abort()
  promptSchedules.delete(agentId)
  entry.complete?.({ error: 'recovery_prompt_cancelled' })
}

export function __peekOpencodeRecoveryPromptSchedules(): Array<{
  agent_id: string
  runtime_generation: number
}> {
  return Array.from(promptSchedules.entries()).map(([agent_id, entry]) => ({
    agent_id,
    runtime_generation: entry.generation,
  }))
}

export { canonicalOpencodeBaseUrl } from '../lib/opencode-url.js'

export function buildOpencodeRecoveryPrompt(args: {
  base_url: string
  session_id: string
  runtime_generation: number
}): string {
  return [
    '[cross-agent-teams OpenCode recovery]',
    'Read XATS_IDENTITY_KEY from your own environment.',
    'Call the cross-agent-teams MCP tool',
    'reconnect({identity_key: <XATS_IDENTITY_KEY>, agent_type: "opencode",',
    `base_url: "${args.base_url}", session_id: "${args.session_id}",`,
    `runtime_generation: ${args.runtime_generation}}).`,
  ].join(' ')
}

function sameDelivery(
  delivery: DeliveryOpencodeServer,
  args: { base_url: string; session_id: string; runtime_generation: number }
): boolean {
  return canonicalOpencodeBaseUrl(delivery.base_url) === args.base_url
    && delivery.session_id === args.session_id
    && (delivery.runtime_generation ?? 0) === args.runtime_generation
}

function protocolMismatch(protocolVersion: number | undefined): unknown | undefined {
  if (protocolVersion === OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION) {
    return undefined
  }
  return {
    ok: false,
    error: 'protocol_version_mismatch',
    cli_protocol_version: protocolVersion ?? null,
    daemon_protocol_version: OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
  }
}

export class OpencodeRuntimeRecoveryService {
  constructor(
    private readonly repo: AgentsRepo,
    private readonly deps: OpencodeRuntimeRecoveryDeps
  ) {}

  reserve(input: {
    identity_key: string
    runtime_generation: number
    protocol_version?: number
  }): unknown {
    const mismatch = protocolMismatch(input.protocol_version)
    if (mismatch) return mismatch
    const row = this.repo.findOpencodeRuntimeByIdentityKey(
      input.identity_key,
      this.deps.localDevice
    )
    if (!row) {
      return { ok: true, need_register: true, state: 'unregistered' }
    }
    const actualType = resolveAgentType(row)
    if (actualType !== 'opencode') {
      return {
        ok: false,
        error: 'agent_type_conflict',
        expected: 'opencode',
        actual: actualType,
      }
    }
    const current = row.opencode_runtime_generation
    if (input.runtime_generation < current) {
      return {
        ok: false,
        error: 'stale_runtime_generation',
        runtime_generation: input.runtime_generation,
        current_runtime_generation: current,
      }
    }
    if (input.runtime_generation === current) {
      return {
        ok: true,
        state: 'reserved',
        runtime_generation: current,
        changed: false,
      }
    }
    const updated = this.repo.compareAndSetOpencodeRuntimeGeneration({
      agent_id: row.agent_id,
      device: row.device,
      identity_key: input.identity_key,
      expected_generation: current,
      expected_register_generation: row.register_generation,
      runtime_generation: input.runtime_generation,
    })
    if (updated.changes === 0) {
      const latest = this.repo.findOpencodeRuntimeByIdentityKey(
        input.identity_key,
        this.deps.localDevice
      )
      if (
        latest?.agent_id === row.agent_id
        && resolveAgentType(latest) === 'opencode'
        && latest.register_generation === row.register_generation
        && latest.opencode_runtime_generation === input.runtime_generation
      ) {
        return {
          ok: true,
          state: 'reserved',
          runtime_generation: input.runtime_generation,
          changed: false,
        }
      }
      return {
        ok: false,
        error: 'runtime_generation_cas_conflict',
        current_runtime_generation:
          latest?.opencode_runtime_generation ?? null,
      }
    }
    cancelOpencodeRecoveryPrompt(row.agent_id)
    return {
      ok: true,
      state: 'reserved',
      runtime_generation: input.runtime_generation,
      changed: true,
    }
  }

  async commit(input: {
    identity_key: string
    runtime_generation: number
    base_url: string
    session_id: string
    protocol_version?: number
  }): Promise<unknown> {
    const mismatch = protocolMismatch(input.protocol_version)
    if (mismatch) return mismatch
    const baseUrl = canonicalOpencodeBaseUrl(input.base_url)
    const row = this.repo.findOpencodeRuntimeByIdentityKey(
      input.identity_key,
      this.deps.localDevice
    )
    const preflight = this.preflightCommit(row, {
      runtime_generation: input.runtime_generation,
      base_url: baseUrl,
      session_id: input.session_id,
    })
    if ('error' in preflight) return preflight

    const collision = this.repo.findByOpencodeSession(
      baseUrl,
      input.session_id,
      this.deps.localDevice
    ).find(match => match.agent_id !== preflight.row.agent_id)
    if (collision) {
      return {
        ok: false,
        error: 'runtime_delivery_conflict',
        conflicting_agent_id: collision.agent_id,
      }
    }

    let delivery = preflight.delivery
    if (!preflight.idempotent) {
      const probe = await this.probeExactSession({
        base_url: baseUrl,
        session_id: input.session_id,
        auth_token_ref: delivery.auth_token_ref,
      })
      if ('error' in probe) return probe
      const committed = this.repo.compareAndSetOpencodeDelivery({
        agent_id: preflight.row.agent_id,
        device: preflight.row.device,
        identity_key: input.identity_key,
        expected_generation: input.runtime_generation,
        expected_register_generation: preflight.row.register_generation,
        expected_delivery_kind: preflight.row.delivery_kind,
        expected_delivery_payload: preflight.row.delivery_payload,
        delivery,
      })
      if (committed.pair_conflict_agent_id) {
        return {
          ok: false,
          error: 'runtime_delivery_conflict',
          conflicting_agent_id: committed.pair_conflict_agent_id,
        }
      }
      if (committed.changes === 0) {
        const latest = this.repo.findOpencodeRuntimeByIdentityKey(
          input.identity_key,
          this.deps.localDevice
        )
        if (
          latest?.agent_id === preflight.row.agent_id
          && resolveAgentType(latest) === 'opencode'
          && latest.register_generation === preflight.row.register_generation
          && latest.opencode_runtime_generation === input.runtime_generation
          && latest.delivery.kind === 'opencode-server'
          && sameDelivery(latest.delivery, {
            base_url: baseUrl,
            session_id: input.session_id,
            runtime_generation: input.runtime_generation,
          })
        ) {
          delivery = latest.delivery
        } else {
          if (latest && resolveAgentType(latest) !== 'opencode') {
            return {
              ok: false,
              error: 'agent_type_conflict',
              expected: 'opencode',
              actual: resolveAgentType(latest),
            }
          }
          const stale = latest
            && latest.opencode_runtime_generation > input.runtime_generation
          const conflictingDelivery = latest
            && latest.opencode_runtime_generation === input.runtime_generation
            && latest.delivery.kind === 'opencode-server'
            && (latest.delivery.runtime_generation ?? 0)
              === input.runtime_generation
          return {
            ok: false,
            error: stale
              ? 'stale_runtime_generation'
              : conflictingDelivery
                ? 'runtime_generation_conflict'
                : 'runtime_commit_cas_conflict',
            current_runtime_generation:
              latest?.opencode_runtime_generation ?? null,
          }
        }
      }
    } else {
      delivery = preflight.row.delivery as DeliveryOpencodeServer
    }

    const prompt = await this.triggerRecoveryPrompt({
      identity_key: input.identity_key,
      agent_id: preflight.row.agent_id,
      register_generation: preflight.row.register_generation,
      delivery,
    })
    if ('error' in prompt) {
      return {
        ok: false,
        error: 'connection_bind_trigger_failed',
        delivery_committed: true,
        connection_bound: false,
        detail: prompt,
      }
    }
    return {
      ok: true,
      state: 'delivery_committed',
      delivery_committed: true,
      connection_bound: false,
      recovery_prompt: 'scheduled',
    }
  }

  cancelPrompt(agentId: string, generation: number): void {
    cancelOpencodeRecoveryPrompt(agentId, generation)
  }

  async validateReconnect(input: {
    identity_key: string
    runtime_generation: number
    base_url: string
    session_id: string
  }): Promise<
    | { ok: true; row: OpencodeRuntimeRow }
    | { ok?: false; error?: string; [key: string]: unknown }
  > {
    const baseUrl = canonicalOpencodeBaseUrl(input.base_url)
    const row = this.repo.findOpencodeRuntimeByIdentityKey(
      input.identity_key,
      this.deps.localDevice
    )
    if (!row) {
      return {
        need_register: true,
        state: 'unregistered',
        reason: 'identity_key_not_found',
      }
    }
    const actualType = resolveAgentType(row)
    if (actualType !== 'opencode') {
      return {
        ok: false,
        error: 'agent_type_conflict',
        expected: 'opencode',
        actual: actualType,
      }
    }
    if (row.opencode_runtime_generation !== input.runtime_generation) {
      return {
        ok: false,
        error: 'stale_runtime_generation',
        current_runtime_generation: row.opencode_runtime_generation,
      }
    }
    if (
      row.delivery.kind !== 'opencode-server'
      || !sameDelivery(row.delivery, {
        base_url: baseUrl,
        session_id: input.session_id,
        runtime_generation: input.runtime_generation,
      })
    ) {
      return { ok: false, error: 'runtime_delivery_mismatch' }
    }

    const probe = await this.probeExactSession({
      base_url: baseUrl,
      session_id: input.session_id,
      auth_token_ref: row.delivery.auth_token_ref,
    })
    if ('error' in probe) return probe

    const current = this.repo.findOpencodeRuntimeByIdentityKey(
      input.identity_key,
      this.deps.localDevice
    )
    if (
      !current
      || current.agent_id !== row.agent_id
      || resolveAgentType(current) !== 'opencode'
      || current.register_generation !== row.register_generation
      || current.opencode_runtime_generation !== input.runtime_generation
      || current.delivery.kind !== 'opencode-server'
      || !sameDelivery(current.delivery, {
        base_url: baseUrl,
        session_id: input.session_id,
        runtime_generation: input.runtime_generation,
      })
    ) {
      if (current && resolveAgentType(current) !== 'opencode') {
        return {
          ok: false,
          error: 'agent_type_conflict',
          expected: 'opencode',
          actual: resolveAgentType(current),
        }
      }
      return { ok: false, error: 'stale_runtime_generation' }
    }
    return { ok: true, row: current }
  }

  private preflightCommit(
    row: OpencodeRuntimeRow | undefined,
    input: {
      runtime_generation: number
      base_url: string
      session_id: string
    }
  ):
    | {
        row: OpencodeRuntimeRow
        delivery: DeliveryOpencodeServer
        idempotent: boolean
      }
    | { ok: false; error: string; [key: string]: unknown } {
    if (!row) {
      return {
        ok: false,
        error: 'need_register',
        need_register: true,
        state: 'unregistered',
      }
    }
    const actualType = resolveAgentType(row)
    if (actualType !== 'opencode') {
      return {
        ok: false,
        error: 'agent_type_conflict',
        expected: 'opencode',
        actual: actualType,
      }
    }
    const fence = row.opencode_runtime_generation
    if (input.runtime_generation < fence) {
      return {
        ok: false,
        error: 'stale_runtime_generation',
        current_runtime_generation: fence,
      }
    }
    if (input.runtime_generation > fence) {
      return {
        ok: false,
        error: 'runtime_generation_not_reserved',
        current_runtime_generation: fence,
      }
    }
    const stored = row.delivery.kind === 'opencode-server'
      ? row.delivery
      : undefined
    const committedGeneration = stored?.runtime_generation ?? 0
    if (committedGeneration === input.runtime_generation) {
      if (!stored || !sameDelivery(stored, input)) {
        return { ok: false, error: 'runtime_generation_conflict' }
      }
      return { row, delivery: stored, idempotent: true }
    }
    if (committedGeneration > input.runtime_generation) {
      return { ok: false, error: 'runtime_generation_conflict' }
    }
    return {
      row,
      idempotent: false,
      delivery: {
        kind: 'opencode-server',
        base_url: input.base_url,
        session_id: input.session_id,
        runtime_generation: input.runtime_generation,
        ...(stored?.auth_token_ref
          ? { auth_token_ref: stored.auth_token_ref }
          : {}),
      },
    }
  }

  private async triggerRecoveryPrompt(args: {
    identity_key: string
    agent_id: string
    register_generation: number
    delivery: DeliveryOpencodeServer
  }): Promise<PromptSendResult> {
    const generation = args.delivery.runtime_generation ?? 0
    const existing = promptSchedules.get(args.agent_id)
    if (
      existing
      && !existing.cancelled
      && existing.generation === generation
      && existing.registerGeneration === args.register_generation
      && existing.result
    ) {
      return existing.result
    }
    cancelOpencodeRecoveryPrompt(args.agent_id)
    const entry: PromptEntry = {
      generation,
      registerGeneration: args.register_generation,
      cancelled: false,
      abortController: new AbortController(),
    }
    promptSchedules.set(args.agent_id, entry)

    const result = new Promise<PromptSendResult>(resolve => {
      entry.complete = resolve
      entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.sendScheduledPrompt(args, entry).then(
          resolve,
          error => resolve({
            error: 'opencode_inject_failed',
            detail: error instanceof Error ? error.message : String(error),
          })
        )
      }, 0)
    })
    entry.result = result
    return result
  }

  private async sendScheduledPrompt(
    args: {
      identity_key: string
      agent_id: string
      register_generation: number
      delivery: DeliveryOpencodeServer
    },
    entry: PromptEntry
  ): Promise<PromptSendResult> {
    try {
      if (!this.promptStillCurrent(args, entry)) {
        return { error: 'recovery_prompt_cancelled' }
      }
      const content = buildOpencodeRecoveryPrompt({
        base_url: args.delivery.base_url,
        session_id: args.delivery.session_id,
        runtime_generation: entry.generation,
      })
      const send = this.deps.sendRecoveryPrompt({
        delivery: args.delivery,
        content,
        signal: entry.abortController.signal,
      }).catch(error => ({
        error: 'opencode_inject_failed' as const,
        detail: error instanceof Error ? error.message : String(error),
      }))
      const result = await withWallTime<OpencodeServerDispatchResult>(
        send,
        this.deps.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
        { error: 'opencode_inject_failed', detail: 'recovery_prompt_timeout' },
        () => entry.abortController.abort()
      )
      if ('error' in result) return result
      return { ok: true }
    } catch (error) {
      return {
        error: 'opencode_inject_failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (entry.timer) clearTimeout(entry.timer)
      if (promptSchedules.get(args.agent_id) === entry) {
        promptSchedules.delete(args.agent_id)
      }
    }
  }

  private probeExactSession(args: {
    base_url: string
    session_id: string
    auth_token_ref?: string
  }): Promise<ExactSessionProbeResult> {
    return withWallTime<ExactSessionProbeResult>(
      this.deps.probeExactSession(args),
      this.deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      {
        error: 'opencode_unreachable',
        detail: 'exact_session_probe_timeout',
      }
    )
  }

  private promptStillCurrent(
    args: {
      identity_key: string
      agent_id: string
      register_generation: number
      delivery: DeliveryOpencodeServer
    },
    entry: PromptEntry
  ): boolean {
    if (entry.cancelled || promptSchedules.get(args.agent_id) !== entry) {
      return false
    }
    const row = this.repo.findOpencodeRuntimeByIdentityKey(
      args.identity_key,
      this.deps.localDevice
    )
    return row?.agent_id === args.agent_id
      && resolveAgentType(row) === 'opencode'
      && row.register_generation === entry.registerGeneration
      && row.opencode_runtime_generation === entry.generation
      && row.delivery.kind === 'opencode-server'
      && sameDelivery(row.delivery, {
        base_url: canonicalOpencodeBaseUrl(args.delivery.base_url),
        session_id: args.delivery.session_id,
        runtime_generation: entry.generation,
      })
  }
}
