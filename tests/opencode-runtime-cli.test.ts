import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { safeRuntimeJson } from '../src/cli.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-runtime-cli-'))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
  argv: string[]
}

function cleanEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CROSS_AGENT_TEAMS_MCP_TOKEN
  delete env.CROSS_AGENT_TEAMS_MCP_HOST
  delete env.CROSS_AGENT_TEAMS_MCP_HOME
  delete env.XATS_IDENTITY_KEY
  return { ...env, ...extraEnv }
}

function runCli(
  command: 'reserve-opencode-runtime' | 'commit-opencode-runtime',
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<CliResult> {
  const argv = [
    '--import',
    'tsx',
    'src/cli.ts',
    command,
    ...args,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      env: cleanEnv(extraEnv),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr, argv }))
  })
}

function runMismatchedCli(
  port: number,
  extraEnv: Record<string, string>
): Promise<CliResult> {
  const source = [
    `const cli=await import('./src/cli.ts');`,
    `process.argv=[process.execPath,'src/cli.ts','reserve-opencode-runtime',`,
    `'--runtime-generation','4','--port','${port}'];`,
    `process.exitCode=await cli.runOpencodeRuntimeControl('reserve',999);`,
  ].join('')
  const argv = [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    source,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      env: cleanEnv(extraEnv),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr, argv }))
  })
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen_failed')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('OpenCode runtime CLI', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('redacts special-character keys from structured daemon outcomes', () => {
    const key = 'quote"\\line\n\t\u0000end'
    const encoded = JSON.stringify({ identity_key: key })
    for (const outcome of [
      {
        ok: true,
        state: 'daemon_response',
        detail: {
          [key]: key,
          message: `prefix:${key}:suffix`,
          encoded,
          nested: [key],
        },
      },
      {
        ok: false,
        error: 'daemon_error',
        detail: `failed for ${key}`,
      },
    ]) {
      const serialized = safeRuntimeJson(outcome, key)
      const parsed = JSON.parse(serialized) as Record<string, unknown>
      const roundTrip = JSON.stringify(parsed)
      expect(roundTrip).not.toContain(key)
      expect(roundTrip).not.toContain(JSON.stringify(key).slice(1, -1))
      expect(roundTrip).toContain('[REDACTED]')
    }
  })

  it('returns unknown-key reserve as success with endpoint and no key '
    + 'exposure', async () => {
    const dir = tmp()
    dirs.push(dir)
    const logs: string[] = []
    const daemon = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      localDevice: 'local',
      mcpLog: line => logs.push(line),
    })
    try {
      const key = '1'
      const result = await runCli(
        'reserve-opencode-runtime',
        ['--runtime-generation', '1', '--port', String(daemon.port)],
        { XATS_IDENTITY_KEY: key }
      )
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        need_register: true,
        state: 'unregistered',
        endpoint: `127.0.0.1:${daemon.port}`,
      })
      expect(result.stderr).not.toContain(key)
      expect(JSON.parse(result.stdout)).not.toHaveProperty('identity_key')
      for (let i = 0; i < 20 && !logs.some(
        line => line.startsWith('mcp session closed:')
      ); i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(logs.some(line => line.startsWith('mcp session closed:'))).toBe(true)
      const db = openDb(join(dir, 'data.db'))
      applySchema(db, { localDevice: 'local' })
      const count = db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as {
        n: number
      }
      expect(count.n).toBe(0)
      db.close()
    } finally {
      await daemon.app.close()
    }
  }, 30_000)

  it('reserves and commits through the paired daemon, then rejects stale', async () => {
    const promptBodies: unknown[] = []
    const opencode = createServer((request, response) => {
      const url = request.url ?? ''
      if (request.method === 'GET' && url === '/global/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"healthy":true}')
        return
      }
      if (request.method === 'GET' && url === '/session/ses_ready') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"id":"ses_ready"}')
        return
      }
      if (
        request.method === 'POST'
        && url === '/session/ses_ready/prompt_async'
      ) {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          promptBodies.push(JSON.parse(body))
          response.writeHead(204)
          response.end()
        })
        return
      }
      response.writeHead(404)
      response.end()
    })
    const opencodePort = await listen(opencode)
    const dir = tmp()
    dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const logs: string[] = []
    const daemon = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
      mcpLog: line => logs.push(line),
    })
    const key = 'paired-secret-key'
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    new AgentsRepo(seed).register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      identity_key: key,
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: `http://127.0.0.1:${opencodePort}`,
        session_id: 'ses_old',
        runtime_generation: 2,
      },
    })
    seed.close()
    try {
      const commonEnv = { XATS_IDENTITY_KEY: key }
      const reserved = await runCli(
        'reserve-opencode-runtime',
        ['--runtime-generation', '3', '--port', String(daemon.port)],
        commonEnv
      )
      expect(reserved.code).toBe(0)
      expect(JSON.parse(reserved.stdout)).toMatchObject({
        state: 'reserved',
        endpoint: `127.0.0.1:${daemon.port}`,
      })
      const committed = await runCli(
        'commit-opencode-runtime',
        [
          '--runtime-generation', '3',
          '--base-url', `http://127.0.0.1:${opencodePort}/`,
          '--session-id', 'ses_ready',
          '--port', String(daemon.port),
        ],
        commonEnv
      )
      expect(committed.code).toBe(0)
      expect(JSON.parse(committed.stdout)).toMatchObject({
        delivery_committed: true,
        connection_bound: false,
        endpoint: `127.0.0.1:${daemon.port}`,
      })
      const stale = await runCli(
        'reserve-opencode-runtime',
        ['--runtime-generation', '2', '--port', String(daemon.port)],
        commonEnv
      )
      expect(stale.code).toBe(1)
      expect(JSON.parse(stale.stderr)).toMatchObject({
        error: 'stale_runtime_generation',
        endpoint: `127.0.0.1:${daemon.port}`,
      })
      for (const result of [reserved, committed, stale]) {
        expect(result.argv).not.toContain(key)
        expect(result.stdout).not.toContain(key)
        expect(result.stderr).not.toContain(key)
      }
      expect(logs.join('\n')).not.toContain(key)
      expect(promptBodies).toHaveLength(1)
      expect(JSON.stringify(promptBodies)).not.toContain(key)
    } finally {
      await daemon.app.close()
      await closeServer(opencode)
    }
  }, 30_000)

  it('fails protocol mismatch closed and reports the daemon endpoint', async () => {
    const dir = tmp()
    dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const daemon = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const key = 'mismatch-secret-key'
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    new AgentsRepo(seed).register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      identity_key: key,
      opencode_runtime_generation: 3,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_ready',
        runtime_generation: 3,
      },
    })
    seed.close()
    try {
      const result = await runMismatchedCli(
        daemon.port,
        { XATS_IDENTITY_KEY: key }
      )
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: 'protocol_version_mismatch',
        cli_protocol_version: 999,
        daemon_protocol_version: 1,
        endpoint: `127.0.0.1:${daemon.port}`,
      })
      expect(result.argv).not.toContain(key)
      expect(result.stdout).not.toContain(key)
      expect(result.stderr).not.toContain(key)
      const verify = openDb(dbPath)
      applySchema(verify, { localDevice: 'local' })
      const row = verify.prepare(
        `SELECT opencode_runtime_generation FROM agents
         WHERE identity_key = 'mismatch-secret-key'`
      ).get() as { opencode_runtime_generation: number }
      expect(row.opencode_runtime_generation).toBe(3)
      verify.close()
    } finally {
      await daemon.app.close()
    }
  }, 30_000)

  it('hard-fails unknown flags and invalid generations before remote '
    + 'call', async () => {
    const unknown = await runCli(
      'reserve-opencode-runtime',
      [
        '--runtime-generation', '1',
        '--identity-key', 'not-allowed',
        '--port', '1',
      ],
      { XATS_IDENTITY_KEY: 'safe-key' }
    )
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown flag(s)')
    expect(unknown.stderr).not.toContain('cli_failed')

    const invalid = await runCli(
      'reserve-opencode-runtime',
      ['--runtime-generation', '0', '--port', '1'],
      { XATS_IDENTITY_KEY: 'safe-key' }
    )
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('positive safe integer')
    expect(invalid.stderr).not.toContain('cli_failed')
  }, 30_000)
})
