import { z } from 'zod'
import type { DeliverySpec } from '../lib/delivery-spec.js'
import {
  JsonRpcSocketClient, defaultWebSocketFactory, resolveAuthToken, safeClose,
  type CodexWebSocketFactory, type WebSocketLike,
} from './codex-appserver-rpc.js'

type CodexDelivery = Extract<DeliverySpec, { kind: 'codex-appserver' }>
export type ThreadVerification = { ok: true } | { ok: false; error: string }

const threadSchema = z.object({
  id: z.string().uuid(),
  parentThreadId: z.string().nullable(),
  forkedFromId: z.string().nullable(),
  source: z.unknown(),
})

export async function verifyCodexReconnectThread(
  delivery: CodexDelivery,
  threadId: string,
  deps: { env?: NodeJS.ProcessEnv; webSocketFactory?: CodexWebSocketFactory } = {}
): Promise<ThreadVerification> {
  const token = resolveAuthToken(delivery.auth_token_ref, deps.env ?? process.env)
  if ('error' in token) return { ok: false, error: token.error }
  let ws: WebSocketLike | undefined
  try {
    ws = (deps.webSocketFactory ?? defaultWebSocketFactory)({
      url: delivery.ws_url,
      headers: token.ok ? { Authorization: `Bearer ${token.ok}` } : undefined,
    })
    const client = new JsonRpcSocketClient(ws)
    await client.waitForOpen()
    const init = await client.request('initialize', {
      clientInfo: { name: 'cross-agent-teams-mcp', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    if (init.error) return { ok: false, error: 'codex_initialize_failed' }
    client.notify('initialized')
    return await readPrimaryThread(client, threadId)
  } catch {
    return { ok: false, error: 'codex_thread_read_failed' }
  } finally {
    if (ws) safeClose(ws)
  }
}

async function readPrimaryThread(
  client: JsonRpcSocketClient,
  threadId: string
): Promise<ThreadVerification> {
  const response = await client.request('thread/read', {
    threadId, includeTurns: false,
  })
  const parsed = z.object({ thread: threadSchema }).safeParse(response.result)
  if (response.error || !parsed.success || parsed.data.thread.id !== threadId) {
    return { ok: false, error: 'codex_thread_read_failed' }
  }
  const thread = parsed.data.thread
  if (thread.parentThreadId !== null || thread.forkedFromId !== null
    || !['cli', 'vscode'].includes(String(thread.source))) {
    return { ok: false, error: 'codex_thread_not_primary' }
  }
  return { ok: true }
}
