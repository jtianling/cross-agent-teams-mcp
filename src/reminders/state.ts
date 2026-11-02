import { createHash } from 'node:crypto'
import { canonicalTag, type Reminder, type Snapshot,
  type TaskState, type WatchInput } from './schema.js'

export const NEW_TASK_STABLE_MS = 5 * 60 * 1000
export const TAG_STABLE_MS = 30_000

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function fingerprint(item: Reminder): string {
  return createHash('sha256').update(JSON.stringify(canonical(item)))
    .digest('hex')
}

function hasTag(item: Reminder, watch: WatchInput): boolean {
  return watch.event === 'tag' &&
    item.tags?.some(tag => canonicalTag(tag) === watch.tag) === true
}

export function baseline(
  items: Reminder[], now: number, watch: WatchInput
): Snapshot {
  return Object.fromEntries(items.map(item => [item.id, {
    fingerprint: fingerprint(item),
    completed: item.isCompleted,
    announced: true,
    stable_since: now,
    ...(watch.event === 'tag' ? {
      tag_present: hasTag(item, watch),
      tag_notified: hasTag(item, watch),
    } : {}),
  }]))
}

export function advance(
  previous: Snapshot, items: Reminder[], now: number, watch: WatchInput
): { snapshot: Snapshot; notify: boolean } {
  const currentIds = new Set(items.map(item => item.id))
  const retained = Object.entries(previous)
    .filter(([id, state]) =>
      (watch.event !== 'tag' && state.announced) || currentIds.has(id))
  let notify = false
  const updated = items.map(item => {
    const old = Object.hasOwn(previous, item.id) ? previous[item.id] : undefined
    const next = advanceTask(old, item, now, watch)
    notify ||= next.notify
    return [item.id, next.state] as const
  })
  return { snapshot: Object.fromEntries([...retained, ...updated]), notify }
}

function advanceTask(
  old: TaskState | undefined, item: Reminder, now: number, watch: WatchInput
): { state: TaskState; notify: boolean } {
  const hash = fingerprint(item)
  const stableSince = old?.fingerprint === hash ? old.stable_since : now
  const added = watch.event === 'added' && old?.announced !== true &&
    item.title.trim().length > 0 && now - stableSince >= NEW_TASK_STABLE_MS
  const completed = watch.event === 'completed' && old !== undefined &&
    !old.completed && item.isCompleted
  const present = hasTag(item, watch)
  const tagWasNotified = old?.tag_present === true &&
    old.tag_notified === true
  const tagged = watch.event === 'tag' && present && !tagWasNotified &&
    now - stableSince >= TAG_STABLE_MS
  return { notify: added || completed || tagged, state: {
    fingerprint: hash,
    completed: item.isCompleted,
    announced: watch.event !== 'added' || old?.announced === true || added,
    stable_since: stableSince,
    ...(watch.event === 'tag' ? {
      tag_present: present, tag_notified: present && (tagWasNotified || tagged),
    } : {}),
  } }
}
