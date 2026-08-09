import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type FetchLike = typeof globalThis.fetch

/** A TUI-side turn appends to wire.jsonl continuously while it executes. */
export const TUI_RECENT_WRITE_WINDOW_MS = 10_000

/**
 * Observation ceiling for near-window proceed records (kimi_poke_proceeded):
 * a proceed whose wire age is below it carries the age for logging as a
 * potential near-miss of the busy gate. Observation only — it never converts
 * a proceed into a deferral.
 */
export const DEFAULT_WIRE_AGE_OBSERVE_MS = 120_000

function wireAgeObserveCeilingMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.KIMI_WIRE_AGE_OBSERVE_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WIRE_AGE_OBSERVE_MS
}

export const DEFAULT_KIMI_SESSIONS_ROOT = join(homedir(), '.kimi-code', 'sessions')

/** Absent fields mean "the probe could not answer" and MUST fail open. */
export interface KimiSessionSignal {
  main_turn_active?: boolean
  pending_interaction?: string
  archived?: boolean
}

export type KimiPrecheckDecision =
  | { decision: 'proceed'; wire_age_ms?: number }
  | { decision: 'defer'; reason: 'main_turn_active' | 'tui_recent_write' }
  | { decision: 'pending_interaction'; pending_interaction: string }
  | { decision: 'archived' }

export interface KimiPrecheckArgs {
  base_url: string
  session_id: string
  headers: Record<string, string>
  fetch: FetchLike
}

export type KimiPrecheckFn = (args: KimiPrecheckArgs) => Promise<KimiPrecheckDecision>

export function kimiSessionUrl(base_url: string, session_id: string): string {
  return `${base_url.replace(/\/+$/, '')}/api/v1/sessions/${encodeURIComponent(session_id)}`
}

export { canonicalKimiBaseUrl } from '../lib/kimi-url.js'

/**
 * Unwrap a kimi REST envelope. Returns undefined for unparseable bodies and
 * non-zero `code` error envelopes; callers decide whether that fails open
 * (busy gate) or closed (reconnect revalidation).
 */
export function parseEnvelopeData(
  bodyText: string
): Record<string, unknown> | undefined {
  if (bodyText === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const code = root.code
  if (typeof code === 'number' && code !== 0) return undefined
  const data = root.data
  if (typeof data === 'object' && data !== null) return data as Record<string, unknown>
  return root
}

/**
 * Strict envelope variant for fail-closed callers (reconnect revalidation):
 * the body must be a real kimi success envelope — object root, `code` exactly
 * 0, and an object (non-array) `data`. No root fallback: a bare 2xx JSON
 * object is not proof that the server recognized the session.
 */
export function parseStrictEnvelopeData(
  bodyText: string
): Record<string, unknown> | undefined {
  if (bodyText === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const root = parsed as Record<string, unknown>
  if (root.code !== 0) return undefined
  const data = root.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined
  }
  return data as Record<string, unknown>
}

/**
 * GET the session row. Every failure path resolves to an empty signal so the
 * caller degrades to un-gated injection rather than to a delivery outage.
 */
export async function probeKimiSessionState(
  args: KimiPrecheckArgs
): Promise<KimiSessionSignal> {
  let response: Response
  try {
    response = await args.fetch(kimiSessionUrl(args.base_url, args.session_id), {
      method: 'GET',
      headers: args.headers,
    })
  } catch {
    return {}
  }
  if (!response.ok) return {}

  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    return {}
  }

  const data = parseEnvelopeData(bodyText)
  if (!data) return {}

  const signal: KimiSessionSignal = {}
  if (typeof data.main_turn_active === 'boolean') {
    signal.main_turn_active = data.main_turn_active
  }
  if (typeof data.pending_interaction === 'string') {
    signal.pending_interaction = data.pending_interaction
  }
  if (typeof data.archived === 'boolean') {
    signal.archived = data.archived
  }
  return signal
}

function findWireLog(sessionsRoot: string, sessionId: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const candidate = join(sessionsRoot, entry, sessionId, 'agents', 'main', 'wire.jsonl')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Age of the session's wire log in milliseconds, or undefined when the log is
 * missing or unreadable ("no signal").
 */
export function wireLogAgeMs(args: {
  session_id: string
  sessionsRoot?: string
  now?: number
}): number | undefined {
  const root = args.sessionsRoot ?? DEFAULT_KIMI_SESSIONS_ROOT
  const path = findWireLog(root, args.session_id)
  if (!path) return undefined
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return undefined
  }
  return (args.now ?? Date.now()) - mtimeMs
}

/**
 * Heuristic for "a turn is running in the TUI", which the REST probe cannot
 * observe. Only the path is coupled, not the file format. A missing or
 * unreadable log is "no signal" (false), never a deferral.
 */
export function isWireLogRecent(args: {
  session_id: string
  sessionsRoot?: string
  now?: number
  windowMs?: number
}): boolean {
  const age = wireLogAgeMs(args)
  if (age === undefined) return false
  const windowMs = args.windowMs ?? TUI_RECENT_WRITE_WINDOW_MS
  return age < windowMs
}

/**
 * Precondition gate. Precedence: archived (never retried) → pending_interaction
 * (never retried) → main_turn_active → recent TUI write → proceed. Deliberately
 * gated on main_turn_active and not on `busy`, which also counts background
 * tasks that do not conflict with an injected prompt.
 *
 * `archived` comes first and is the only permanent refusal: kimi treats the
 * flag as list visibility, not admission control, so a prompt posted to an
 * abandoned session is accepted and queued where nobody is watching. Nothing
 * downstream would surface that, which makes this gate the only place a stale
 * delivery coordinate stops being a silent misroute. It stays fail-OPEN like
 * the rest: an unreadable probe yields no flag and injection proceeds.
 */
export function createKimiSessionPrecheck(opts: {
  sessionsRoot?: string
  now?: () => number
  windowMs?: number
  env?: NodeJS.ProcessEnv
} = {}): KimiPrecheckFn {
  return async (args) => {
    const signal = await probeKimiSessionState(args)
    if (signal.archived === true) return { decision: 'archived' }
    if (signal.pending_interaction !== undefined && signal.pending_interaction !== 'none') {
      return {
        decision: 'pending_interaction',
        pending_interaction: signal.pending_interaction,
      }
    }
    if (signal.main_turn_active === true) {
      return { decision: 'defer', reason: 'main_turn_active' }
    }
    const age = wireLogAgeMs({
      session_id: args.session_id,
      sessionsRoot: opts.sessionsRoot,
      now: opts.now?.(),
    })
    const windowMs = opts.windowMs ?? TUI_RECENT_WRITE_WINDOW_MS
    if (age !== undefined && age < windowMs) {
      return { decision: 'defer', reason: 'tui_recent_write' }
    }
    // A below-ceiling age rides along for observability only
    // (kimi_poke_proceeded); the proceed decision is already made here.
    const ceilingMs = wireAgeObserveCeilingMs(opts.env ?? process.env)
    return age !== undefined && age < ceilingMs
      ? { decision: 'proceed', wire_age_ms: age }
      : { decision: 'proceed' }
  }
}
