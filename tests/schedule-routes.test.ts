import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/daemon/server.js'
import { parseScheduleArgs, runScheduleCli } from '../src/schedules/cli.js'

const INPUT = { name: 'hourly', to_team: 'default', to_agent_name: 'steward',
  prompt: '执行记忆中的管家巡检', schedule: { kind: 'interval',
    start_at: '2030-01-01T01:00:00Z', every_seconds: 3600 }, max_runs: null }
const NOW = Date.parse('2030-01-01T00:00:00Z')
const apps: FastifyInstance[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xats-schedule-api-'))
  dirs.push(dir)
  const app = await buildServer({ dbPath: join(dir, 'data.db'),
    token: 'isolated-schedule-token', localDevice: 'local', mcpLog: vi.fn(),
    schedulerDeps: { now: () => NOW },
  })
  apps.push(app)
  const headers = { authorization: 'Bearer isolated-schedule-token' }
  return { app, headers }
}

describe('schedule API and CLI boundary', () => {
  it('manages plans dynamically and keeps ordinary health available', async () => {
    const { app, headers } = await setup()
    expect((await app.inject({ url: '/api/schedules', headers })).json())
      .toEqual({ schedules: [] })
    const added = await app.inject({ method: 'POST', url: '/api/schedules',
      headers, payload: INPUT })
    expect(added.statusCode).toBe(201)
    const { plan } = added.json()
    expect(plan).not.toHaveProperty('device')
    expect((await app.inject({ method: 'POST', url: '/api/schedules',
      headers, payload: INPUT })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/schedules',
      headers, payload: { ...INPUT, prompt: 'Changed' } })).statusCode).toBe(409)
    const path = `/api/schedules/${plan.id}`
    expect((await app.inject({ method: 'POST', url: `${path}/pause`, headers }))
      .json().plan.status).toBe('paused')
    expect((await app.inject({ method: 'PATCH', url: path, headers,
      payload: { prompt: 'Changed', max_runs: 3 } })).json().plan.status)
      .toBe('paused')
    expect((await app.inject({ method: 'POST', url: `${path}/resume`, headers }))
      .json().plan.status).toBe('active')
    expect((await app.inject({ url: `${path}/runs`, headers })).json())
      .toEqual({ runs: [] })
    expect((await app.inject({ url: path, headers })).json().plan.prompt)
      .toBe('Changed')
    expect((await app.inject({ method: 'DELETE', url: path, headers })).json())
      .toEqual({ ok: true })
    expect((await app.inject({ url: path, headers })).statusCode).toBe(404)
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
  })

  it('gates all operations by token and actual loopback, with strict schemas', async () => {
    const { app, headers } = await setup()
    expect((await app.inject({ method: 'POST', url: '/api/schedules',
      payload: INPUT })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/api/schedules',
      headers: { ...headers, 'x-forwarded-for': '127.0.0.1' },
      remoteAddress: '192.0.2.1', payload: INPUT })).statusCode).toBe(403)
    for (const extra of [
      { to_agent_name: 'steward:remote' }, { typo: true }, { prompt: '' },
      { max_runs: 0 }, { max_runs: 1.5 },
      { schedule: { kind: 'once', at: '2020-01-01T00:00:00Z' } },
      { schedule: { kind: 'daily', time: '09:00' } },
      { schedule: { kind: 'monthly', time: '09:00', timezone: 'UTC', day: 32 } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/schedules',
        headers, payload: { ...INPUT, ...extra } })
      expect(response.statusCode).toBe(400)
    }
    expect((await app.inject({ url: '/api/schedules', headers })).json())
      .toEqual({ schedules: [] })
  })

  it('rejects invalid updates, action bodies and invalid or unknown ids', async () => {
    const { app, headers } = await setup()
    const { plan } = (await app.inject({ method: 'POST', url: '/api/schedules',
      headers, payload: INPUT })).json()
    const path = `/api/schedules/${plan.id}`
    for (const payload of [{}, { typo: 1 }, { max_runs: -1 }]) {
      expect((await app.inject({ method: 'PATCH', url: path, headers, payload }))
        .statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'POST', url: `${path}/pause`,
      headers, payload: { typo: true } })).statusCode).toBe(400)
    expect((await app.inject({ url: '/api/schedules/not-a-uuid', headers }))
      .statusCode).toBe(400)
    expect((await app.inject({ url: '/api/schedules/' +
      'ddfd15c5-0484-47cb-ae7d-fda9ef2311fa', headers })).statusCode).toBe(404)
  })

  it('runs the CLI HTTP requests through the actual Fastify body parser', async () => {
    const { app } = await setup()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const result = await app.inject({ method: init.method as 'POST',
        url: new URL(url).pathname, headers: init.headers as Record<string, string>,
        ...(init.body === undefined ? {} : { payload: init.body as string }),
      })
      return new Response(result.body, { status: result.statusCode })
    }))
    const endpoint = { host: '127.0.0.1', port: 12345,
      token: 'isolated-schedule-token' }
    const added = await runScheduleCli(['add', '--name', 'daily', '--team',
      'default', '--agent', 'steward', '--prompt', '巡检', '--kind', 'daily',
      '--time', '09:00', '--timezone', 'Asia/Singapore', '--count', '3'],
    endpoint) as { plan: { id: string } }
    const id = added.plan.id
    for (const command of ['pause', 'resume', 'show', 'runs', 'remove']) {
      await runScheduleCli([command, '--id', id], endpoint)
    }
    expect(await runScheduleCli(['list'], endpoint)).toEqual({ schedules: [] })
    await expect(runScheduleCli(['list'], { ...endpoint, host: '192.0.2.1' }))
      .rejects.toThrow('loopback')
  })

  it('rejects ambiguous CLI flags and parses all calendar modes', () => {
    const base = ['add', '--name', 'test', '--team', 'work', '--agent', 'worker',
      '--prompt', 'check']
    for (const args of [
      ['--kind', 'once', '--at', '2030-01-01T00:00:00Z'],
      ['--kind', 'interval', '--every-seconds', '3600', '--start-at',
        '2030-01-01T00:00:00Z'],
      ['--kind', 'weekly', '--weekday', '1', '--time', '09:00'],
      ['--kind', 'monthly', '--day', '31', '--time', '09:00', '--count', 'forever'],
    ]) expect(parseScheduleArgs([...base, ...args]).method).toBe('POST')
    for (const args of [
      ['--kind', 'once', '--at', '2030-01-01T00:00:00Z', '--day', '1'],
      ['--time', '09:00'], ['--kind', 'daily', '--time', '09:00', '--count', '0'],
      ['--kind', 'daily', '--kind', 'weekly'],
    ]) expect(() => parseScheduleArgs([...base, ...args])).toThrow()
  })
})
