import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { PaneReleaseService, type PaneReleaseDeps } from './service.js'
import { paneReleaseSchema, releaseFailure } from './schema.js'
import { describeRedactedError } from '../mcp/log-redact.js'

export function mountPaneReleaseRoutes(app: FastifyInstance,
  db: Database.Database, device: string, deps: PaneReleaseDeps,
  channels?: ChannelWakeFanout,
): void {
  const service = new PaneReleaseService(db, device, deps, channels)
  app.post('/api/runtime/panes/release', {
    errorHandler: async (error, _request, reply) => {
      deps.log(`pane release request failed: code=${error.code ?? 'unknown'}`)
      const invalid = (error.statusCode ?? 500) < 500
      await reply.code(invalid ? 400 : 500).send(releaseFailure(
        invalid ? 'invalid_request' : 'internal_error',
        invalid ? 'Invalid request body or content type' : 'See daemon log'))
    },
  }, async (request, reply) => {
    const parsed = paneReleaseSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(releaseFailure('invalid_request',
        'Request does not match pane release protocol v1'))
    }
    try {
      const result = await service.release(parsed.data)
      if (result.ok) return reply.send(result)
      deps.log(`pane release refused: error=${result.error} detail=${result.detail} `
        + `target=${result.target_index ?? '-'}`)
      const code = result.error === 'probe_failed' ? 503
        : result.error === 'internal_error' ? 500 : 409
      return reply.code(code).send(result)
    } catch (error) {
      const keys = parsed.data.targets.flatMap(target =>
        target.identity_key === undefined ? [] : [target.identity_key])
        .sort((a, b) => b.length - a.length)
      const detail = keys.reduce((message, key) => message.replaceAll(key, '[redacted]'),
        describeRedactedError(error))
      deps.log(`pane release failed: ${detail}`)
      return reply.code(500).send(releaseFailure('internal_error', 'See daemon log'))
    }
  })
}
