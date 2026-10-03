import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { insertAgent } from './helpers/insert-agent.js'
import { fakePaneSnapshot } from './helpers/pane-snapshot.js'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'idle-tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
  }
})

import * as tmuxCli from '../src/daemon/tmux-cli.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { GetDeliveryStatusService } from '../src/mcp/delivery-status.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { createAutoPokeImpl } from '../src/mcp/tools.js'
import { clearAllRetries, __peekRetryMap } from '../src/mcp/poke-retry.js'

const DEVICE = 'jt'
const PANE = '%19'
const DEAD_PID = 999_999
// tester-2 in the incident: registered, process gone, row (and pane) left behind.
const VICTIM = 'aaaaaaaa-0000-0000-0000-000000000001'
// reviewer in the incident: took over the same physical pane afterwards.
const SQUATTER = 'bbbbbbbb-0000-0000-0000-000000000002'
const SENDER = 'cccccccc-0000-0000-0000-000000000003'

interface Setup {
  db: ReturnType<typeof openDb>
  sendSvc: SendMessageService
  broadcastSvc: BroadcastService
  statusSvc: GetDeliveryStatusService
  inboxSvc: GetInboxService
  cleanup: () => void
}

function setup(args: { victimPid: number | null }): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'atm-pane-reassigned-'))
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)

  insertAgent(db, {
    agent_id: SENDER, device: DEVICE, team: 'webdot', name: 'main', role: 'lead',
  })
  insertAgent(db, {
    agent_id: VICTIM, device: DEVICE, team: 'webdot', name: 'tester-2', role: 'tester',
    tmux_pane_id: PANE, runtime_ui_pid: args.victimPid,
  })
  insertAgent(db, {
    agent_id: SQUATTER, device: DEVICE, team: 'sub2api', name: 'reviewer', role: 'reviewer',
    tmux_pane_id: PANE, runtime_ui_pid: process.pid,
  })

  const deps = {
    poke: createAutoPokeImpl(db, agents, undefined, DEVICE),
    tmuxAvailable: async () => true,
    paneSnapshot: fakePaneSnapshot([{ pane_id: PANE, pane_pid: process.pid }]),
  }
  return {
    db,
    sendSvc: new SendMessageService(db, agents, events, deps),
    broadcastSvc: new BroadcastService(db, agents, deps),
    statusSvc: new GetDeliveryStatusService(db),
    inboxSvc: new GetInboxService(db, agents),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('poke skips a pane whose host changed (2026-07 incident)', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => { vi.clearAllMocks(); process.env.POKE_QUIET_MS = '50' })
  afterEach(() => {
    clearAllRetries()
    cleanups.forEach(c => c()); cleanups.length = 0
    delete process.env.POKE_QUIET_MS
  })

  it('broadcast to a team holding a stale pane binding injects nothing', async () => {
    const { broadcastSvc, db, cleanup } = setup({ victimPid: DEAD_PID })
    cleanups.push(cleanup)

    const r = await broadcastSvc.broadcast({ from: SENDER, body: 'cross-check please' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    expect(r.poke_skip_reasons).toContainEqual({ agent_id: VICTIM, reason: 'pane_reassigned' })
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()

    const mail = db.prepare(
      'SELECT body FROM messages WHERE to_agent_id=?'
    ).get(VICTIM) as { body: string } | undefined
    expect(mail?.body).toBe('cross-check please')
  })

  it('direct send_message_by_id is covered by the same gate', async () => {
    const { sendSvc, statusSvc, inboxSvc, cleanup } = setup({ victimPid: DEAD_PID })
    cleanups.push(cleanup)

    const r = await sendSvc.send({ from: SENDER, to_agent_id: VICTIM, body: 'direct ping' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    expect(r.poke_skip_reasons).toContainEqual({ agent_id: VICTIM, reason: 'pane_reassigned' })
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()

    // pane_reassigned is terminal: retrying cannot hand the pane back.
    expect(r.retry_scheduled).toBe(false)
    expect(__peekRetryMap().size).toBe(0)

    const status = statusSvc.get({ caller: SENDER, message_id: r.message_id })
    if ('error' in status) throw new Error('expected statuses')
    expect(status.statuses).toContainEqual(
      expect.objectContaining({
        agent_id: VICTIM,
        wake_status: 'skipped',
        skip_reason: 'pane_reassigned',
      })
    )

    const inbox = inboxSvc.get({ caller: VICTIM })
    if ('error' in inbox) throw new Error('expected inbox')
    expect(inbox.messages.map(m => m.body)).toContain('direct ping')
  })

  it('a live host on its own pane is injected exactly as before', async () => {
    const { sendSvc, cleanup } = setup({ victimPid: process.pid })
    cleanups.push(cleanup)

    const r = await sendSvc.send({ from: SENDER, to_agent_id: VICTIM, body: 'direct ping' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(true)
    expect(r.poke_skip_reasons ?? []).toEqual([])
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledWith(expect.any(String), PANE)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledWith(PANE)
    expect(vi.mocked(tmuxCli.loadBuffer)).toHaveBeenCalledWith(
      expect.any(String),
      `新邮件 from main@webdot (${SENDER}) → tester-2@webdot, 请调 get_inbox 查看`
    )
  })
})
