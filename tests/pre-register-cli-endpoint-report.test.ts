import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-endpoint-'))

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

// Measured 2026-08-01: an e2e fixture on a private tmux socket pre-registered
// into the PRODUCTION daemon, got {"ok":true}, and nothing in the output named
// the endpoint — so nothing on either side had a signal.
describe('pre-register-codex-pane CLI endpoint report', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('names the endpoint it resolved, with no token material', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const { app, port } = await startServer({
      dbPath: join(dir, 'data.db'), port: 0, token: 'T_SECRET',
    })
    try {
      const result = await runCli(
        ['--pane', '%1972', '--agent-id', 'U1', '--port', String(port)],
        { CROSS_AGENT_TEAMS_MCP_TOKEN: 'T_SECRET' }
      )
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      expect(parsed.ok).toBe(true)
      expect(parsed.endpoint).toBe(`127.0.0.1:${port}`)
      // Host and port only: the token is already readable by anything that can
      // read the app-server environment, and this must not add a second way.
      expect(result.stdout).not.toContain('T_SECRET')
      expect(result.stdout.toLowerCase()).not.toContain('token')

      // The daemon-side reports reach the caller through the same output.
      expect(parsed.received_fields).toEqual(['pane_id', 'xats_agent_id'])
      // An in-process server is given no visibility probe, so it reports
      // unknown and never shells out to the host's tmux.  Only the daemon
      // entry point supplies the real one.
      expect(parsed.pane_visible).toBe('unknown')
    } finally {
      await app.close()
    }
  }, 30000)

  it('names the endpoint the daemon refused from', async () => {
    // A refusal from the wrong daemon is the same diagnosis problem as a
    // success on it, so the destination has to survive this branch too.
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const { app, port } = await startServer({
      dbPath: join(dir, 'data.db'), port: 0,
    })
    try {
      const result = await runCli(
        ['--pane', 'not-a-pane-id', '--agent-id', 'U1', '--port', String(port)]
      )
      expect(result.code).toBe(1)
      const parsed = JSON.parse(result.stderr) as Record<string, unknown>
      expect(parsed.endpoint).toBe(`127.0.0.1:${port}`)
      expect(String(parsed.raw)).toContain('pane_id')
    } finally {
      await app.close()
    }
  }, 30000)

  it('names the endpoint on a locally rejected ttl', async () => {
    // Rejected client-side after the connection is up, so it never reaches the
    // daemon — and it was the one branch that dropped the endpoint while the
    // comment above it claimed every outcome carried one.
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const { app, port } = await startServer({
      dbPath: join(dir, 'data.db'), port: 0,
    })
    try {
      const result = await runCli(
        ['--pane', '%1972', '--agent-id', 'U1', '--port', String(port), '--ttl', '0']
      )
      expect(result.code).toBe(2)
      const parsed = JSON.parse(result.stderr) as Record<string, unknown>
      expect(parsed).toMatchObject({
        ok: false, error: 'invalid_ttl', endpoint: `127.0.0.1:${port}`,
      })
    } finally {
      await app.close()
    }
  }, 30000)

  it('names the endpoint it could not reach', async () => {
    // A connection refused against the wrong endpoint is the same diagnosis
    // problem as a success against the wrong endpoint.  --port 1 is unreachable.
    const result = await runCli(['--pane', '%1972', '--agent-id', 'U1', '--port', '1'])
    expect(result.code).toBe(1)
    const parsed = JSON.parse(result.stderr) as Record<string, unknown>
    expect(parsed).toMatchObject({
      ok: false, error: 'cli_failed', endpoint: '127.0.0.1:1',
    })
  }, 30000)
})
