import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { PaneReleaseService } from '../src/pane-release/service.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function fakeProbeCommands() {
  const directory = await mkdtemp(join(tmpdir(), 'xats-release-scoped-probes-'))
  const socket = join(directory, 'tmux.sock')
  const log = join(directory, 'calls.jsonl')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    await rm(directory, { recursive: true, force: true })
  })
  const started = Date.parse('2026-10-26T00:00:00Z') / 1000
  const inventory = [
    `${socket}|123|${started}|%7|900001|ttys710|0`,
    ...['%28', '%35', '%19', '%2'].map(pane => `${socket}|123|${started}|${pane}|0||1`),
    `${socket}|123|${started}|%88|0|?|1`,
    `${socket}|123|${started}|%89|900002|ttys710|1`,
  ].join(String.fromCharCode(10))
  const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const kind = path.basename(process.argv[1]);
const clean = process.env.TMUX === undefined && process.env.TMUX_PANE === undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind, clean, args: process.argv.slice(2)}) + String.fromCharCode(10));
if (!clean) process.exit(93);
process.stdout.write((kind === 'tmux'
  ? ${JSON.stringify(inventory)}
  : '900001 900001 900001 ttys710 Mon Oct 26 00:00:02 2026 S+ /usr/bin/opencode attach http://127.0.0.1:12121 --session ses_exact') + String.fromCharCode(10));
`
  for (const name of ['tmux', 'ps']) {
    const executable = join(directory, name)
    await writeFile(executable, source)
    await chmod(executable, 0o755)
  }
  vi.stubEnv('PATH', `${directory}:${process.env.PATH}`)
  vi.stubEnv('TMUX', 'wrong-fixture-server')
  vi.stubEnv('TMUX_PANE', '%999')
  return { directory, socket, log, started }
}

describe('release default probe command boundary', () => {
  it('uses only the explicit owned socket and clean child environments', async () => {
    const fixture = await fakeProbeCommands()
    const db = openDb(':memory:')
    applySchema(db)
    cleanups.push(async () => { db.close() })
    const agent = new AgentsRepo(db).register({ name: 'worker', device: 'local',
      agent_type: 'opencode', identity_key: 'fixture-key', delivery: {
        kind: 'opencode-server', base_url: 'http://127.0.0.1:12121',
        session_id: 'ses_exact' } })
    const service = new PaneReleaseService(db, 'local', { log: vi.fn() })
    expect(await service.release({ protocol_version: 1, targets: [{
      identity_key: 'fixture-key', tmux: { socket_path: fixture.socket,
        server_pid: 123, server_started_at: fixture.started, pane_id: '%28' },
    }] })).toMatchObject({ ok: false, error: 'pane_unverifiable', target_index: 0 })
    expect(new AgentsRepo(db).findById(agent.agent_id)).toBeDefined()
    expect(await service.release({ protocol_version: 1, targets: [{
      identity_key: 'unclaimed-dead-key', allow_dead_if_identity_unclaimed: true,
      tmux: { socket_path: fixture.socket, server_pid: 123,
        server_started_at: fixture.started, pane_id: '%88' },
    }] })).toMatchObject({ ok: false, error: 'pane_unverifiable',
      detail: 'dead_pane_evidence_required' })
    expect(await service.release({ protocol_version: 1, targets: [{
      identity_key: 'unclaimed-dead-key', allow_dead_if_identity_unclaimed: true,
      tmux: { socket_path: fixture.socket, server_pid: 123,
        server_started_at: fixture.started, pane_id: '%28' },
    }] })).toMatchObject({ ok: true, results: [{
      state: 'dead_key_unclaimed', agent: null }] })
    expect(new AgentsRepo(db).findById(agent.agent_id)).toBeDefined()
    expect(await service.release({ protocol_version: 1, targets: [{
      identity_key: 'fixture-key', opencode_session_id: 'ses_exact', tmux: {
        socket_path: fixture.socket, server_pid: 123,
        server_started_at: fixture.started, pane_id: '%7' },
    }] })).toMatchObject({ ok: true, results: [{
      state: 'released', agent: { agent_id: agent.agent_id } }] })
    const calls = (await readFile(fixture.log, 'utf8')).trim().split(String.fromCharCode(10))
      .map(line => JSON.parse(line) as { kind: string; clean: boolean; args: string[] })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call.clean)).toBe(true)
    expect(calls.filter(call => call.kind === 'tmux')
      .every(call => call.args[0] === '-S' && call.args[1].endsWith('/tmux.sock')))
      .toBe(true)
    expect(calls.filter(call => call.kind === 'tmux')
      .every(call => call.args.at(-1)?.endsWith('|#{pane_dead}'))).toBe(true)
    expect(calls.some(call => call.kind === 'ps' && call.args[0] === '-t'))
      .toBe(true)
    expect(calls.some(call => call.kind === 'ps'
      && call.args[0] === '-p' && call.args[1] === '0')).toBe(false)
  })
})
