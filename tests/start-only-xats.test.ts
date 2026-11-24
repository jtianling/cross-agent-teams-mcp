import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, realpath }
  from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'

const script = resolve('start-only-xats')
const directories: string[] = []
const ownedPids = new Set<number>()
const children: ChildProcess[] = []
const token = 'isolated-start-only-token'

const daemon = (version: string) => `
import http from 'node:http';
import fs from 'node:fs';
const flag = (name, fallback) => process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const state = process.env.CROSS_AGENT_TEAMS_MCP_HOME;
const pidFile = flag('--pid-file', state + '/daemon.pid');
const db = flag('--db', state + '/data.db');
if (fs.existsSync(db)) fs.openSync(db, 'r');
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.CROSS_AGENT_TEAMS_MCP_TOKEN) {
    response.writeHead(401).end(); return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ok: true, version: ${JSON.stringify(version)},
    device: flag('--device'), db}));
});
server.listen(Number(flag('--port')), flag('--host'), () => {
  fs.writeFileSync(pidFile, JSON.stringify({pid: process.pid, port: server.address().port}));
});
process.on('SIGTERM', () => server.close(() => {
  const metadata = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  if (metadata.pid === process.pid) fs.rmSync(pidFile);
  process.exit(0);
}));
`

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await delay(50)
  }
  throw new Error('Fixture deadline exceeded')
}

async function metadata(state: string) {
  return until(async () => {
    try {
      const value = JSON.parse(await readFile(join(state, 'daemon.pid'), 'utf8'))
      ownedPids.add(value.pid)
      return value as { pid: number; port: number }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })
}

async function fixture(candidate = daemon('new')) {
  const root = await mkdtemp(join(tmpdir(), 'xats-start-only-'))
  directories.push(root)
  const repo = join(root, 'repo'), state = join(root, 'state'), bin = join(root, 'bin')
  for (const path of [join(repo, 'dist'), state, bin]) await mkdir(path, { recursive: true })
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'cross-agent-teams-mcp', type: 'module',
  }))
  await writeFile(join(repo, 'dist/cli.js'), daemon('old'))
  await writeFile(join(root, 'candidate.js'), candidate)
  await writeFile(join(state, 'token'), token, { mode: 0o600 })
  await writeFile(join(bin, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.XATS_FIXTURE_BUILD_FAIL) process.exit(9);
const args = process.argv.slice(2);
if (args[0] !== 'exec' || args[1] !== 'tsup' || args[2] !== '--out-dir') process.exit(8);
fs.mkdirSync(args[3], {recursive: true});
fs.copyFileSync(${JSON.stringify(join(root, 'candidate.js'))}, path.join(args[3], 'cli.js'));
if (process.env.XATS_FIXTURE_RENAME_FAIL) {
  const retired = path.join(path.dirname(args[3]), 'retired-dist');
  fs.mkdirSync(retired);
  fs.writeFileSync(path.join(retired, 'occupied'), 'fixture');
}
`, { mode: 0o700 })
  await writeFile(join(bin, 'tmux'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  const db = new Database(join(state, 'data.db'))
  db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('preserved')")
  db.close()
  return { root, repo, state, bin }
}

async function run(f: Awaited<ReturnType<typeof fixture>>, fail = false,
  environment: Record<string, string> = {}) {
  const child = spawn(script, ['--repo', f.repo, '--state-dir', f.state], {
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`,
      ...(fail ? { XATS_FIXTURE_BUILD_FAIL: '1' } : {}), ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  expect(output).not.toContain(token)
  return { code, output }
}

async function health(port: number) {
  return (await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json()
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  for (const directory of directories) {
    try {
      const pid = JSON.parse(await readFile(join(directory, 'state/daemon.pid'), 'utf8')).pid
      ownedPids.add(pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const pid of ownedPids) {
    try { process.kill(pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  ownedPids.clear()
  await delay(200)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('start-only-xats isolated lifecycle', () => {
  it('uses the same default database and device as start-local-xats', () => {
    const module = resolve('scripts/daemon-only-config.mjs')
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { configuration, coldLaunch, replacementLaunch } from ${JSON.stringify(module)};
      const config = configuration([], ${JSON.stringify(resolve('.'))});
      const launch = coldLaunch(config, 'fixture-token');
      const replacement = replacementLaunch(config, {launch: {...launch,
        db: '/different/data.db', device: 'different-device', port: 9101}});
      console.log(JSON.stringify({db: launch.db, device: launch.device, state: config.state,
        replacement: {db: replacement.db, device: replacement.device, port: replacement.port}}));
    `], { encoding: 'utf8', env: { ...process.env, XATS_DEVICE: 'different-device' } })
    const launch = JSON.parse(output)
    expect(launch.device).toBe('jt')
    expect(launch.db).toBe(join(launch.state, 'data.db'))
    expect(launch.replacement).toEqual({ db: launch.db, device: 'jt', port: 9100 })
  })

  it('stops a start-local-xats daemon using the implicit database before replacement', async () => {
    const f = await fixture()
    const entry = await realpath(join(f.repo, 'dist/cli.js'))
    const old = spawn(process.execPath, [entry, 'daemon', '--device', 'jt',
      '--host', '127.0.0.1', '--port', '0'], { cwd: f.repo, stdio: 'ignore',
      env: { ...process.env, CROSS_AGENT_TEAMS_MCP_HOME: f.state,
        CROSS_AGENT_TEAMS_MCP_TOKEN: token } })
    children.push(old)
    const first = await metadata(f.state)
    const result = await run(f)
    expect(result.code, result.output).toBe(0)
    const second = await metadata(f.state)
    expect(old.exitCode).toBe(0)
    expect(second.pid).not.toBe(first.pid)
    expect(second.port).toBe(first.port)
    expect(await health(second.port)).toMatchObject({
      device: 'jt', db: join(f.state, 'data.db'), version: 'new',
    })
  }, 30000)

  it('starts and restarts only the daemon, preserving configuration and SQLite', async () => {
    const f = await fixture()
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(sentinel)
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    expect((await run(f)).code).toBe(0)
    const second = await metadata(f.state)
    expect(second.pid).not.toBe(first.pid)
    expect(second.port).toBe(first.port)
    expect((await health(second.port)).version).toBe('new')
    expect(sentinel.exitCode).toBeNull()
    expect(sentinel.signalCode).toBeNull()
    expect(Number(await readFile(join(f.state, 'local-daemon.pid'), 'utf8'))).toBe(second.pid)
    const backups = await readdir(join(f.state, 'backups'))
    expect(backups).toHaveLength(2)
    const backup = new Database(join(f.state, 'backups', backups[0], 'data.db'), { readonly: true })
    expect(backup.prepare('SELECT value FROM fixture').get()).toEqual({ value: 'preserved' })
    backup.close()
  }, 30000)

  it('preserves the running service when the build fails', async () => {
    const f = await fixture()
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    const failed = await run(f, true)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('Build failed (9)')
    expect(await metadata(f.state)).toEqual(first)
    expect((await health(first.port)).ok).toBe(true)
  }, 30000)

  it('restores the previous build and daemon after candidate startup fails', async () => {
    const f = await fixture()
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    await writeFile(join(f.root, 'candidate.js'), 'process.exit(7)')
    const failed = await run(f)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('previous daemon restored')
    const restored = await metadata(f.state)
    expect(restored.pid).not.toBe(first.pid)
    expect(restored.port).toBe(first.port)
    expect((await health(restored.port)).version).toBe('new')
  }, 30000)

  it('refuses a PID file pointing at an unrelated process', async () => {
    const f = await fixture()
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(sentinel)
    ownedPids.add(sentinel.pid!)
    await writeFile(join(f.state, 'daemon.pid'), JSON.stringify({ pid: sentinel.pid, port: 1234 }))
    const failed = await run(f)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('different process')
    expect(sentinel.exitCode).toBeNull()
    expect(await readFile(join(f.repo, 'dist/cli.js'), 'utf8')).toBe(daemon('old'))
  }, 30000)

  it('refuses a changed token before stopping the running daemon', async () => {
    const f = await fixture()
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    await writeFile(join(f.state, 'token'), 'different-isolated-token')
    const failed = await run(f)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('authentication: HTTP 401')
    expect(await metadata(f.state)).toEqual(first)
    expect((await health(first.port)).ok).toBe(true)
  }, 30000)

  it('restarts the original service if retiring the old dist fails', async () => {
    const f = await fixture()
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    const failed = await run(f, false, { XATS_FIXTURE_RENAME_FAIL: '1' })
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('previous daemon restored')
    const restored = await metadata(f.state)
    expect(restored.pid).not.toBe(first.pid)
    expect(restored.port).toBe(first.port)
    expect((await health(restored.port)).version).toBe('new')
  }, 30000)

  it('preserves an existing daemon without authentication instead of enabling a token', async () => {
    const openDaemon = daemon('open').replace(
      'request.headers.authorization !==', 'false && request.headers.authorization !==')
    const f = await fixture(openDaemon)
    expect((await run(f)).code).toBe(0)
    const first = await metadata(f.state)
    const failed = await run(f)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('does not require a token')
    expect(await metadata(f.state)).toEqual(first)
  }, 30000)

  it('refuses an ambiguous relative database path without stopping the daemon', async () => {
    const f = await fixture()
    const entry = await realpath(join(f.repo, 'dist/cli.js'))
    const child = spawn(process.execPath, [entry, 'daemon',
      '--db', 'relative.db', '--pid-file', join(f.state, 'daemon.pid'),
      '--host', '127.0.0.1', '--port', '0', '--device', 'fixture-device'], {
      cwd: f.repo, env: { ...process.env, CROSS_AGENT_TEAMS_MCP_TOKEN: token },
      stdio: 'ignore',
    })
    children.push(child)
    const first = await metadata(f.state)
    const failed = await run(f)
    expect(failed.code).toBe(1)
    expect(failed.output).toContain('explicit absolute --db')
    expect(await metadata(f.state)).toEqual(first)
    expect((await health(first.port)).ok).toBe(true)
  }, 30000)
})
