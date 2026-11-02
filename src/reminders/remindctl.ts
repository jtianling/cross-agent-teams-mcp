import { execFile } from 'node:child_process'
import { z } from 'zod'
import {
  ReminderError, reminderListSchema, reminderSchema, type Reminder,
} from './schema.js'

const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const authorizationSchema = z.object({
  authorized: z.boolean(),
  status: z.string(),
})

export interface ReminderReader {
  read(listId: string, signal: AbortSignal,
    options?: { nativeTags: boolean }): Promise<Reminder[]>
}

const nativeReminderSchema = reminderSchema.extend({ tags: z.array(z.string()) })

async function readNative(
  item: Reminder, signal: AbortSignal
): Promise<Reminder> {
  const parsed = nativeReminderSchema.safeParse(
    await run(['info', item.id, '--native'], signal)
  )
  if (!parsed.success) {
    throw new ReminderError('invalid_remindctl_output',
      'remindctl info --native must return reminder fields and tags: ' +
      parsed.error.issues.map(issue =>
        `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  if (parsed.data.id !== item.id ||
    parsed.data.listID.toLowerCase() !== item.listID.toLowerCase()) {
    throw new ReminderError('invalid_remindctl_output',
      'remindctl info --native returned another reminder or list')
  }
  return parsed.data
}

function run(args: string[], signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    execFile('remindctl', [...args, '--json', '--no-input'], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new ReminderError('remindctl_failed',
          `${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new ReminderError('invalid_remindctl_output',
          'remindctl returned invalid JSON'))
      }
    })
  })
}

export const remindctlReader: ReminderReader = {
  async read(listId, signal, options) {
    const status = authorizationSchema.safeParse(
      await run(['status'], signal)
    )
    if (!status.success) {
      throw new ReminderError('invalid_remindctl_output',
        'remindctl status must include authorized and status')
    }
    if (!status.data.authorized) {
      throw new ReminderError('reminders_not_authorized',
        `Reminders access is ${status.data.status}. ` +
        'Authorize remindctl explicitly before adding a watch.')
    }
    const parsed = reminderListSchema.safeParse(
      await run(['show', 'all', '--list-id', listId], signal)
    )
    if (!parsed.success) {
      throw new ReminderError('invalid_remindctl_output',
        parsed.error.issues.map(issue =>
          `${issue.path.join('.')}: ${issue.message}`).join('; '))
    }
    if (parsed.data.some(item => item.listID.toLowerCase() !==
      listId.toLowerCase())) {
      throw new ReminderError('invalid_remindctl_output',
        'remindctl returned a reminder from another list')
    }
    if (new Set(parsed.data.map(item => item.id)).size !== parsed.data.length) {
      throw new ReminderError('invalid_remindctl_output',
        'remindctl returned duplicate reminder IDs')
    }
    if (!options?.nativeTags) return parsed.data
    const native: Reminder[] = []
    for (const item of parsed.data) native.push(await readNative(item, signal))
    return native
  },
}
