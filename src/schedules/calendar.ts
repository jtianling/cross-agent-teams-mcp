import type { Rule } from './schema.js'

type LocalDate = { year: number; month: number; day: number }
type LocalTime = LocalDate & { hour: number; minute: number; second: number }
const DAY_MS = 86_400_000

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
}

function localParts(format: Intl.DateTimeFormat, instant: number): LocalTime {
  const entries = format.formatToParts(instant)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)])
  return Object.fromEntries(entries) as LocalTime
}

function utc(parts: LocalTime): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second)
}

function localInstant(format: Intl.DateTimeFormat, parts: LocalTime) {
  const wall = utc(parts)
  const samples = Array.from({ length: 13 }, (_, i) => wall + (i - 6) * DAY_MS / 4)
  const offsets = new Set(samples.map(time => utc(localParts(format, time)) - time))
  const hits = [...offsets].map(offset => wall - offset)
    .filter(time => utc(localParts(format, time)) === wall)
  return hits.length ? Math.min(...hits) : undefined
}

function dateAt(day: number): LocalDate {
  const value = new Date(day)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1,
    day: value.getUTCDate() }
}

function calendarNext(
  rule: Exclude<Rule, { kind: 'once' | 'interval' }>, after: number
): number {
  const format = formatter(rule.timezone)
  const today = localParts(format, after)
  const midnight = Date.UTC(today.year, today.month - 1, today.day)
  const [hour, minute, second] = rule.time.split(':').map(Number)
  for (let i = 0; i < 370; i++) {
    const day = midnight + i * DAY_MS
    const date = dateAt(day)
    if (rule.kind === 'monthly' && date.day !== rule.day) continue
    if (rule.kind === 'weekly' &&
      (new Date(day).getUTCDay() || 7) !== rule.weekday) continue
    const time = localInstant(format, { ...date, hour, minute, second })
    if (time !== undefined && time > after) return time
  }
  throw new Error('No calendar occurrence found within 370 days')
}

export function nextOccurrence(rule: Rule, after: number): number | null {
  if (rule.kind === 'once') {
    const time = Date.parse(rule.at)
    return time > after ? time : null
  }
  if (rule.kind !== 'interval') return calendarNext(rule, after)
  const start = Date.parse(rule.start_at)
  const period = rule.every_seconds * 1000
  return start > after ? start : start + (Math.floor((after - start) / period) + 1)
    * period
}
