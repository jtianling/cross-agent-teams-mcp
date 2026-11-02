import { describe, expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync,
  existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function publishedPort(child: ChildProcess, pidPath: string,
  output: () => string): Promise<number> {
  let lastError = ''
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output())
    try {
      const value = JSON.parse(readFileSync(pidPath, 'utf8')) as
        { pid: number; port: number }
      if (value.pid === child.pid && value.port > 0) return value.port
    } catch (error) { lastError = String(error) }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Daemon did not publish its port: ${lastError}\n${output()}`)
}

describe('daemon ephemeral port discovery', () => {
  it('publishes the bound port for schedules CLI pid-file discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xats-port-discovery-'))
    const guard = join(dir, 'guard')
    const probeLog = join(dir, 'probe.log')
    mkdirSync(guard)
    for (const name of ['tmux', 'ps']) {
      writeFileSync(join(guard, name), '#!/bin/sh\n' +
        'printf "%s\\n" "$0" >> "$XATS_TEST_PROBE_LOG"\nexit 93\n',
      { mode: 0o755 })
    }
    const pidPath = join(dir, 'daemon.pid')
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts',
      'daemon', '--db', join(dir, 'data.db'), '--pid-file', pidPath,
      '--port', '0', '--host', '127.0.0.1', '--device', 'isolated-port-test',
      '--token', 'isolated-port-test-token'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${guard}:${process.env.PATH}`,
        XATS_TEST_PROBE_LOG: probeLog },
    })
    let output = ''
    child.stdout!.on('data', data => { output += data.toString() })
    child.stderr!.on('data', data => { output += data.toString() })
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve())
      child.once('error', reject)
    })
    try {
      const port = await publishedPort(child, pidPath, () => output)
      expect(port).toBeGreaterThan(0)
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true)
      const result = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'schedules', 'list', '--pid-file', pidPath],
        { timeout: 5000, env: { ...process.env,
          PATH: `${guard}:${process.env.PATH}`, XATS_TEST_PROBE_LOG: probeLog,
          CROSS_AGENT_TEAMS_MCP_HOST: '127.0.0.1',
          CROSS_AGENT_TEAMS_MCP_TOKEN: 'isolated-port-test-token',
        } })
      expect(JSON.parse(result.stdout)).toEqual({ schedules: [] })
      expect(existsSync(probeLog)).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      const force = setTimeout(() => { child.kill('SIGKILL') }, 7000)
      force.unref()
      try {
        await exited
        expect(existsSync(pidPath)).toBe(false)
      }
      finally { clearTimeout(force); rmSync(dir, { recursive: true, force: true }) }
    }
  }, 25_000)
})
