import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { PaneProbeError } from './probes.js'
import { PaneLookupService } from './service.js'
import { paneLookupSchema } from './schema.js'

export function mountPaneLookupRoutes(
  app: FastifyInstance, db: Database.Database, device: string,
  channels?: ChannelWakeFanout,
): void {
  const service = new PaneLookupService(db, device, channels)
  app.post('/api/runtime/pane/lookup', {
    errorHandler: async (error, _req, reply) => {
      console.error(`pane lookup request failed: code=${error.code ?? 'unknown'}`)
      const code = error.statusCode ?? 500
      await reply.code(code).send({ ok: false,
        error: code < 500 ? 'invalid_request' : 'internal_error',
        detail: 'Invalid request body or content type' })
    },
  }, async (req, reply) => {
    const parsed = paneLookupSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'invalid_request',
        detail: 'Request does not match pane lookup protocol v1 schema' })
    }
    try {
      return reply.send(await service.lookup(parsed.data))
    } catch (error) {
      const probe = error instanceof PaneProbeError
      const cause = error instanceof Error ? error.cause : undefined
      const detail = cause instanceof Error ? cause.message : String(cause ?? '')
      console.error(`pane lookup failed: ${error instanceof Error
        ? error.message : String(error)} cause=${detail}`)
      return reply.code(probe ? 503 : 500).send({ ok: false,
        error: probe ? 'probe_failed' : 'internal_error',
        detail: probe ? error.reason : 'Lookup failed; see daemon log' })
    }
  })
}
