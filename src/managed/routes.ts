import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SessionOriginInfo } from '../daemon/network-origin.js'
import type { ManagedService } from './service.js'
import {
  bindSchema, controlSchema, prepareSchema, statusSchema,
} from './schema.js'
import { describeRedactedError } from '../mcp/log-redact.js'

function responseStatus(result: unknown): number {
  const parsed = z.object({ error: z.string() }).safeParse(result)
  if (!parsed.success) return 200
  if (parsed.data.error === 'not_found') return 404
  if (parsed.data.error === 'runtime_probe_failed') return 502
  return 409
}

export function mountManagedRoutes(
  app: FastifyInstance,
  service: ManagedService,
  log: (line: string) => void,
): void {
  const routes = [
    ['prepare', prepareSchema, (input: unknown) =>
      service.prepare(prepareSchema.parse(input))],
    ['bind', bindSchema, (input: unknown) =>
      service.bind(bindSchema.parse(input))],
    ['status', statusSchema, (input: unknown) =>
      service.status(statusSchema.parse(input))],
    ['release', controlSchema, (input: unknown) =>
      service.release(controlSchema.parse(input))],
  ] as const
  for (const [name, schema, handler] of routes) {
    app.post(`/api/managed/${name}`, {
      errorHandler: async (error, _req, reply) => {
        const code = error.statusCode ?? 500
        log(`managed ${name} request failed: code=${error.code ?? 'unknown'}`)
        await reply.code(code).send({ ok: false,
          error: code < 500 ? 'invalid_request' : 'internal_error',
          detail: code < 500 ? 'Invalid request body or content type'
            : 'Managed request failed; see daemon log' })
      },
    }, async (req, reply) => {
      const origin = (req as typeof req & { xatsPeer?: SessionOriginInfo })
        .xatsPeer
      if (origin?.origin !== 'local') {
        return reply.code(403).send({ ok: false, error: 'local_only',
          detail: 'Managed control requires loopback' })
      }
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: 'invalid_request',
          detail: 'Request does not match managed protocol v1 schema' })
      }
      try {
        const result = await handler(parsed.data)
        return reply.code(responseStatus(result)).send(result)
      } catch (error) {
        log(`managed ${name} failed: `
          + describeRedactedError(error, parsed.data.identity_key))
        return reply.code(500).send({ ok: false, error: 'internal_error',
          detail: 'Managed control failed; see daemon log' })
      }
    })
  }
}
