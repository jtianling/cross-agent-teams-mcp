#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile }
  from 'node:fs/promises'
import { createServer, isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { configuration, inspectDaemon, processInfo, readPid, replacementLaunch }
  from './daemon-only-config.mjs'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const secrets = []
const redact = value => secrets.reduce((text, secret) =>
  text.replaceAll(secret, '[redacted]'), String(value))

async function fingerprints(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const values = await Promise.all(entries.map(async entry => {
    if (!entry.isFile()) throw new Error('Dist must contain only regular build files')
    return [entry.name, createHash('sha256')
      .update(await readFile(join(directory, entry.name))).digest('hex')]
  }))
  return Object.fromEntries(values.sort(([a], [b]) => a.localeCompare(b)))
}

async function command(program, args, config, logFile) {
  const fd = openSync(logFile, 'a', 0o600)
  try {
    const child = spawn(program, args, { cwd: config.repo,
      stdio: ['ignore', fd, fd] })
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code))
    })
    if (code !== 0) throw new Error(`Build failed (${code}); see ${logFile}`)
  } finally { closeSync(fd) }
}

async function backupDatabase(path, directory) {
  try { await stat(path) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
  const source = new Database(path, { readonly: true, fileMustExist: true })
  const target = join(directory, 'data.db')
  try { await source.backup(target) } finally { source.close() }
  await chmod(target, 0o600)
  const verified = new Database(target, { readonly: true, fileMustExist: true })
  try {
    if (verified.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite backup integrity check failed')
    }
  } finally { verified.close() }
  return true
}

function stillCurrent(target) {
  const current = processInfo(target.metadata.pid)
  return current && current.started === target.current.started
    && current.command === target.current.command
}

async function stopDaemon(target) {
  if (!stillCurrent(target)) throw new Error('Daemon changed; refusing to signal it')
  console.log(`Stopping xats daemon PID=${target.metadata.pid}`)
  process.kill(target.metadata.pid, 'SIGTERM')
  const deadline = Date.now() + 15000
  while (processInfo(target.metadata.pid)) {
    if (Date.now() >= deadline) throw new Error('Daemon did not exit after SIGTERM')
    await delay(100)
  }
}

async function portFree(host, port) {
  if (port === 0) return
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port, exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => server.close(error =>
    error ? reject(error) : resolve()))
}

function healthHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '[::1]'
  return isIP(host) === 6 ? `[${host}]` : host
}

async function waitHealthy(config, launch, child) {
  const deadline = Date.now() + 15000
  let reason = 'PID file not published'
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`New daemon exited (${child.exitCode ?? child.signalCode}); see ${config.log}`)
    }
    const metadata = readPid(config.pidFile)
    if (metadata?.pid === child.pid && metadata.port > 0) {
      if (launch.port !== 0 && metadata.port !== launch.port) {
        throw new Error('Daemon changed port; refusing a fallback instance')
      }
      try {
        const response = await fetch(`http://${healthHost(launch.host)}:${metadata.port}/health`,
          { headers: { Authorization: `Bearer ${launch.token}` },
            signal: AbortSignal.timeout(1000) })
        if (response.ok && z.object({ ok: z.literal(true) }).safeParse(await response.json()).success) {
          return metadata
        }
        reason = `Health response HTTP ${response.status}`
      } catch (error) { reason = error.name }
    }
    await delay(100)
  }
  throw new Error(`Daemon did not become healthy: ${reason}; see ${config.log}`)
}

async function verifyAuthentication(launch) {
  const url = `http://${healthHost(launch.host)}:${launch.port}/api/agents`
  const denied = await fetch(url, { signal: AbortSignal.timeout(3000) })
  await denied.body?.cancel()
  if (denied.status !== 401) {
    throw new Error('Cannot preserve authentication: existing daemon does not require a token')
  }
  const response = await fetch(url,
    { headers: { Authorization: `Bearer ${launch.token}` },
      signal: AbortSignal.timeout(3000) })
  await response.body?.cancel()
  if (![200, 400].includes(response.status)) {
    throw new Error(`Cannot verify existing daemon authentication: HTTP ${response.status}`)
  }
}

async function startDaemon(config, launch) {
  await portFree(launch.host, launch.port)
  await mkdir(dirname(config.log), { recursive: true })
  const fd = openSync(config.log, 'a', 0o600)
  let child
  try {
    child = spawn(launch.node, [join(config.repo, 'dist/cli.js'), 'daemon',
      '--db', launch.db, '--pid-file', config.pidFile,
      '--host', launch.host, '--port', String(launch.port), '--device', launch.device,
      ...(!launch.companion ? ['--no-loopback-companion'] : [])], {
      cwd: config.repo, detached: true, stdio: ['ignore', fd, fd],
      env: { ...process.env, CROSS_AGENT_TEAMS_MCP_TOKEN: launch.token },
    })
  } finally { closeSync(fd) }
  let spawnError
  child.on('error', error => { spawnError = error })
  try {
    const metadata = await waitHealthy(config, launch, child)
    if (spawnError) throw spawnError
    await mkdir(dirname(config.wrapperPid), { recursive: true })
    const temporary = `${config.wrapperPid}.${randomUUID()}`
    await writeFile(temporary, String(metadata.pid) + '\n', { mode: 0o600 })
    await rename(temporary, config.wrapperPid)
    child.unref()
    return metadata
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 5000
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() >= deadline) {
          child.kill('SIGKILL')
          await new Promise(resolve => child.once('exit', resolve))
          break
        }
        await delay(100)
      }
    }
    throw spawnError ?? error
  }
}

async function apply(config, target, launch, directory, original, wrapper) {
  const dist = join(config.repo, 'dist')
  const currentPid = readPid(config.pidFile)
  if (target && currentPid?.pid !== target.metadata.pid) {
    throw new Error('Daemon PID ownership changed during build')
  }
  if (!target && currentPid && processInfo(currentPid.pid)) {
    throw new Error('Another daemon started during build; refusing to replace dist')
  }
  const currentWrapper = await readFile(config.wrapperPid, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (currentWrapper !== wrapper) throw new Error('Wrapper PID file changed during build')
  if (JSON.stringify(await fingerprints(dist)) !== JSON.stringify(original)) {
    throw new Error('Shared dist changed during build; original service preserved')
  }
  if (target) {
    const listeners = execFileSync('lsof', ['-nP', '-a', '-p', String(target.metadata.pid),
      `-iTCP:${target.launch.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
    if (!listeners.split('\n').includes(String(target.metadata.pid))) {
      throw new Error('PID does not own the expected listener')
    }
    await stopDaemon(target)
  }
  const retired = join(directory, 'retired-dist')
  let replaced = false
  try {
    await portFree(launch.host, launch.port)
    const remaining = readPid(config.pidFile)
    if (target && remaining?.pid === target.metadata.pid) await rm(config.pidFile)
    if (original) await rename(dist, retired)
    replaced = true
    await cp(join(directory, 'candidate-dist'), dist, { recursive: true })
    return await startDaemon(config, launch)
  } catch (error) {
    if (replaced) {
      await rm(dist, { recursive: true, force: true })
      if (original) await rename(retired, dist)
    }
    if (target) {
      let restored
      try {
        restored = await startDaemon(config, target.launch)
      } catch (recovery) {
        throw new Error(`Update failed: ${redact(error.message)}; recovery failed: ${redact(recovery.message)}; backup=${directory}`)
      }
      throw new Error(`Update failed; previous daemon restored PID=${restored.pid}: ${redact(error.message)}`)
    }
    throw error
  }
}

async function main() {
  const config = configuration(process.argv.slice(2), repository)
  if (!config) { console.log('usage: start-only-xats [--repo PATH] [--state-dir PATH]'); return }
  await mkdir(config.state, { recursive: true })
  const lock = join(config.state, 'start-only.lock')
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another start may be active; inspect ${lock}/owner.pid before removing the lock`)
    throw error
  }
  try {
    await writeFile(join(lock, 'owner.pid'), String(process.pid) + '\n', { mode: 0o600 })
    const metadata = readPid(config.pidFile)
    const target = metadata ? inspectDaemon(config, metadata) : null
    const launch = replacementLaunch(config, target)
    secrets.push(launch.token)
    if (target) await verifyAuthentication(target.launch)
    console.log(`xats configuration: db=${launch.db} device=${launch.device}`)
    const wrapper = await readFile(config.wrapperPid, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const wrapperPid = wrapper === null ? null
      : z.coerce.number().int().positive().safeParse(wrapper.trim())
    if (wrapperPid && !wrapperPid.success) throw new Error('Invalid wrapper PID metadata')
    if (wrapperPid && wrapperPid.data !== target?.metadata.pid
      && processInfo(wrapperPid.data)) throw new Error('Wrapper PID belongs to another live process')
    const directory = join(config.state, 'backups', `start-only-${Date.now()}-${randomUUID()}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await stat(directory)).dev !== (await stat(config.repo)).dev) {
      throw new Error('Atomic dist replacement requires backup and repository on the same filesystem')
    }
    const original = await fingerprints(join(config.repo, 'dist'))
    if (target && !original) throw new Error('Running daemon build is missing; service preserved')
    if (original) await cp(join(config.repo, 'dist'), join(directory, 'previous-dist'), { recursive: true })
    console.log(`Building xats daemon; backup=${directory}`)
    await command('pnpm', ['exec', 'tsup', '--out-dir', join(directory, 'candidate-dist')],
      config, join(directory, 'build.log'))
    const candidate = await fingerprints(join(directory, 'candidate-dist'))
    if (!candidate?.['cli.js']) throw new Error('Build did not produce a daemon entry point')
    const backedUp = await backupDatabase(launch.db, directory)
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      previousPid: target?.metadata.pid ?? null, originalDist: original,
      databaseBackupVerified: backedUp, host: launch.host, port: launch.port,
      device: launch.device, db: launch.db, node: launch.node,
    }, null, 2) + '\n', { mode: 0o600 })
    const started = await apply(config, target, launch, directory, original, wrapper)
    console.log(`xats daemon ready: PID=${started.pid} port=${started.port}`)
    console.log(`Log: ${config.log}`)
  } finally { await rm(lock, { recursive: true }) }
}

main().catch(error => {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS')
    ? 'Invalid arguments. Use --help.' : redact(error.cause?.message
      ? `${error.message}: ${error.cause.message}` : error.message))
  process.exitCode = 1
})
