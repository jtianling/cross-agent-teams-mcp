import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-cli-'))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env, ...extraEnv }
    delete env.CROSS_AGENT_TEAMS_MCP_TOKEN
    delete env.CROSS_AGENT_TEAMS_MCP_HOST
    delete env.CROSS_AGENT_TEAMS_MCP_HOME
    delete env.XATS_IDENTITY_KEY
    for (const [k, v] of Object.entries(extraEnv)) env[k] = v
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'pre-register-codex-pane', ...args],
      { cwd: process.cwd(), env }
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    proc.once('error', rejectPromise)
    proc.once('exit', code => { resolvePromise({ code, stdout, stderr }) })
  })
}

describe('pre-register-codex-pane CLI --identity-key-env', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('the flag with an unset default variable fails fast without calling the daemon', async () => {
    // --port 1 is unreachable: contacting the daemon would yield cli_failed
    // (exit 1); the local fail-fast path must exit 2 before any connection.
    const result = await runCli([
      '--pane', '%10',
      '--agent-id', 'U1',
      '--identity-key-env',
      '--port', '1',
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid_arguments')
    expect(result.stderr).toContain('identity_key')
    expect(result.stderr).toContain('XATS_IDENTITY_KEY')
    expect(result.stderr).not.toContain('cli_failed')
  }, 30000)

  it('a whitespace-only env value fails fast without calling the daemon', async () => {
    const result = await runCli(
      ['--pane', '%10', '--agent-id', 'U1', '--identity-key-env', '--port', '1'],
      { XATS_IDENTITY_KEY: '   ' }
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('invalid_arguments')
    expect(result.stderr).not.toContain('cli_failed')
  }, 30000)

  it('reads the key from XATS_IDENTITY_KEY and stores it, without argv exposure', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })
    try {
      const result = await runCli(
        ['--pane', '%1972', '--agent-id', 'U1', '--identity-key-env', '--port', String(port)],
        { XATS_IDENTITY_KEY: 'K1' }
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true })

      const db = openDb(dbPath)
      applySchema(db)
      const row = db.prepare(
        `SELECT xats_agent_id, identity_key FROM codex_pane_pre_registrations
         WHERE pane_id = '%1972'`
      ).get() as { xats_agent_id: string; identity_key: string | null }
      expect(row).toEqual({ xats_agent_id: 'U1', identity_key: 'K1' })
      db.close()
    } finally {
      await app.close()
    }
  }, 30000)

  it('honors a custom variable name after the flag', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })
    try {
      const result = await runCli(
        [
          '--pane', '%1972',
          '--agent-id', 'U1',
          '--identity-key-env', 'MY_XATS_KEY',
          '--port', String(port),
        ],
        { MY_XATS_KEY: 'K7' }
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)

      const db = openDb(dbPath)
      applySchema(db)
      const row = db.prepare(
        `SELECT identity_key FROM codex_pane_pre_registrations
         WHERE pane_id = '%1972'`
      ).get() as { identity_key: string | null }
      expect(row.identity_key).toBe('K7')
      db.close()
    } finally {
      await app.close()
    }
  }, 30000)

  it('a following flag is not consumed as the variable name', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })
    try {
      const result = await runCli(
        [
          '--pane', '%1972',
          '--agent-id', 'U1',
          '--identity-key-env', '--ttl', '300',
          '--port', String(port),
        ],
        { XATS_IDENTITY_KEY: 'K1' }
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)

      const db = openDb(dbPath)
      applySchema(db)
      const row = db.prepare(
        `SELECT identity_key FROM codex_pane_pre_registrations
         WHERE pane_id = '%1972'`
      ).get() as { identity_key: string | null }
      expect(row.identity_key).toBe('K1')
      db.close()
    } finally {
      await app.close()
    }
  }, 30000)

  it('without the flag the tool call carries no identity_key and output is unchanged', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })
    try {
      const result = await runCli(
        ['--pane', '%1972', '--agent-id', 'U1', '--port', String(port)],
        // An exported key without the flag must change nothing.
        { XATS_IDENTITY_KEY: 'K1' }
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      expect(parsed.ok).toBe(true)
      expect(typeof parsed.expires_at).toBe('string')

      const db = openDb(dbPath)
      applySchema(db)
      const row = db.prepare(
        `SELECT identity_key FROM codex_pane_pre_registrations
         WHERE pane_id = '%1972'`
      ).get() as { identity_key: string | null }
      expect(row.identity_key).toBeNull()
      db.close()
    } finally {
      await app.close()
    }
  }, 30000)

  it('an unknown flag fails the call instead of being silently ignored', async () => {
    // Measured in production: a launcher passed --identity-key-env to a build
    // that predated the flag, got {"ok":true}, and its degrade-and-retry
    // branch never fired because nothing had failed — the key was simply
    // dropped.  Every flag here is read by name, so silence is the DEFAULT
    // for anything unrecognised; only an explicit rejection makes a caller
    // able to tell "this build cannot do that" from "done".
    // --port 1 is unreachable: reaching the daemon would yield cli_failed.
    const result = await runCli([
      '--pane', '%11',
      '--agent-id', 'U1',
      '--identity-key-of-the-future', 'X',
      '--port', '1',
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unknown flag(s)')
    expect(result.stderr).toContain('--identity-key-of-the-future')
    expect(result.stderr).not.toContain('cli_failed')
  })

  it('the value-less identity-key-env flag before another flag is not read as unknown', async () => {
    // `--identity-key-env` may omit its variable name, so the NEXT token is a
    // flag.  The unknown-flag check must not mistake that neighbour for a
    // stray, or the optional-argument form breaks.
    const result = await runCli([
      '--pane', '%12',
      '--agent-id', 'U1',
      '--identity-key-env',
      '--ttl', '600',
      '--port', '1',
    ], { XATS_IDENTITY_KEY: 'K1' })
    expect(result.stderr).not.toContain('unknown flag(s)')
  })
})
