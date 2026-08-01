import Fastify, { type FastifyInstance } from 'fastify'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { openDb } from '../storage/db.js'
import { applySchema } from '../storage/schema.js'
import { makeAuthHook } from './auth.js'
import { mountMcp } from '../mcp/transport.js'
import { mountRestApi } from './rest-api.js'
import { runCleanup } from './cleanup.js'
import { SseFanout } from './sse-fanout.js'
import { ChannelWakeFanout } from './channel-wake-fanout.js'
import { clearAllRetries } from '../mcp/poke-retry.js'
import { clearAllKimiRetries } from '../mcp/kimi-poke-retry.js'
import { clearAllCodexRecoverySchedules } from '../mcp/codex-recovery-poke.js'
import { clearAllCodexSeedingSchedules } from '../mcp/codex-seeding-poke.js'
import { resolveLocalDeviceLabel } from './local-device.js'
import { bindHostCoversIpv4Loopback, classifyPeerAddress, type SessionOriginInfo } from './network-origin.js'

export interface ServerOpts {
  dbPath: string
  token?: string
  localDevice?: string
  cleanupIntervalMs?: number
  orphanGcIntervalMs?: number
  orphanGcIdleMs?: number
  orphanGcMaxAgeMs?: number
  orphanGcMaxSessions?: number
  mcpLog?: (line: string) => void
  fanout?: SseFanout
  channelWakeFanout?: ChannelWakeFanout
}
export interface StartOpts extends ServerOpts {
  port: number
  host?: string
  // When primary host is not loopback-covering, also bind 127.0.0.1 on the
  // same port so same-host clients can connect via loopback and get the
  // 'local' origin classification (which auto-fills the local device label
  // and skips the remote spoofing check). Default true. Set false to opt out.
  loopbackCompanion?: boolean
}

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000
const DEFAULT_ORPHAN_GC_INTERVAL_MS = 60_000
const DEFAULT_ORPHAN_GC_IDLE_MS = 300_000
const DEFAULT_ORPHAN_GC_MAX_AGE_MS = 300_000
const DEFAULT_ORPHAN_GC_MAX_SESSIONS = 500

export interface DaemonContext {
  localDevice: string
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export async function buildServer(opts: ServerOpts): Promise<FastifyInstance> {
  const keepAliveTimeout = parsePositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
  const app = Fastify({ logger: false, keepAliveTimeout })
  app.server.headersTimeout = keepAliveTimeout + 1000
  const db = openDb(opts.dbPath)
  const context: DaemonContext = {
    localDevice: opts.localDevice ?? resolveLocalDeviceLabel(),
  }
  applySchema(db, { localDevice: context.localDevice })
  const startedAt = Date.now()
  const version = '0.1.0'
  const fanout = opts.fanout ?? new SseFanout()
  const channelWakeFanout = opts.channelWakeFanout ?? new ChannelWakeFanout()
  app.addHook('onRequest', makeAuthHook(opts.token))
  app.addHook('onRequest', async (req) => {
    ;(req as typeof req & { xatsPeer?: SessionOriginInfo }).xatsPeer =
      classifyPeerAddress(req.raw.socket.remoteAddress)
  })
  const orphanGcMaxSessions = opts.orphanGcMaxSessions
    ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_SESSIONS, DEFAULT_ORPHAN_GC_MAX_SESSIONS)
  const mcp = mountMcp(app, db, fanout, channelWakeFanout, {
    context,
    log: opts.mcpLog,
    orphanSessionLimit: orphanGcMaxSessions,
  })
  // Loopback-only REST lifeboat. Mounted after the auth + origin-classification
  // onRequest hooks (above) and alongside mountMcp. Receives the same
  // channelWakeFanout used for send fan-out so /api/send pokes identically.
  mountRestApi(app, db, { channelWakeFanout, context })
  app.get('/health', async () => ({
    ok: true,
    version,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    mcp_sessions: mcp.sessionMetrics(),
  }))

  const cleanupIntervalMs = opts.cleanupIntervalMs
    ?? Number(process.env.CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000)
  const interval = setInterval(() => {
    try { runCleanup(db) } catch { /* best-effort */ }
  }, cleanupIntervalMs)
  if (typeof interval.unref === 'function') interval.unref()

  const orphanGcIntervalMs = opts.orphanGcIntervalMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_INTERVAL_MS, DEFAULT_ORPHAN_GC_INTERVAL_MS)
  const orphanGcIdleMs = opts.orphanGcIdleMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_IDLE_MS, DEFAULT_ORPHAN_GC_IDLE_MS)
  const orphanGcMaxAgeMs = opts.orphanGcMaxAgeMs
    ?? parsePositiveInt(process.env.ORPHAN_GC_MAX_AGE_MS, DEFAULT_ORPHAN_GC_MAX_AGE_MS)
  const orphanGcInterval = setInterval(() => {
    try {
      mcp.reapOrphanSessions(Date.now(), {
        idleMs: orphanGcIdleMs,
        maxAgeMs: orphanGcMaxAgeMs,
        maxSessions: orphanGcMaxSessions,
      })
    } catch { /* best-effort */ }
  }, orphanGcIntervalMs)
  if (typeof orphanGcInterval.unref === 'function') orphanGcInterval.unref()

  app.addHook('onClose', async () => {
    clearInterval(interval)
    clearInterval(orphanGcInterval)
    clearAllRetries()
    clearAllKimiRetries()
    // Before db.close(): recovery and seeding probe timers and in-flight sends
    // read the db synchronously; cancelled flags must be visible before it
    // goes away.
    clearAllCodexRecoverySchedules({ reason: 'daemon_shutdown', log: opts.mcpLog })
    clearAllCodexSeedingSchedules({ reason: 'daemon_shutdown', log: opts.mcpLog })
    fanout.stopAll()
    db.close()
  })
  return app
}

export interface StartServerResult {
  app: FastifyInstance
  port: number
  host: string
  loopbackCompanion?: HttpServer
}

export async function startServer(opts: StartOpts): Promise<StartServerResult> {
  // The daemon process entry supplies no mcpLog, so default the sink to the
  // same stream as the startup banner (stdout, which the launchers append to
  // the daemon log file). Leaving it unset silently discards every session
  // created/closed/takeover/reap line the transport already emits. Embedded
  // buildServer callers (library use, unit tests) stay silent by default.
  // Stamped, because these lines are read to reconstruct what happened and
  // when — and correlating them against another system's records is the whole
  // point of reading them.  Only the codex-recovery module stamped its own,
  // so an identity decision could be located no more precisely than "somewhere
  // after the last recovery event", which on 2026-07-31 was not precise enough
  // to answer whether a refusal predated a change in aoe.  Injected sinks
  // (library use, tests) keep receiving the raw line.
  const mcpLog = opts.mcpLog
    ?? ((line: string) => { console.log(`[${new Date().toISOString()}] ${line}`) })
  const app = await buildServer({ ...opts, mcpLog })
  const host = opts.host ?? '127.0.0.1'

  // Hook for the loopback companion's graceful close. Registered BEFORE
  // app.listen (Fastify seals hooks once listening). The ref is filled in
  // after the companion successfully binds; if no companion is created the
  // hook is a no-op.
  const companionRef: { server: HttpServer | undefined } = { server: undefined }
  app.addHook('onClose', async () => {
    const server = companionRef.server
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  await app.listen({ port: opts.port, host })
  const addr = app.server.address()
  const port = addr && typeof addr === 'object' ? addr.port : opts.port

  const companionEnabled = opts.loopbackCompanion !== false
  if (companionEnabled && !bindHostCoversIpv4Loopback(host)) {
    const handler = app.server.listeners('request')[0] as
      | ((req: IncomingMessage, res: ServerResponse) => void)
      | undefined
    if (!handler) {
      await app.close()
      throw new Error('loopback_companion_no_handler: Fastify did not expose a request handler')
    }
    const companion = createHttpServer(handler)
    try {
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error): void => reject(err)
        companion.once('error', onErr)
        companion.listen(port, '127.0.0.1', () => {
          companion.removeListener('error', onErr)
          resolve()
        })
      })
    } catch (err) {
      try { companion.close() } catch { /* best-effort */ }
      await app.close()
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`loopback_companion_bind_failed: ${detail}`)
    }
    companionRef.server = companion
  }

  return { app, port, host, loopbackCompanion: companionRef.server }
}
