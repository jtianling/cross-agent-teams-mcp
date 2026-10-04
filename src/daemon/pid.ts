import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'already_running'; pid: number; port: number }

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) {
    const err = e as NodeJS.ErrnoException
    // EPERM means the process exists but we lack permission to signal it; still alive.
    if (err.code === 'EPERM') return true
    return false
  }
}

export function acquirePidFile(path: string, port: number): AcquireResult {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; port: number }
      if (isAlive(prev.pid) && prev.pid !== process.pid) {
        return { ok: false, reason: 'already_running', pid: prev.pid, port: prev.port }
      }
    } catch { /* corrupt file, overwrite */ }
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, port }))
  return { ok: true }
}

export function releasePidFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true })
}
