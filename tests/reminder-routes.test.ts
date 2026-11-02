import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/daemon/server.js'
import { parseReminderArgs, runReminderCli } from '../src/reminders/cli.js'
import { ReminderError } from '../src/reminders/schema.js'

const LIST = 'bfe44969-fcb1-49a2-a9c3-a4c711f83bbd'
const INPUT = {
  list_id: LIST, to_team: 'work', to_agent_name: 'worker', event: 'added',
}
const dirs: string[] = []
const apps: FastifyInstance[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xats-reminder-api-'))
  dirs.push(dir)
  const reader = { read: vi.fn(async () => []) }
  const log = vi.fn()
  const app = await buildServer({
    dbPath: join(dir, 'data.db'), token: 'isolated-test-token',
    reminderMonitorDeps: { reader, log },
    mcpLog: log,
  })
  apps.push(app)
  const headers = { authorization: 'Bearer isolated-test-token' }
  return { app, reader, headers, log }
}

describe('reminder management', () => {
  it('supports independent events and canonical tag identities', async () => {
    const h = await setup()
    for (const extra of [
      { event: 'added' }, { event: 'completed' },
      { event: 'tag', tag: '#REVIEWED' }, { event: 'tag', tag: 'other' },
    ]) {
      expect((await h.app.inject({
        method: 'POST', url: '/api/reminder-watches', headers: h.headers,
        payload: { ...INPUT, ...extra },
      })).statusCode).toBe(201)
    }
    expect((await h.app.inject({
      method: 'POST', url: '/api/reminder-watches', headers: h.headers,
      payload: { ...INPUT, event: 'tag', tag: 'reviewed' },
    })).statusCode).toBe(409)
    const { watches } = (await h.app.inject({
      url: '/api/reminder-watches', headers: h.headers,
    })).json()
    expect(watches).toHaveLength(4)
    expect(watches.find((watch: { tag?: string }) => watch.tag === 'reviewed'))
      .toMatchObject({ event: 'tag', tag: 'reviewed' })
  })

  it('adds, lists and removes dynamically without restarting the daemon', async () => {
    const h = await setup()
    expect(h.reader.read).not.toHaveBeenCalled()
    const added = await h.app.inject({
      method: 'POST', url: '/api/reminder-watches',
      headers: h.headers, payload: INPUT,
    })
    expect(added.statusCode).toBe(201)
    const { watch } = added.json()
    expect(h.reader.read).toHaveBeenCalledTimes(1)
    const listed = await h.app.inject({
      method: 'GET', url: '/api/reminder-watches', headers: h.headers,
    })
    expect(listed.json().watches).toEqual([watch])
    const duplicate = await h.app.inject({
      method: 'POST', url: '/api/reminder-watches',
      headers: h.headers, payload: INPUT,
    })
    expect(duplicate.statusCode).toBe(409)
    const removed = await h.app.inject({
      method: 'DELETE', url: `/api/reminder-watches/${watch.id}`,
      headers: h.headers,
    })
    expect(removed.json()).toEqual({ ok: true })
    expect((await h.app.inject({
      method: 'GET', url: '/api/reminder-watches', headers: h.headers,
    })).json()).toEqual({ watches: [] })
    expect((await h.app.inject({ url: '/health' })).statusCode).toBe(200)
  })

  it('rejects unauthenticated, remote and invalid requests before reading', async () => {
    const h = await setup()
    expect((await h.app.inject({
      method: 'POST', url: '/api/reminder-watches', payload: INPUT,
    })).statusCode).toBe(401)
    expect((await h.app.inject({
      method: 'POST', url: '/api/reminder-watches', headers: h.headers,
      remoteAddress: '192.0.2.1', payload: INPUT,
    })).statusCode).toBe(403)
    for (const payload of [
      { ...INPUT, list_id: 'short-prefix' },
      { ...INPUT, to_agent_name: 'worker:remote' },
      { ...INPUT, typo: true },
      { ...INPUT, event: undefined },
      { ...INPUT, event: 'tag' },
      { ...INPUT, tag: 'unexpected' },
      { ...INPUT, event: 'tag', tag: '#' },
      { ...INPUT, event: 'tag', tag: 'two tags' },
    ]) {
      expect((await h.app.inject({
        method: 'POST', url: '/api/reminder-watches', headers: h.headers,
        payload,
      })).statusCode).toBe(400)
    }
    expect(h.reader.read).not.toHaveBeenCalled()
  })

  it('reports permission failure and keeps ordinary routes available', async () => {
    const h = await setup()
    h.reader.read.mockRejectedValueOnce(new ReminderError(
      'reminders_not_authorized', 'Reminders access is not-determined'
    ))
    const response = await h.app.inject({
      method: 'POST', url: '/api/reminder-watches',
      headers: h.headers, payload: INPUT,
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: 'reminders_not_authorized',
      detail: 'Reminders access is not-determined',
    })
    expect((await h.app.inject({
      url: '/api/reminder-watches', headers: h.headers,
    })).json()).toEqual({ watches: [] })
    expect((await h.app.inject({ url: '/health' })).statusCode).toBe(200)
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('not-determined'))
  })
})

describe('reminder CLI', () => {
  it('runs CLI add/list/remove through the Fastify request parser', async () => {
    const h = await setup()
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const response = await h.app.inject({
        method: init?.method as 'GET' | 'POST' | 'DELETE',
        url: new URL(String(url)).pathname,
        headers: init?.headers as Record<string, string>,
        payload: typeof init?.body === 'string' ? init.body : undefined,
      })
      return new Response(response.body, { status: response.statusCode })
    })
    const endpoint = {
      host: '127.0.0.1', port: 9100, token: 'isolated-test-token',
    }
    const result = await runReminderCli([
      'add', '--list-id', LIST, '--team', 'work', '--agent', 'worker',
      '--event', 'added',
    ], endpoint) as { watch: { id: string } }
    await expect(runReminderCli(['list'], endpoint))
      .resolves.toMatchObject({ watches: [{ id: result.watch.id }] })
    await expect(runReminderCli(['remove', '--id', result.watch.id], endpoint))
      .resolves.toEqual({ ok: true })
    await expect(runReminderCli(['list'], endpoint))
      .resolves.toEqual({ watches: [] })
  })

  it('parses management commands and rejects ignored flags', () => {
    expect(parseReminderArgs(['add', '--list-id', LIST,
      '--team', 'work', '--agent', 'worker', '--event', 'added'])).toEqual({
      method: 'POST', path: '/api/reminder-watches', body: INPUT,
    })
    expect(parseReminderArgs(['list'])).toMatchObject({ method: 'GET' })
    expect(parseReminderArgs(['add', '--list-id', LIST, '--team', 'work',
      '--agent', 'worker', '--event', 'tag', '--tag', '#已审核']))
      .toMatchObject({ body: { event: 'tag', tag: '已审核' } })
    expect(parseReminderArgs(['remove', '--id', LIST]))
      .toMatchObject({ method: 'DELETE', path: `/api/reminder-watches/${LIST}` })
    for (const args of [
      ['list', '--wat', 'x'], ['list', '--agent', 'x'],
      ['list', '--port', '65536'], ['remove', '--id', 'bad'],
      ['list', '--port', '1', '--port', '2'], ['add'],
    ]) expect(() => parseReminderArgs(args)).toThrow()
  })

  it('uses loopback, inherited authorization and propagates HTTP failures', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ watches: [] }))
    )
    await expect(runReminderCli(['list'], {
      host: '127.0.0.1', port: 9100, token: 'isolated-test-token',
    })).resolves.toEqual({ watches: [] })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9100/api/reminder-watches',
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer isolated-test-token',
      }) })
    )
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'watch_exists', detail: 'Already watching',
    }), { status: 409 }))
    await expect(runReminderCli(['list'], { host: '127.0.0.1', port: 9100 }))
      .rejects.toThrow('Already watching')
    await expect(runReminderCli(['list'], { host: 'example.com', port: 9100 }))
      .rejects.toThrow('loopback')
    await expect(runReminderCli(['list'], { host: '127.example.com', port: 9100 }))
      .rejects.toThrow('loopback')
  })
})
