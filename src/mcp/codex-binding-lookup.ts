import { batchProbe } from '../daemon/batch-probe.js'
import { z } from 'zod'
import { CodexBindingRepo, type CodexBindingRow } from './codex-binding-repo.js'
import {
  collapseCarrierMatches,
  defaultListPanes,
  defaultTtyProcesses,
  isForegroundCodexEntry,
  parseCarrierPsLine,
  type CarrierPsEntry,
  type PaneTtyEntry,
} from './auto-bind-codex-pane.js'

export const codexBindingLookupSchema = z.object({
  protocol_version: z.literal(1),
  pane_id: z.string().regex(/^%\d+$/),
  launch_id: z.string().uuid(),
}).strict()

type Input = z.infer<typeof codexBindingLookupSchema>
type Failure = { ok: false; error: 'pending' | 'not_found' | 'stale' | 'ambiguous' }
type Result = Failure | (Input & { ok: true; thread_id: string })

interface ProbeDeps {
  listPanes?: () => Promise<PaneTtyEntry[]>
  ttyProcesses?: (tty: string) => Promise<string[]>
  verifyCarrier?: (tty: string, pid: number, launch: string) =>
    'ok' | 'stale' | 'ambiguous'
  now?: () => Date
}

export class CodexBindingLookup {
  private readonly listPanes = batchProbe(() =>
    (this.probes.listPanes ?? defaultListPanes)())
  private readonly ttyProcesses = batchProbe((tty: string) =>
    (this.probes.ttyProcesses ?? defaultTtyProcesses)(tty))

  constructor(
    private readonly repo: CodexBindingRepo,
    private readonly localDevice: string,
    private readonly probes: ProbeDeps = {}
  ) {}

  async lookup(input: Input): Promise<Result> {
    const row = this.repo.read(input.pane_id)
    const failure = this.check(row, input)
    if (failure) return failure
    const snapshot = row!
    const carrierFailure = await this.checkCarrier(snapshot)
    if (carrierFailure) return carrierFailure
    const current = this.repo.read(input.pane_id)
    const changed = this.check(current, input)
    if (changed) return changed
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
      return { ok: false, error: 'stale' }
    }
    return { ok: true, ...input, thread_id: snapshot.thread_id! }
  }

  private check(row: CodexBindingRow | undefined, input: Input): Failure | undefined {
    if (!row) return { ok: false, error: 'not_found' }
    if (row.launch_id !== input.launch_id) return { ok: false, error: 'stale' }
    if (this.repo.isAmbiguous(input.launch_id)) {
      return { ok: false, error: 'ambiguous' }
    }
    if (row.thread_id === null) {
      const now = (this.probes.now ?? (() => new Date()))().toISOString()
      return { ok: false, error: row.expires_at > now ? 'pending' : 'stale' }
    }
    if (!this.repo.matchesAgent(row, this.localDevice)) {
      return { ok: false, error: 'stale' }
    }
  }

  private async checkCarrier(row: CodexBindingRow): Promise<Failure | undefined> {
    const panes = await this.listPanes('')
    const matches = panes.filter(p => p.pane_id === row.pane_id)
    if (matches.length > 1) return { ok: false, error: 'ambiguous' }
    if (matches.length === 0 || matches[0].tty !== row.runtime_tty) {
      return { ok: false, error: 'stale' }
    }
    if (this.probes.verifyCarrier) {
      if (!row.runtime_ui_pid) return { ok: false, error: 'stale' }
      const status = this.probes.verifyCarrier(
        matches[0].tty, row.runtime_ui_pid, row.launch_id
      )
      return status === 'ok' ? undefined : { ok: false, error: status }
    }
    const lines = await this.ttyProcesses(matches[0].tty)
    const entries = lines.map(parseCarrierPsLine).filter(
      (entry): entry is CarrierPsEntry => entry !== undefined
        && isForegroundCodexEntry(entry, row.launch_id)
    )
    const carrier = collapseCarrierMatches(entries)
    if (carrier.distinctPgids > 1) return { ok: false, error: 'ambiguous' }
    if (!carrier.entry || carrier.entry.pid !== row.runtime_ui_pid) {
      return { ok: false, error: 'stale' }
    }
  }
}
