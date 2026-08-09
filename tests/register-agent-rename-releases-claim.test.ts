import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const KIMI_BASE = 'http://127.0.0.1:58627'
const KIMI_SESSION = 'session_aaaaaaaa-1111-4111-8111-111111111111'
const THREAD_ID = 'bbbbbbbb-2222-4222-8222-222222222222'
const WS_URL = 'ws://127.0.0.1:1234'
const UI_PID = 999001

/**
 * A rename inserts a new row for the new (device, team, name) and migrates the
 * identity_key off the old one. The abandoned row must stop claiming the
 * runtime, or every reverse look-up that requires a unique match sees two rows.
 */
describe('rename releases the abandoned row\'s runtime claim', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'atm-rename-claim-')); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { repo: new AgentsRepo(db), svc: new RegisterAgentService(db) }
  }

  function rename(
    svc: RegisterAgentService,
    from: string,
    to: string,
    extra: Record<string, unknown>
  ) {
    for (const [index, name] of [from, to].entries()) {
      const res = svc.register({
        connection_id: `conn-${index}`,
        name,
        team: 't',
        identity_key: 'IK-1',
        ...extra,
      } as Parameters<RegisterAgentService['register']>[0])
      if ('error' in res) throw new Error(JSON.stringify(res))
    }
  }

  it('kimi: only the renamed row still claims the session', () => {
    const { repo, svc } = setup()
    rename(svc, 'k1', 'k2', {
      agent_type: 'kimi-code',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    expect(
      repo.findByKimiSession(KIMI_BASE, KIMI_SESSION, 'local').map(r => r.name)
    ).toEqual(['k2'])
    // The session-id-only lookup backs the handshake rebind when the client
    // omits X-Kimi-Base-Url; it must be unambiguous too.
    expect(
      repo.findKimiBySessionId(KIMI_SESSION, 'local').map(r => r.name)
    ).toEqual(['k2'])
  })

  it('codex: only the renamed row still claims the thread', () => {
    const { repo, svc } = setup()
    rename(svc, 'x1', 'x2', {
      agent_type: 'codex',
      delivery: {
        kind: 'codex-appserver',
        thread_id: THREAD_ID,
        ws_url: WS_URL,
      },
    })
    expect(
      repo.findByCodexThreadId(THREAD_ID, 'local').map(r => r.name)
    ).toEqual(['x2'])
  })

  it('claude-code: only the renamed row still claims the ui pid', () => {
    const { repo, svc } = setup()
    rename(svc, 'y1', 'y2', {
      agent_type: 'claude-code',
      runtime_ui_pid: UI_PID,
    })
    expect(
      repo.findByRuntimeUiPid(UI_PID, 'local').map(r => r.name)
    ).toEqual(['y2'])
  })

  it('the abandoned row survives with its mailbox cursor intact', () => {
    const { repo, svc } = setup()
    const first = svc.register({
      connection_id: 'conn-0',
      agent_type: 'kimi-code',
      name: 'k1',
      team: 't',
      identity_key: 'IK-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    if ('error' in first) throw new Error('unexpected error')
    rename(svc, 'k1', 'k2', {
      agent_type: 'kimi-code',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    const abandoned = repo.findById(first.agent_id)
    expect(abandoned).toBeDefined()
    expect(abandoned!.name).toBe('k1')
    expect(abandoned!.delivery.kind).toBe('none')
    expect(abandoned!.identity_key).toBeNull()
  })

  // A shared engine can hand one pane's XATS_IDENTITY_KEY to every session on
  // it, so a key can arrive from a runtime that never owned it. Losing the key
  // is correct; losing an unrelated live agent's delivery is not.
  it('a key claimed by an unrelated runtime does not strip the holder\'s delivery', () => {
    const { repo, svc } = setup()
    const victim = svc.register({
      connection_id: 'conn-victim',
      agent_type: 'codex',
      name: 'codex-1',
      team: 't',
      identity_key: 'IK-1',
      delivery: {
        kind: 'codex-appserver',
        thread_id: THREAD_ID,
        ws_url: WS_URL,
      },
    })
    if ('error' in victim) throw new Error('unexpected error')

    const stray = svc.register({
      connection_id: 'conn-stray',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      team: 't',
      identity_key: 'IK-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    if ('error' in stray) throw new Error('unexpected error')

    const row = repo.findById(victim.agent_id)!
    expect(row.delivery).toMatchObject({
      kind: 'codex-appserver',
      thread_id: THREAD_ID,
    })
    // The key still moves — only the address survives.
    expect(row.identity_key).toBeNull()
    expect(repo.findByCodexThreadId(THREAD_ID, 'local').map(r => r.name))
      .toEqual(['codex-1'])
  })

  it('a key claimed by an unrelated runtime does not strip the holder\'s ui pid', () => {
    const { repo, svc } = setup()
    const victim = svc.register({
      connection_id: 'conn-victim',
      agent_type: 'claude-code',
      name: 'claude-1',
      team: 't',
      identity_key: 'IK-1',
      runtime_ui_pid: UI_PID,
    })
    if ('error' in victim) throw new Error('unexpected error')

    const stray = svc.register({
      connection_id: 'conn-stray',
      agent_type: 'kimi-code',
      name: 'kimi-1',
      team: 't',
      identity_key: 'IK-1',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    if ('error' in stray) throw new Error('unexpected error')

    expect(repo.findByRuntimeUiPid(UI_PID, 'local').map(r => r.name))
      .toEqual(['claude-1'])
  })

  it('re-registering the same name is untouched by the release', () => {
    const { repo, svc } = setup()
    rename(svc, 'k1', 'k1', {
      agent_type: 'kimi-code',
      delivery: {
        kind: 'kimi-server',
        session_id: KIMI_SESSION,
        base_url: KIMI_BASE,
      },
    })
    const rows = repo.findByKimiSession(KIMI_BASE, KIMI_SESSION, 'local')
    expect(rows.map(r => r.name)).toEqual(['k1'])
  })
})
