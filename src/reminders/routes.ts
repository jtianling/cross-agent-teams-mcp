import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ReminderMonitor } from './monitor.js'
import { ReminderError, watchInputSchema } from './schema.js'

export function mountReminderRoutes(
  app: FastifyInstance, monitor: ReminderMonitor,
  log: (line: string) => void
): void {
  app.get('/api/reminder-watches', async () => ({ watches: monitor.list() }))
  app.post('/api/reminder-watches', async (req, reply) => {
    const input = watchInputSchema.safeParse(req.body)
    if (!input.success) {
      return reply.code(400).send({
        error: 'invalid_request', detail: input.error.message,
      })
    }
    try {
      return reply.code(201).send({ watch: await monitor.add(input.data) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log(`reminder-monitor add failed: ${detail}`)
      const duplicate = error !== null && typeof error === 'object' &&
        'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      const code = error instanceof ReminderError ? error.code :
        duplicate ? 'watch_exists' : 'watch_add_failed'
      return reply.code(duplicate ? 409 : 503).send({ error: code, detail })
    }
  })
  app.delete('/api/reminder-watches/:id', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params)
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    return monitor.remove(params.data.id)
      ? { ok: true }
      : reply.code(404).send({ error: 'unknown_watch' })
  })
}
