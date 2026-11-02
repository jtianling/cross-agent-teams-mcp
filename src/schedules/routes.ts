import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WakeScheduler } from './service.js'
import { ScheduleError, patchSchema, planInputSchema } from './schema.js'

const idSchema = z.object({ id: z.string().uuid() }).strict()

export function mountScheduleRoutes(app: FastifyInstance,
  scheduler: WakeScheduler, log: (line: string) => void): void {
  app.register(async scoped => {
    scoped.setErrorHandler<Error & { statusCode?: number }>((error, _req, reply) => {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'invalid_request',
          detail: error.message })
      }
      log(`wake-scheduler API failed: ${error.message}`)
      if (error instanceof ScheduleError) {
        const status = error.code === 'unknown_schedule' ? 404 :
          error.code === 'schedule_exists' ? 409 :
            error.code === 'scheduler_stopped' ? 503 : 400
        return reply.code(status).send({ error: error.code,
          detail: error.message })
      }
      return reply.code(error.statusCode ?? 500).send({
        error: 'schedule_request_failed', detail: error.message,
      })
    })
    scoped.get('/api/schedules', () => ({ schedules: scheduler.list() }))
    scoped.post('/api/schedules', (req, reply) => {
      const result = scheduler.add(planInputSchema.parse(req.body))
      return reply.code(result.created ? 201 : 200).send(result)
    })
    scoped.get('/api/schedules/:id', req => ({
      plan: scheduler.get(idSchema.parse(req.params).id),
    }))
    scoped.get('/api/schedules/:id/runs', req => ({
      runs: scheduler.history(idSchema.parse(req.params).id),
    }))
    scoped.patch('/api/schedules/:id', req => ({
      plan: scheduler.update(idSchema.parse(req.params).id,
        patchSchema.parse(req.body)),
    }))
    for (const action of ['pause', 'resume'] as const) {
      scoped.post(`/api/schedules/:id/${action}`, req => {
        z.object({}).strict().optional().parse(req.body)
        return { plan: scheduler[action](idSchema.parse(req.params).id) }
      })
    }
    scoped.delete('/api/schedules/:id', (req, reply) => {
      const id = idSchema.parse(req.params).id
      return scheduler.remove(id) ? { ok: true } :
        reply.code(404).send({ error: 'unknown_schedule' })
    })
  })
}
