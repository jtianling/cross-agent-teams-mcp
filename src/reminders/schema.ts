import { z } from 'zod'

const watchFields = {
  list_id: z.string().uuid().transform(id => id.toLowerCase()),
  to_team: z.string().trim().min(1).max(200),
  to_agent_name: z.string().trim().min(1).max(200)
    .refine(name => !name.includes(':'), 'Recipient must be on this device'),
}

export function canonicalTag(value: string): string {
  return value.trim().replace(/^#/, '').normalize('NFC')
    .replace(/[A-Z]/g, letter => letter.toLowerCase())
}

const tagSchema = z.string().trim().max(200).transform(canonicalTag)
  .pipe(z.string().min(1).refine(tag => !/[\s#]/u.test(tag),
    'Tag must be a single native tag name'))

export const watchInputSchema = z.discriminatedUnion('event', [
  z.object({ ...watchFields, event: z.literal('added') }).strict(),
  z.object({ ...watchFields, event: z.literal('completed') }).strict(),
  z.object({ ...watchFields, event: z.literal('tag'), tag: tagSchema }).strict(),
])

export type WatchInput = z.infer<typeof watchInputSchema>

export const reminderSchema = z.object({
  id: z.string().min(1),
  listID: z.string().uuid(),
  title: z.string(),
  isCompleted: z.boolean(),
  tags: z.array(z.string()).optional(),
}).passthrough()

export const reminderListSchema = z.array(reminderSchema)
export type Reminder = z.infer<typeof reminderSchema>
export type WatchEvent = WatchInput['event']

export const taskStateSchema = z.object({
  fingerprint: z.string(),
  completed: z.boolean(),
  announced: z.boolean(),
  stable_since: z.number().finite(),
  tag_present: z.boolean().optional(),
  tag_notified: z.boolean().optional(),
}).strict()

export const snapshotSchema = z.record(taskStateSchema)
export type Snapshot = z.infer<typeof snapshotSchema>

export type TaskState = z.infer<typeof taskStateSchema>

export type Watch = WatchInput & {
  id: string
  created_at: string
  checked_at: string | null
  last_error: string | null
}

export class ReminderError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail)
    this.name = 'ReminderError'
  }
}
