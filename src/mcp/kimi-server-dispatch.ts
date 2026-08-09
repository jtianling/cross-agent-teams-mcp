import type { DeliveryKimiServer } from '../lib/delivery-spec.js'
import { describeError } from './codex-appserver-rpc.js'
import { kimiAuthHeaders, DEFAULT_KIMI_TOKEN_FILE } from './kimi-auth.js'
import { createKimiSessionPrecheck, type KimiPrecheckFn } from './kimi-session-state.js'
import { observeKimiPrompt, type KimiPromptObserveFn } from './kimi-prompt-observe.js'

type FetchLike = typeof globalThis.fetch

export interface KimiServerDispatchDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
  tokenFilePath?: string
  /** Omitted → no precondition gate (pre-gate behaviour). Production callers
   *  go through dispatchKimiServerPokeGated, which supplies the real one. */
  precheck?: KimiPrecheckFn
  /** Omitted → no long-turn observation. Log-only; never aborts. */
  observePrompt?: KimiPromptObserveFn
  /** Records why a poke was deferred. The sub-reasons behind
   *  `kimi_session_busy` (main_turn_active / tui_recent_write /
   *  session_busy_response) are diagnostic, not decision-bearing: a sender
   *  reacts identically to all three. They belong in the daemon log rather
   *  than in every send_message response, which is why they are logged here
   *  instead of being propagated into `poke_skip_reasons`. The
   *  decision-bearing split — retry-able vs needs-a-human — is already
   *  carried by the distinct `kimi_pending_interaction` skip reason. */
  logGate?: (record: Record<string, unknown>) => void
}

export type KimiServerDispatchResult =
  | {
      ok: true
      transport_used: 'kimi-server'
      session_id: string
    }
  | {
      error:
        | 'missing_auth_token'
        | 'kimi_connect_failed'
        | 'kimi_inject_failed'
        | 'kimi_session_busy'
        | 'kimi_pending_interaction'
        | 'kimi_session_archived'
      detail?: unknown
      transport_used?: 'kimi-server'
    }

const MAX_BODY_PREVIEW_BYTES = 4 * 1024

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_PREVIEW_BYTES) return body
  return body.slice(0, MAX_BODY_PREVIEW_BYTES)
}

// POST /prompts may refuse an enqueue outright instead of queueing it. The
// refusal carries SESSION_BUSY as an error code or message and is a deferral,
// not a delivery failure.
function isSessionBusyRejection(bodyText: string): boolean {
  return bodyText.includes('SESSION_BUSY')
}

// Gate records are observation-only: a throwing sink must never block or
// abort the delivery path it is describing.
function emitGateRecord(
  logGate: KimiServerDispatchDeps['logGate'],
  record: Record<string, unknown>
): void {
  try {
    logGate?.(record)
  } catch (error) {
    console.error(
      `kimi gate log sink failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function extractPromptId(bodyText: string): string | undefined {
  if (bodyText === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const data = typeof root.data === 'object' && root.data !== null
    ? (root.data as Record<string, unknown>)
    : root
  const id = data.prompt_id ?? data.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function hasNonZeroErrorCode(bodyText: string): boolean {
  if (bodyText === '') return false
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (typeof parsed !== 'object' || parsed === null) return false
    const code = (parsed as Record<string, unknown>).code
    return typeof code === 'number' && code !== 0
  } catch {
    return false
  }
}

export async function dispatchKimiServerPoke(
  input: {
    delivery: DeliveryKimiServer
    content: string
  },
  deps: KimiServerDispatchDeps = {}
): Promise<KimiServerDispatchResult> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch

  const auth = kimiAuthHeaders(
    input.delivery.auth_token_ref,
    env,
    deps.tokenFilePath ?? DEFAULT_KIMI_TOKEN_FILE
  )
  if ('error' in auth) return auth

  // Check-then-inject, deliberately NOT atomic: a turn can still begin between
  // the probe and the POST. This is a mitigation, not a guarantee.
  if (deps.precheck) {
    const decision = await deps.precheck({
      base_url: input.delivery.base_url,
      session_id: input.delivery.session_id,
      headers: auth.headers,
      fetch: fetchImpl,
    })
    if (decision.decision === 'archived') {
      emitGateRecord(deps.logGate, {
        event: 'kimi_poke_deferred',
        session_id: input.delivery.session_id,
        outcome: 'kimi_session_archived',
      })
      return {
        error: 'kimi_session_archived',
        transport_used: 'kimi-server',
      }
    }
    if (decision.decision === 'pending_interaction') {
      emitGateRecord(deps.logGate, {
        event: 'kimi_poke_deferred',
        session_id: input.delivery.session_id,
        outcome: 'kimi_pending_interaction',
        pending_interaction: decision.pending_interaction,
      })
      return {
        error: 'kimi_pending_interaction',
        detail: { pending_interaction: decision.pending_interaction },
        transport_used: 'kimi-server',
      }
    }
    if (decision.decision === 'defer') {
      emitGateRecord(deps.logGate, {
        event: 'kimi_poke_deferred',
        session_id: input.delivery.session_id,
        outcome: 'kimi_session_busy',
        reason: decision.reason,
      })
      return {
        error: 'kimi_session_busy',
        detail: { reason: decision.reason },
        transport_used: 'kimi-server',
      }
    }
    // The precheck attaches wire_age_ms only when the age is below the
    // observation ceiling, so presence alone means "log the near-window
    // proceed". The record never affects the injection below.
    if (decision.wire_age_ms !== undefined) {
      emitGateRecord(deps.logGate, {
        event: 'kimi_poke_proceeded',
        session_id: input.delivery.session_id,
        wire_age_ms: decision.wire_age_ms,
      })
    }
  }

  const url = `${input.delivery.base_url.replace(/\/+$/, '')}/api/v1/sessions/${encodeURIComponent(input.delivery.session_id)}/prompts`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...auth.headers,
  }
  const body = JSON.stringify({
    content: [{ type: 'text', text: input.content }],
  })

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
    })
  } catch (error) {
    return {
      error: 'kimi_connect_failed',
      detail: describeError(error),
      transport_used: 'kimi-server',
    }
  }

  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }

  if (isSessionBusyRejection(bodyText)) {
    emitGateRecord(deps.logGate, {
      event: 'kimi_poke_deferred',
      session_id: input.delivery.session_id,
      outcome: 'kimi_session_busy',
      reason: 'session_busy_response',
    })
    return {
      error: 'kimi_session_busy',
      detail: { reason: 'session_busy_response' },
      transport_used: 'kimi-server',
    }
  }

  if (!response.ok) {
    return {
      error: 'kimi_inject_failed',
      detail: {
        status: response.status,
        body: truncateBody(bodyText),
      },
      transport_used: 'kimi-server',
    }
  }

  // The kimi server answers application-level failures (e.g. unknown
  // session_id) with HTTP 200 and an error envelope {"code":40401,...}
  // instead of a non-2xx status. Treat a numeric non-zero `code` as an
  // injection failure so dead sessions don't report ok.
  if (hasNonZeroErrorCode(bodyText)) {
    return {
      error: 'kimi_inject_failed',
      detail: {
        status: response.status,
        body: truncateBody(bodyText),
      },
      transport_used: 'kimi-server',
    }
  }

  const promptId = extractPromptId(bodyText)
  if (promptId && deps.observePrompt) {
    deps.observePrompt({
      base_url: input.delivery.base_url,
      session_id: input.delivery.session_id,
      prompt_id: promptId,
      headers: auth.headers,
      fetch: fetchImpl,
    })
  }

  return {
    ok: true,
    transport_used: 'kimi-server',
    session_id: input.delivery.session_id,
  }
}

/**
 * Production entry point: the same dispatcher with the precondition gate and
 * the observe-only long-turn watch wired in.
 */
export async function dispatchKimiServerPokeGated(
  input: {
    delivery: DeliveryKimiServer
    content: string
  },
  deps: KimiServerDispatchDeps = {}
): Promise<KimiServerDispatchResult> {
  return dispatchKimiServerPoke(input, {
    precheck: createKimiSessionPrecheck(),
    observePrompt: observeKimiPrompt,
    logGate: (record) => { console.error(JSON.stringify(record)) },
    ...deps,
  })
}
