import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-find-by-codex-thread-'))

function freshRepo() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  return { dir, db, repo: new AgentsRepo(db) }
}

function registerCodex(
  repo: AgentsRepo,
  args: { name: string; thread_id: string; device?: string }
): string {
  return repo.register({
    agent_type: 'codex',
    device: args.device,
    name: args.name,
    team: 'default',
    delivery: {
      kind: 'codex-appserver',
      thread_id: args.thread_id,
      ws_url: 'ws://127.0.0.1:8799',
    },
  }).agent_id
}

describe('AgentsRepo.findByCodexThreadId', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(dir => rmSync(dir, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('returns the local codex delivery row matching thread_id', () => {
    const { dir, db, repo } = freshRepo()
    cleanups.push(dir)
    const threadId = '11111111-1111-4111-8111-111111111111'
    const agentId = registerCodex(repo, { name: 'codex-a', thread_id: threadId })

    expect(repo.findByCodexThreadId(threadId, 'local')).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        device: 'local',
        name: 'codex-a',
      }),
    ])
    db.close()
  })

  it('orders duplicate thread matches by last_seen_at DESC', () => {
    const { dir, db, repo } = freshRepo()
    cleanups.push(dir)
    const threadId = '22222222-2222-4222-8222-222222222222'
    // Legacy duplicates predate coordinate exclusivity, so they are seeded
    // directly: register() would release the older holder.
    const delivery = {
      kind: 'codex-appserver' as const,
      thread_id: threadId,
      ws_url: 'ws://127.0.0.1:8799',
    }
    insertAgent(db, {
      agent_id: 'older',
      agent_type: 'codex',
      delivery,
      last_seen_at: '2024-01-01T00:00:00.000Z',
    })
    insertAgent(db, {
      agent_id: 'newer',
      agent_type: 'codex',
      delivery,
      last_seen_at: '2024-06-01T00:00:00.000Z',
    })

    expect(repo.findByCodexThreadId(threadId, 'local').map(row => row.name)).toEqual([
      'newer',
      'older',
    ])
    db.close()
  })

  it('ignores another device and non-codex delivery rows', () => {
    const { dir, db, repo } = freshRepo()
    cleanups.push(dir)
    const threadId = '33333333-3333-4333-8333-333333333333'
    registerCodex(repo, { name: 'remote', thread_id: threadId, device: 'gx' })
    repo.register({
      agent_type: 'claude-code',
      name: 'claude',
      team: 'default',
      delivery: { kind: 'none' },
    })

    expect(repo.findByCodexThreadId(threadId, 'local')).toEqual([])
    db.close()
  })

  it('ignores malformed codex delivery payloads instead of throwing', () => {
    const { dir, db, repo } = freshRepo()
    cleanups.push(dir)
    db.prepare(
      `INSERT INTO agents (
         agent_id, agent_type, device, team, role, name, registered_at,
         last_seen_at, delivery_kind, delivery_payload
       ) VALUES ('broken', 'codex', 'local', 'default', 'worker', 'broken',
         '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
         'codex-appserver', 'not-json')`
    ).run()

    expect(repo.findByCodexThreadId(
      '44444444-4444-4444-8444-444444444444',
      'local',
    )).toEqual([])
    db.close()
  })
})
