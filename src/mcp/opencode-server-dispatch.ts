import type { DeliveryOpencodeServer } from '../lib/delivery-spec.js'
import { describeError } from './codex-appserver-rpc.js'
import { opencodeAuthHeaders } from './opencode-auth.js'

type FetchLike = typeof globalThis.fetch

export interface OpencodeServerDispatchDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
}

export type OpencodeServerDispatchResult =
  | {
      ok: true
      transport_used: 'opencode-server'
      session_id: string
    }
  | {
      error:
        | 'missing_auth_token'
        | 'opencode_connect_failed'
        | 'opencode_inject_failed'
      detail?: unknown
      transport_used?: 'opencode-server'
    }

const MAX_BODY_PREVIEW_BYTES = 4 * 1024

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_PREVIEW_BYTES) return body
  return body.slice(0, MAX_BODY_PREVIEW_BYTES)
}

export async function dispatchOpencodeServerPoke(
  input: {
    delivery: DeliveryOpencodeServer
    content: string
    signal?: AbortSignal
  },
  deps: OpencodeServerDispatchDeps = {}
): Promise<OpencodeServerDispatchResult> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch

  const auth = opencodeAuthHeaders(input.delivery.auth_token_ref, env)
  if ('error' in auth) return auth

  const url = `${input.delivery.base_url.replace(/\/+$/, '')}/session/${encodeURIComponent(input.delivery.session_id)}/prompt_async`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...auth.headers,
  }
  const body = JSON.stringify({
    parts: [{ type: 'text', text: input.content }],
    noReply: false,
  })

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: input.signal,
    })
  } catch (error) {
    return {
      error: 'opencode_connect_failed',
      detail: describeError(error),
      transport_used: 'opencode-server',
    }
  }

  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      bodyText = ''
    }
    return {
      error: 'opencode_inject_failed',
      detail: {
        status: response.status,
        body: truncateBody(bodyText),
      },
      transport_used: 'opencode-server',
    }
  }

  return {
    ok: true,
    transport_used: 'opencode-server',
    session_id: input.delivery.session_id,
  }
}
