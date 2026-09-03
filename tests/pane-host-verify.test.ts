import { describe, it, expect } from 'vitest'
import {
  memoizePaneSnapshot,
  verifyPaneHost,
  type PaneHostRow,
} from '../src/mcp/pane-host-verify.js'
import { paneSnapshotOf } from './helpers/pane-snapshot.js'

const LOCAL = 'jt'
const DEAD_PID = 999_999
const LIVE_PID = 4242

const alive = (pid: number): boolean => pid === LIVE_PID
const noTty = async (): Promise<string | null> => null

function row(overrides: Partial<PaneHostRow> = {}): PaneHostRow {
  return { agent_id: 'A', device: LOCAL, runtime_ui_pid: null, ...overrides }
}

describe('verifyPaneHost', () => {
  it('rule 1: a remote-device row never verifies against a local pane', async () => {
    const verdict = await verifyPaneHost({
      row: row({ device: 'gx' }),
      paneId: '%9',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%9' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: noTty,
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 2: a dead runtime_ui_pid does not verify', async () => {
    const verdict = await verifyPaneHost({
      row: row({ runtime_ui_pid: DEAD_PID }),
      paneId: '%19',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%19', tty: 'ttys019' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys019',
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 3: a live pid whose tty is the pane tty verifies', async () => {
    const verdict = await verifyPaneHost({
      row: row({ runtime_ui_pid: LIVE_PID }),
      paneId: '%19',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%19', tty: 'ttys019' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys019',
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('rule 3: a live pid equal to pane_pid verifies without a tty lookup', async () => {
    let ttyLookups = 0
    const verdict = await verifyPaneHost({
      row: row({ runtime_ui_pid: LIVE_PID }),
      paneId: '%19',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%19', tty: 'other', pane_pid: LIVE_PID }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => { ttyLookups += 1; return null },
    })
    expect(verdict).toEqual({ ok: true })
    expect(ttyLookups).toBe(0)
  })

  it('rule 3: a live pid sitting on another tty does not verify', async () => {
    const verdict = await verifyPaneHost({
      row: row({ runtime_ui_pid: LIVE_PID }),
      paneId: '%19',
      paneSnapshot: paneSnapshotOf([
        { pane_id: '%19', tty: 'ttys019' },
        { pane_id: '%31', tty: 'ttys031' },
      ]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys031',
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 3: a live pid on a pane that no longer exists does not verify', async () => {
    const verdict = await verifyPaneHost({
      row: row({ runtime_ui_pid: LIVE_PID }),
      paneId: '%19',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%31' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys019',
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 4: a pid-less row on an uncontested live pane verifies', async () => {
    const verdict = await verifyPaneHost({
      row: row(),
      paneId: '%23',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%23' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: noTty,
      findPaneClaimants: () => [],
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('rule 4: a pid-less row on a vanished pane does not verify', async () => {
    const verdict = await verifyPaneHost({
      row: row(),
      paneId: '%23',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%7' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: noTty,
      findPaneClaimants: () => [],
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 4: a pid-less row loses to a confirmed live host on the same pane', async () => {
    const verdict = await verifyPaneHost({
      row: row(),
      paneId: '%7',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%7', tty: 'ttys007' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys007',
      findPaneClaimants: () => [{ agent_id: 'B', device: LOCAL, runtime_ui_pid: LIVE_PID }],
    })
    expect(verdict).toEqual({ ok: false, reason: 'pane_reassigned' })
  })

  it('rule 4: claimants that are themselves dead or pid-less do not evict', async () => {
    const verdict = await verifyPaneHost({
      row: row(),
      paneId: '%7',
      paneSnapshot: paneSnapshotOf([{ pane_id: '%7', tty: 'ttys007' }]),
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys007',
      findPaneClaimants: () => [
        { agent_id: 'B', device: LOCAL, runtime_ui_pid: DEAD_PID },
        { agent_id: 'C', device: LOCAL, runtime_ui_pid: null },
      ],
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('an unavailable tmux snapshot is undecidable on rules 3 and 4 — never pane_reassigned, never a pass', async () => {
    const live = await verifyPaneHost({
      row: row({ runtime_ui_pid: LIVE_PID }),
      paneId: '%19',
      paneSnapshot: null,
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: async () => 'ttys031',
    })
    const pidless = await verifyPaneHost({
      row: row(),
      paneId: '%19',
      paneSnapshot: null,
      localDevice: LOCAL,
      isProcessAlive: alive,
      readPidTty: noTty,
      findPaneClaimants: () => [{ agent_id: 'B', device: LOCAL, runtime_ui_pid: LIVE_PID }],
    })
    expect(live).toEqual({ ok: false, reason: 'undecidable' })
    expect(pidless).toEqual({ ok: false, reason: 'undecidable' })
  })
})

describe('memoizePaneSnapshot', () => {
  it('queries tmux once no matter how many recipients ask', async () => {
    let loads = 0
    const loader = memoizePaneSnapshot(async () => {
      loads += 1
      return paneSnapshotOf([{ pane_id: '%1' }])
    })
    const results = await Promise.all([loader(), loader(), loader(), loader()])
    expect(loads).toBe(1)
    expect(results.every(r => r?.has('%1'))).toBe(true)
  })
})
