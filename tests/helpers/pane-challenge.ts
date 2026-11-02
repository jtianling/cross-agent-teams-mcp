import Database from 'better-sqlite3'
import { mintCodexRecoveryNonce } from '../../src/mcp/codex-recovery-nonce.js'

export function mintPaneChallenge(dbPath: string, paneId: string): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare(`SELECT xats_agent_id, expires_at
      FROM codex_pane_pre_registrations WHERE pane_id=?`).get(paneId) as
      { xats_agent_id: string; expires_at: string } | undefined
    if (!row) throw new Error(`No pre-registration for ${paneId}`)
    return mintCodexRecoveryNonce(paneId, {
      launch_id: row.xats_agent_id, expires_at: row.expires_at,
    })
  } finally { db.close() }
}
