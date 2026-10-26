import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { findClaudeUiPid } from './find-claude-pid.js'

export interface RegistrationConfig {
  daemonUrl: string
  token?: string
  managedToken?: string
  device?: string
  channel_session_id: string
  backoffInitialMs?: number
  backoffMaxMs?: number
  backoffScheduleMs?: readonly number[]
  notificationHandler?: (payload: unknown) => void
}

export interface ReconnectingProxyConfig extends RegistrationConfig {
  onSequenceComplete?: (order: string[]) => void
  onDisconnect?: () => void
  healthCheckIntervalMs?: number
}

export interface ReconnectingProxyController {
  stop(): Promise<void>
}

export interface RegistrationSequenceResult {
  order: string[]
  lastSubscribeResult: unknown
  client: Client
  transport: StreamableHTTPClientTransport
  close: () => Promise<void>
}

type ToolResult = Record<string, unknown>

const DEFAULT_BACKOFF_SCHEDULE_MS = [1_000, 10_000, 60_000, 600_000] as const

async function parseToolResult(resp: unknown): Promise<ToolResult> {
  const r = resp as { content?: Array<{ text?: string }> }
  const text = r.content?.[0]?.text
  if (typeof text !== 'string') return {}
  try { return JSON.parse(text) as ToolResult } catch { return {} }
}

function resolveBackoffSchedule(config: ReconnectingProxyConfig): readonly number[] {
  if (config.backoffScheduleMs && config.backoffScheduleMs.length > 0) {
    return config.backoffScheduleMs.map(ms => Math.max(1, ms))
  }
  if (config.backoffInitialMs !== undefined || config.backoffMaxMs !== undefined) {
    const initial = config.backoffInitialMs ?? DEFAULT_BACKOFF_SCHEDULE_MS[0]
    const max = config.backoffMaxMs
      ?? DEFAULT_BACKOFF_SCHEDULE_MS[DEFAULT_BACKOFF_SCHEDULE_MS.length - 1]
    const schedule: number[] = []
    let next = Math.max(1, initial)
    while (schedule.length < DEFAULT_BACKOFF_SCHEDULE_MS.length) {
      schedule.push(Math.min(next, max))
      next *= 2
    }
    return schedule
  }
  return DEFAULT_BACKOFF_SCHEDULE_MS
}

export async function runRegistrationSequence(
  config: RegistrationConfig
): Promise<RegistrationSequenceResult> {
  const order: string[] = []
  const requestInit = { headers: {
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    ...(config.managedToken
      ? { 'X-Xats-Managed-Proxy-Token': config.managedToken } : {}),
  } }
  const transport = new StreamableHTTPClientTransport(new URL(config.daemonUrl), {
    requestInit,
  })
  const client = new Client({ name: 'cross-agent-teams-proxy', version: '0.1.0' })

  if (config.notificationHandler) {
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/channel_wake') {
        config.notificationHandler!(n.params)
      }
    }
  }

  await client.connect(transport)

  try {
    // 1. register_agent as proxy — identity keyed on pid, stable across reconnects
    // so the (device, team, name) ON CONFLICT upsert reuses the same row instead of spamming new rows.
    // Only send `device` when the caller explicitly set one; otherwise let the daemon auto-fill
    // its local label (loopback) or reject (remote, which requires explicit device).
    const registerArgs: Record<string, unknown> = {
      agent_type: 'custom',
      agent_type_name: 'cross-agent-teams-channel',
      model: 'proxy',
      role: '__channel_proxy__',
      name: `channel-proxy-${process.pid}`,
      team: 'default',
      claude_ui_pid: findClaudeUiPid(),
      delivery: {
        kind: 'claude-channel',
        channel_session_id: config.channel_session_id,
      },
    }
    if (config.device !== undefined) {
      registerArgs.device = config.device
    }
    const registerResp = await client.callTool({
      name: 'register_agent',
      arguments: registerArgs,
    })
    order.push('register_agent')
    const regResult = await parseToolResult(registerResp)
    if (!('agent_id' in regResult)) {
      throw new Error(`register_agent failed: ${JSON.stringify(regResult)}`)
    }

    // 2. subscribe_channel_wake — proxy's csid is fresh per startup
    const subResp = await client.callTool({
      name: 'subscribe_channel_wake',
      arguments: { channel_session_id: config.channel_session_id }
    })
    order.push('subscribe_channel_wake')
    const subResult = await parseToolResult(subResp)
    if (!('ok' in subResult) || subResult.ok !== true) {
      throw new Error(`subscribe_channel_wake failed: ${JSON.stringify(subResult)}`)
    }

    return {
      order,
      lastSubscribeResult: subResult,
      client,
      transport,
      close: async () => {
        try { await transport.terminateSession() } catch { /* best-effort */ }
        try { await client.close() } catch { /* best-effort */ }
        try { await transport.close() } catch { /* best-effort */ }
      }
    }
  } catch (err) {
    try { await transport.terminateSession() } catch { /* best-effort */ }
    try { await client.close() } catch { /* best-effort */ }
    try { await transport.close() } catch { /* best-effort */ }
    throw err
  }
}

export interface WaitForDisconnectInput {
  client: Pick<Client, 'callTool'>
  transport: { onclose?: (() => void) | null | undefined }
}

export interface WaitForDisconnectOptions {
  healthCheckIntervalMs?: number
  shouldStop?: () => boolean
}

export async function waitForDisconnect(
  seq: WaitForDisconnectInput,
  opts: WaitForDisconnectOptions = {}
): Promise<void> {
  const interval = opts.healthCheckIntervalMs ?? 30_000
  const shouldStop = opts.shouldStop ?? (() => false)
  let disconnected = false
  let wakeup: (() => void) | null = null
  const closeHandler = (): void => {
    disconnected = true
    wakeup?.()
  }
  const prevOnClose = seq.transport.onclose
  seq.transport.onclose = (): void => { prevOnClose?.(); closeHandler() }
  while (!disconnected && !shouldStop()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wakeup = null; resolve() }, interval)
      wakeup = (): void => { clearTimeout(timer); wakeup = null; resolve() }
    })
    if (disconnected || shouldStop()) break
    try {
      await seq.client.callTool({ name: 'echo', arguments: { msg: 'hb' } })
    } catch {
      disconnected = true
      break
    }
  }
}

export function runReconnectingProxy(config: ReconnectingProxyConfig): ReconnectingProxyController {
  let stopped = false
  let currentSeq: RegistrationSequenceResult | null = null
  const backoffScheduleMs = resolveBackoffSchedule(config)
  let backoffIndex = 0

  async function loop(): Promise<void> {
    while (!stopped) {
      let failed = false
      try {
        const seq = await runRegistrationSequence(config)
        backoffIndex = 0
        currentSeq = seq
        if (config.onSequenceComplete) config.onSequenceComplete([...seq.order])

        await waitForDisconnect(seq, {
          healthCheckIntervalMs: config.healthCheckIntervalMs,
          shouldStop: () => stopped,
        })
        if (config.onDisconnect) config.onDisconnect()
        try { await seq.close() } catch { /* best-effort */ }
        currentSeq = null
      } catch (error) {
        failed = true
        const detail = error instanceof Error ? error.message : String(error)
        const redacted = [config.token, config.managedToken].reduce<string>(
          (text, token) => token ? text.replaceAll(token, '[redacted]') : text,
          detail,
        )
        process.stderr.write(`cross-agent-teams-proxy: ${redacted}\n`)
        // register/subscribe failed — wait and retry.
      }
      if (stopped) break
      const wait = backoffScheduleMs[Math.min(backoffIndex, backoffScheduleMs.length - 1)]
      if (failed) backoffIndex += 1
      await new Promise(r => setTimeout(r, wait))
    }
  }

  void loop()

  return {
    stop: async () => {
      stopped = true
      if (currentSeq) {
        try { await currentSeq.close() } catch { /* best-effort */ }
      }
    }
  }
}
