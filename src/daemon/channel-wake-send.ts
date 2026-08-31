import type { ChannelWakeFanout } from './channel-wake-fanout.js'

const META_KEY_RE = /^[A-Za-z0-9_]+$/

export interface ChannelWakeInput {
  content: string
  meta: Record<string, string>
}

export type SendChannelWakeResult =
  | { ok: true }
  | { ok: false; reason: 'no_subscriber' | 'sink_failed' }

function sanitizeMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (META_KEY_RE.test(k)) out[k] = v
  }
  return out
}

export function sendChannelWake(
  fanout: ChannelWakeFanout,
  channel_session_id: string,
  input: ChannelWakeInput
): SendChannelWakeResult {
  if (!fanout.has(channel_session_id)) return { ok: false, reason: 'no_subscriber' }
  const payload = {
    jsonrpc: '2.0' as const,
    method: 'notifications/channel_wake' as const,
    params: {
      content: input.content,
      meta: sanitizeMeta(input.meta)
    }
  }
  if (!fanout.send(channel_session_id, payload)) return { ok: false, reason: 'sink_failed' }
  return { ok: true }
}
