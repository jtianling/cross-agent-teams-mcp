import type Database from 'better-sqlite3'

const DDL = [
  `CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_agent_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_from_team_eventid ON events(from_team, event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_to_team_eventid ON events(to_team, event_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    agent_type TEXT,
    agent_type_name TEXT,
    device TEXT NOT NULL,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    claude_ui_pid INTEGER,
    runtime_ui_pid INTEGER,
    runtime_tty TEXT,
    runtime_verification_mode TEXT,
    runtime_bound_at TEXT,
    channel_session_id TEXT,
    delivery_kind TEXT NOT NULL DEFAULT 'none',
    delivery_payload TEXT,
    remote_addr TEXT,
    identity_key TEXT,
    register_generation INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(device, team, name)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(event_id),
    from_team TEXT NOT NULL,
    to_team TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT,
    to_role TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    need_reply INTEGER NOT NULL DEFAULT 1,
    sent_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_delivery_status (
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    wake_status TEXT NOT NULL CHECK(wake_status IN ('delivered','retrying','skipped','failed')),
    skip_reason TEXT,
    retry_attempts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    PRIMARY KEY (message_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_delivery_status_message ON message_delivery_status(message_id)`,
  `CREATE TABLE IF NOT EXISTS codex_pane_pre_registrations (
    pane_id TEXT PRIMARY KEY,
    xats_agent_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    identity_key TEXT
  )`
]

function migrateAgentsDeliveryColumns(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))
  // Column-rename migration: legacy schemas have `client`/`client_name`; rename
  // them in place to `agent_type`/`agent_type_name`. Idempotent: skip if the new
  // names already exist.
  const renameClient = existing.has('client') && !existing.has('agent_type')
  const renameClientName = existing.has('client_name') && !existing.has('agent_type_name')
  if (renameClient || renameClientName) {
    const renameTx = db.transaction(() => {
      if (renameClient) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client TO agent_type`)
      }
      if (renameClientName) {
        db.exec(`ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name`)
      }
    })
    renameTx()
    // Refresh column snapshot after the rename so downstream ADD COLUMN checks
    // use the new column names.
    const colsAfter = db.pragma('table_info(agents)') as Array<{ name: string }>
    existing.clear()
    for (const c of colsAfter) existing.add(c.name)
  }
  const needAgentType = !existing.has('agent_type')
  const needAgentTypeName = !existing.has('agent_type_name')
  const needKind = !existing.has('delivery_kind')
  const needPayload = !existing.has('delivery_payload')
  const needRuntimeUiPid = !existing.has('runtime_ui_pid')
  const needRuntimeTty = !existing.has('runtime_tty')
  const needRuntimeVerificationMode = !existing.has('runtime_verification_mode')
  const needRuntimeBoundAt = !existing.has('runtime_bound_at')
  const needClaudeUiPid = !existing.has('claude_ui_pid')
  if (
    !needAgentType &&
    !needAgentTypeName &&
    !needKind &&
    !needPayload &&
    !needRuntimeUiPid &&
    !needRuntimeTty &&
    !needRuntimeVerificationMode &&
    !needRuntimeBoundAt &&
    !needClaudeUiPid
  ) return
  const tx = db.transaction(() => {
    if (needAgentType) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type TEXT`)
    }
    if (needAgentTypeName) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_type_name TEXT`)
    }
    if (needKind) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'`)
    }
    if (needPayload) {
      db.exec(`ALTER TABLE agents ADD COLUMN delivery_payload TEXT`)
    }
    if (needRuntimeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_ui_pid INTEGER`)
    }
    if (needRuntimeTty) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_tty TEXT`)
    }
    if (needRuntimeVerificationMode) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_verification_mode TEXT`)
    }
    if (needRuntimeBoundAt) {
      db.exec(`ALTER TABLE agents ADD COLUMN runtime_bound_at TEXT`)
    }
    if (needClaudeUiPid) {
      db.exec(`ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER`)
    }
    if (needKind || needPayload) {
      db.exec(`UPDATE agents
        SET delivery_kind = 'claude-channel',
            delivery_payload = json_object('channel_session_id', channel_session_id)
        WHERE channel_session_id IS NOT NULL AND delivery_kind = 'none'`)
    }
  })
  tx()
}

function hasDeviceIdentityIndex(db: Database.Database): boolean {
  const indexes = db.pragma('index_list(agents)') as Array<{ name: string }>
  const found = indexes.find((index) => index.name === 'agents_identity_idx')
  if (!found) return false
  const info = db.pragma('index_info(agents_identity_idx)') as Array<{ seqno: number; name: string }>
  const ordered = info
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name)
  return ordered.length === 3
    && ordered[0] === 'device'
    && ordered[1] === 'team'
    && ordered[2] === 'name'
}

function migrateAgentsDeviceColumns(
  db: Database.Database,
  localDevice: string
): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))
  const needDevice = !existing.has('device')
  const needRemoteAddr = !existing.has('remote_addr')
  const needIdentityIndex = !hasDeviceIdentityIndex(db)
  if (!needDevice && !needRemoteAddr && !needIdentityIndex) return

  const tx = db.transaction(() => {
    if (needDevice) {
      const badRow = db.prepare(
        `SELECT team, name
         FROM agents
         WHERE instr(name, ':') > 0
         ORDER BY rowid ASC
         LIMIT 1`
      ).get() as { team: string; name: string } | undefined
      if (badRow) {
        throw new Error(
          `device migration blocked: offending row (${badRow.team}, ${badRow.name}) contains ':'`
        )
      }
      db.exec(`ALTER TABLE agents ADD COLUMN device TEXT`)
    }
    if (needRemoteAddr) {
      db.exec(`ALTER TABLE agents ADD COLUMN remote_addr TEXT`)
    }
    if (needDevice) {
      db.prepare(`UPDATE agents SET device = ? WHERE device IS NULL`).run(localDevice)
    }
    if (needIdentityIndex) {
      db.exec(`DROP INDEX IF EXISTS agents_identity_idx`)
      db.exec(`CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)`)
    }
  })
  tx()
}

// Runs after migrateAgentsDeviceColumns because the unique index spans
// `device`, which a legacy database only gains in that migration.
function migrateAgentsIdentityKeyColumn(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
  const needColumn = !cols.some(c => c.name === 'identity_key')
  const indexes = db.pragma('index_list(agents)') as Array<{ name: string }>
  const needIndex = !indexes.some(i => i.name === 'agents_identity_key_idx')
  if (!needColumn && !needIndex) return
  const tx = db.transaction(() => {
    if (needColumn) {
      db.exec(`ALTER TABLE agents ADD COLUMN identity_key TEXT`)
    }
    if (needIndex) {
      db.exec(
        `CREATE UNIQUE INDEX agents_identity_key_idx ON agents(device, identity_key)`
      )
    }
  })
  tx()
}

// Registration-generation column: every register upsert increments it inside
// the upsert transaction, and register-time runtime binds persist only when
// the row still carries the generation their own registration minted.
function migrateAgentsRegisterGenerationColumn(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
  if (cols.some(c => c.name === 'register_generation')) return
  db.exec(
    `ALTER TABLE agents ADD COLUMN register_generation INTEGER NOT NULL DEFAULT 0`
  )
}

function migrateCodexPreRegIdentityKeyColumn(db: Database.Database): void {
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='codex_pane_pre_registrations'`
    )
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma(
    'table_info(codex_pane_pre_registrations)'
  ) as Array<{ name: string }>
  if (cols.some(c => c.name === 'identity_key')) return
  db.exec(`ALTER TABLE codex_pane_pre_registrations ADD COLUMN identity_key TEXT`)
}

function migrateMessagesNeedReplyColumn(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`)
    .get() as { name: string } | undefined
  if (!tableExists) return
  const cols = db.pragma('table_info(messages)') as Array<{ name: string }>
  const existing = new Set(cols.map(c => c.name))
  if (existing.has('need_reply')) return
  db.exec(`ALTER TABLE messages ADD COLUMN need_reply INTEGER NOT NULL DEFAULT 1`)
}

// Sentinel one-shot migration: agents whose cursor is still at the schema
// default of 0 are advanced to current MAX(event_id), so post-deploy boots
// stop replaying the entire historical mailbox. The `last_processed_event_id = 0`
// predicate is itself the sentinel — once register_agent (D4) initialises new
// rows above 0 and get_inbox auto-advance pushes live agents forward, this
// UPDATE matches no rows on subsequent boots.
function migrateAgentsCursorWatermark(db: Database.Database): void {
  db.exec(
    `UPDATE agents
        SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)
      WHERE last_processed_event_id = 0`
  )
}

function dropLegacyTaskContractTables(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS tasks`)
  db.exec(`DROP TABLE IF EXISTS contracts`)
  db.exec(`DROP TABLE IF EXISTS contract_subscriptions`)
}

export function applySchema(
  db: Database.Database,
  opts: { localDevice?: string } = {}
): void {
  for (const sql of DDL) db.exec(sql)
  dropLegacyTaskContractTables(db)
  migrateAgentsDeliveryColumns(db)
  migrateAgentsDeviceColumns(db, opts.localDevice ?? 'local')
  migrateAgentsIdentityKeyColumn(db)
  migrateAgentsRegisterGenerationColumn(db)
  migrateCodexPreRegIdentityKeyColumn(db)
  migrateMessagesNeedReplyColumn(db)
  migrateAgentsCursorWatermark(db)
}
