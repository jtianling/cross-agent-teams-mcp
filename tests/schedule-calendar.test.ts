import { describe, expect, it } from 'vitest'
import { nextOccurrence } from '../src/schedules/calendar.js'
import { planInputSchema, ruleSchema, type Rule } from '../src/schedules/schema.js'

const next = (rule: unknown, after: string) => {
  const value = nextOccurrence(ruleSchema.parse(rule), Date.parse(after))
  return value === null ? null : new Date(value).toISOString()
}

describe('schedule calendar', () => {
  it('normalizes absolute times and stops one-time alarms', () => {
    const rule = { kind: 'once', at: '2030-01-02T09:00:00+08:00' }
    expect(next(rule, '2030-01-01T00:00:00Z'))
      .toBe('2030-01-02T01:00:00.000Z')
    expect(next(rule, '2030-01-02T01:00:00Z')).toBeNull()
  })

  it('keeps interval phase and skips a large backlog without looping', () => {
    const rule = { kind: 'interval', start_at: '2020-01-01T00:00:00Z',
      every_seconds: 3600 }
    expect(next(rule, '2030-01-02T12:59:59Z'))
      .toBe('2030-01-02T13:00:00.000Z')
    expect(next(rule, '2019-01-01T00:00:00Z'))
      .toBe('2020-01-01T00:00:00.000Z')
  })

  it('uses saved timezone for daily times and ISO Monday/Sunday weekdays', () => {
    expect(next({ kind: 'daily', time: '09:00', timezone: 'Asia/Singapore' },
      '2030-01-01T01:00:00Z')).toBe('2030-01-02T01:00:00.000Z')
    expect(next({ kind: 'weekly', weekday: 1, time: '09:00', timezone: 'UTC' },
      '2026-10-30T12:00:00Z')).toBe('2026-11-02T09:00:00.000Z')
    expect(next({ kind: 'weekly', weekday: 7, time: '09:00', timezone: 'UTC' },
      '2026-10-30T12:00:00Z')).toBe('2026-11-01T09:00:00.000Z')
  })

  it('skips months without the requested day and handles leap years', () => {
    const rule = { kind: 'monthly', day: 31, time: '09:00', timezone: 'UTC' }
    expect(next(rule, '2026-01-31T09:00:00Z'))
      .toBe('2026-03-31T09:00:00.000Z')
    expect(next({ ...rule, day: 29 }, '2028-02-01T00:00:00Z'))
      .toBe('2028-02-29T09:00:00.000Z')
    expect(next({ ...rule, day: 29 }, '2027-02-01T00:00:00Z'))
      .toBe('2027-03-29T09:00:00.000Z')
  })

  it('skips DST gaps and emits only the earlier occurrence in an overlap', () => {
    const rule = { kind: 'daily', time: '02:30', timezone: 'America/New_York' }
    expect(next(rule, '2026-03-08T05:00:00Z'))
      .toBe('2026-03-09T06:30:00.000Z')
    const overlap = { ...rule, time: '01:30' }
    expect(next(overlap, '2026-11-01T04:00:00Z'))
      .toBe('2026-11-01T05:30:00.000Z')
    expect(next(overlap, '2026-11-01T05:30:00Z'))
      .toBe('2026-11-02T06:30:00.000Z')
    expect(next(overlap, '2026-11-01T06:00:00Z'))
      .toBe('2026-11-02T06:30:00.000Z')
  })

  it('handles a half-hour DST shift without assuming one-hour offsets', () => {
    expect(next({ kind: 'daily', time: '02:15', timezone: 'Australia/Lord_Howe' },
      '2026-10-03T15:00:00Z')).toBe('2026-10-04T15:15:00.000Z')
  })

  it.each([
    { kind: 'daily', time: '25:00', timezone: 'UTC' },
    { kind: 'daily', time: '09:00', timezone: 'Unknown/Timezone' },
    { kind: 'weekly', time: '09:00', timezone: 'UTC', weekday: 0 },
    { kind: 'monthly', time: '09:00', timezone: 'UTC', day: 32 },
    { kind: 'interval', start_at: '2030-01-01T00:00:00Z', every_seconds: 0 },
    { kind: 'once', at: '2030-01-01T12:00:00' },
    { kind: 'once', at: '2030-01-01T12:00:00Z', typo: true },
  ])('rejects invalid schedule %#', input => {
    expect(ruleSchema.safeParse(input).success).toBe(false)
  })

  it('validates counts, local targets, unknown fields and once count', () => {
    const input = { name: 'alarm', to_team: 'work', to_agent_name: 'worker',
      prompt: 'Check progress', schedule: { kind: 'once',
        at: '2030-01-01T12:00:00Z' } as Rule }
    expect(planInputSchema.parse(input).max_runs).toBe(1)
    for (const extra of [{ max_runs: 0 }, { max_runs: 2 },
      { to_agent_name: 'worker:remote' }, { typo: true }]) {
      expect(planInputSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    }
  })
})
