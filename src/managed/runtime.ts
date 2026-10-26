import { JsonRpcSocketClient, defaultWebSocketFactory, safeClose }
  from '../mcp/codex-appserver-rpc.js'
import { RegisterOpencodeSelfService } from '../mcp/register-opencode-self.js'
import { RegisterAgentService } from '../mcp/register-agent.js'
import { validateKimiSession } from '../mcp/reconnect.js'
import { isAlive } from '../daemon/pid.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import type Database from 'better-sqlite3'
import type { ManagedRuntime } from './schema.js'
import { failure, type ManagedFailure } from './claims.js'
import { z } from 'zod'

async function verifyCodex(
  runtime: Extract<ManagedRuntime, { agent_type: 'codex' }>,
): Promise<ManagedFailure | undefined> {
  const ws = defaultWebSocketFactory({ url: runtime.ws_url })
  try {
    const client = new JsonRpcSocketClient(ws)
    await client.waitForOpen()
    const init = await client.request('initialize', {
      clientInfo: { name: 'xats-managed', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    })
    if (init.error) return failure('runtime_probe_failed', JSON.stringify(init.error))
    client.notify('initialized')
    const result = await client.request('thread/read', {
      threadId: runtime.thread_id, includeTurns: false,
    })
    if (result.error) {
      return failure('runtime_probe_failed', JSON.stringify(result.error))
    }
    const parsed = z.object({ thread: z.object({ id: z.string() }) })
      .safeParse(result.result)
    if (!parsed.success || parsed.data.thread.id !== runtime.thread_id) {
      return failure('runtime_probe_failed', 'Thread response did not match ID')
    }
    return undefined
  } finally {
    safeClose(ws)
  }
}

export async function verifyManagedRuntime(
  runtime: ManagedRuntime,
  db: Database.Database,
  device: string,
  channels: ChannelWakeFanout,
): Promise<ManagedFailure | undefined> {
  if (runtime.agent_type === 'codex') return verifyCodex(runtime)
  if (runtime.agent_type === 'claude-code') {
    const proxy = db.prepare(
      `SELECT agent_id FROM agents WHERE device = ?
       AND role = '__channel_proxy__' AND claude_ui_pid = ?
       AND delivery_kind = 'claude-channel'
       AND json_extract(delivery_payload, '$.channel_session_id') = ?`
    ).get(device, runtime.ui_pid, runtime.channel_session_id) as {
      agent_id: string
    } | undefined
    if (!proxy || !isAlive(runtime.ui_pid)
      || channels.owner(runtime.channel_session_id) !== proxy.agent_id) {
      return failure('runtime_probe_failed', 'No matching live channel proxy')
    }
    return undefined
  }
  const result = runtime.agent_type === 'kimi-code'
    ? await validateKimiSession(runtime)
    : await new RegisterOpencodeSelfService(new RegisterAgentService(db))
      .validateExactSession(runtime.base_url, runtime.session_id)
  if ('error' in result) {
    return failure('runtime_probe_failed', JSON.stringify(result))
  }
  return undefined
}
