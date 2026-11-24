import type { FastifyInstance } from 'fastify'
import { commitHandoffSchema, handoffControlSchema, handoffFailure,
  prepareHandoffSchema } from './schema.js'
import type { RuntimeHandoffService } from './service.js'
import { describeRedactedError } from '../mcp/log-redact.js'

export function mountHandoffRoutes(app: FastifyInstance,
  service: RuntimeHandoffService, log: (message: string) => void,
): void {
  const routes = [
    ['prepare', prepareHandoffSchema, (value: unknown) =>
      service.prepare(prepareHandoffSchema.parse(value))],
    ['commit', commitHandoffSchema, (value: unknown) =>
      service.commit(commitHandoffSchema.parse(value))],
    ['status', handoffControlSchema, (value: unknown) =>
      service.status(handoffControlSchema.parse(value))],
    ['abort', handoffControlSchema, (value: unknown) =>
      service.abort(handoffControlSchema.parse(value))],
  ] as const
  for (const [name, schema, handle] of routes) {
    app.post(`/api/runtime/handoff/${name}`, {
      errorHandler: (error, _request, reply) => {
        log(`runtime handoff ${name} parse failed: ${error.code}`)
        const code = (error.statusCode ?? 500) < 500 ? 400 : 500
        return reply.code(code).send(handoffFailure(
          code === 400 ? 'invalid_request' : 'internal_error',
          code === 400 ? 'Invalid request body' : 'See daemon log'))
      },
    }, async (request, reply) => {
      const parsed = schema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send(handoffFailure('invalid_request',
          'Request does not match runtime handoff v1'))
      }
      try {
        const result = await handle(parsed.data)
        const status = !result.ok ? result.error === 'not_found' ? 404
          : result.error === 'runtime_probe_failed' ? 502 : 409 : 200
        return reply.code(status).send(result)
      } catch (error) {
        log(`runtime handoff ${name} failed: `
          + describeRedactedError(error, parsed.data.identity_key))
        return reply.code(500).send(handoffFailure('internal_error', 'See daemon log'))
      }
    })
  }
}
