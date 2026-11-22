import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { CodexBindingLookup } from '../../mcp/codex-binding-lookup.js'
import { CodexBindingRepo } from '../../mcp/codex-binding-repo.js'
import { BindingObserver } from './observer.js'

type NativeCarrier = {
  verify(tty: string, pid: number, launch: string): 'ok' | 'stale' | 'ambiguous'
}

export function bindingProbes(db: Database.Database, device: string) {
  if (process.platform !== 'darwin') return
  const binary = fileURLToPath(new URL(`./carrier-${process.arch}.node`, import.meta.url))
  if (!existsSync(binary)) return
  const native: NativeCarrier = createRequire(import.meta.url)(binary)
  const observer = new BindingObserver()
  const lookup = new CodexBindingLookup(new CodexBindingRepo(db), device, {
    listPanes: () => observer.panes(),
    verifyCarrier: (tty, pid, launch) => {
      try { return native.verify(tty, pid, launch) }
      catch (error) {
        console.error('Codex binding process probe failed:', error)
        throw error
      }
    },
  })
  return { lookup, close: () => observer.close() }
}
