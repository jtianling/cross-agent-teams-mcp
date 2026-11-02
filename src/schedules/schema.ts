import { z } from 'zod'

export const instantSchema = z.string().datetime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)), 'Invalid instant')
  .transform(value => new Date(value).toISOString())

const timezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true }
  catch { return false }
}, 'Unknown timezone')

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  .transform(value => value.length === 5 ? `${value}:00` : value)
const calendarFields = { time: timeSchema, timezone: timezoneSchema }

export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instantSchema }).strict(),
  z.object({ kind: z.literal('interval'), start_at: instantSchema,
    every_seconds: z.number().int().min(1).max(31_536_000) }).strict(),
  z.object({ kind: z.literal('daily'), ...calendarFields }).strict(),
  z.object({ kind: z.literal('weekly'), ...calendarFields,
    weekday: z.number().int().min(1).max(7) }).strict(),
  z.object({ kind: z.literal('monthly'), ...calendarFields,
    day: z.number().int().min(1).max(31) }).strict(),
])
export type Rule = z.infer<typeof ruleSchema>

export const planFields = {
  name: z.string().trim().min(1).max(200),
  to_team: z.string().trim().min(1).max(200),
  to_agent_name: z.string().trim().min(1).max(200)
    .refine(value => !value.includes(':'), 'Recipient must be on this device'),
  prompt: z.string().trim().min(1).max(16_000),
  schedule: ruleSchema,
  max_runs: z.number().int().min(1).max(1_000_000).nullable(),
}
export const planInputSchema = z.object({
  ...planFields, max_runs: planFields.max_runs.default(null),
}).strict().superRefine((value, ctx) => {
  if (value.schedule.kind === 'once' && value.max_runs !== null &&
    value.max_runs !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'A one-time alarm must have max_runs 1 or null' })
  }
}).transform(value => ({ ...value,
  max_runs: value.schedule.kind === 'once' ? 1 : value.max_runs,
}))
export const patchSchema = z.object(planFields).partial().strict()
  .refine(value => Object.keys(value).length > 0, 'Empty update')
export type PlanInput = z.infer<typeof planInputSchema>
export type PlanPatch = z.infer<typeof patchSchema>
export type Plan = PlanInput & {
  id: string
  status: 'active' | 'paused' | 'finished'
  next_run_at: string | null
  run_count: number
  created_at: string
  updated_at: string
  last_run_at: string | null
  last_error: string | null
  last_message_id: string | null
  last_recipient_id: string | null
}

export class ScheduleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}
