import { randomUUID } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readAgyBoundIdentity, requestAgyClaim } from '../../../src/mcp/antigravity-pty.js'
import { ownsLaunch, type DeferredOwner } from './launch.js'
import {
  detail, RegistrationOutcomeUnknown, RegistrationRejected, Upstream,
} from './upstream.js'

const label = z.string().min(1).refine(value => Array.from(value).length <= 256 &&
  value === value.trim() && !/[\x00\uD800-\uDFFF]/u.test(value))
const labels = z.object({ name: label, team: label }).strict()
type Labels = z.infer<typeof labels>
const property = { type: 'string', minLength: 1, maxLength: 256 }
export const registerTool: Tool = {
  name: 'register_agent',
  description: 'Register with the exact name and team supplied by the user.',
  inputSchema: {
    type: 'object', properties: { name: property, team: property },
    required: ['name', 'team'], additionalProperties: false,
  },
}

export function registerToolFor(env: NodeJS.ProcessEnv): Tool {
  if (env.XATS_AGY_AGENTAPI !== '1') return registerTool
  return {
    ...registerTool,
    description: 'Register with the exact name and team supplied by the user. '
      + 'Immediately after this tool succeeds, run `xats-agy-channel-bind` once '
      + 'via run_command to enable automatic xats inbox wakeups.',
  }
}

type Candidate = {
  labels: Labels
  attempt: string
  upstream: Upstream
  mayHaveRegistered: boolean
  releasing: boolean
}

const prepareRefusals = new Set([
  'identity_mismatch', 'agy_unavailable', 'invalid_request', 'invalid_attempt',
  'invalid_proof', 'invalid_launch', 'not_deferred', 'stale_attempt',
])

export class DeferredRegistration {
  private pending?: Candidate
  private boundId?: string
  private queue = Promise.resolve()

  constructor(private env: NodeJS.ProcessEnv, readonly owner: DeferredOwner) {}

  get active() {
    return this.boundId ? this.pending?.upstream : undefined
  }

  register(args: unknown) {
    const identity = labels.parse(args)
    return this.serial(() => this.bind(identity))
  }

  recover() {
    return this.serial(async () => {
      if (this.active || this.pending) return this.active
      const { pid, launchId, key } = this.owner
      if (!await ownsLaunch(pid)) throw new Error('Lost launcher process ancestry')
      const status = await readAgyBoundIdentity(launchId, key)
      if (status.status === 'unavailable') {
        throw new Error('status failed: ' + (status.detail ?? status.status))
      }
      if (status.status === 'unbound') return
      const identity = labels.parse({ name: status.name, team: status.team })
      const candidate = this.candidate(identity)
      this.boundId = await candidate.upstream.identity()
      this.pending = candidate
      return candidate.upstream
    })
  }

  private serial<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  async close() {
    await this.queue
    await this.pending?.upstream.close()
  }

  private candidate(identity: Labels) {
    const { pid, launchId, key } = this.owner
    const fields = { ...identity, agy_launch_id: launchId, identity_key: key }
    return { labels: identity, attempt: randomUUID(),
      upstream: new Upstream(this.env, { pid, fields }),
      mayHaveRegistered: false, releasing: false }
  }

  private claim(op: 'prepare' | 'commit' | 'abort', candidate: Candidate) {
    return requestAgyClaim(op, {
      ...candidate.labels, launch_id: this.owner.launchId, attempt: candidate.attempt,
    }, this.owner.key)
  }

  private async release(candidate: Candidate) {
    candidate.releasing = true
    const reply = await this.claim('abort', candidate)
    if (reply.status !== 'released') {
      if (reply.detail === 'abort_forbidden') {
        candidate.releasing = false
        candidate.mayHaveRegistered = true
      }
      throw new Error('abort failed: ' + (reply.detail ?? reply.status))
    }
    this.pending = undefined
  }

  private async bind(identity: Labels) {
    if (!await ownsLaunch(this.owner.pid)) throw new Error('Lost launcher process ancestry')
    const prior = this.pending
    if (prior && (prior.labels.name !== identity.name || prior.labels.team !== identity.team)) {
      throw new Error('Identity is fixed; retry with the original name and team')
    }
    if (this.boundId) return { agent_id: this.boundId, team: identity.team }
    if (prior?.releasing) await this.release(prior)
    const fresh = !this.pending
    const candidate = this.pending ??= this.candidate(identity)
    const prepared = await this.claim('prepare', candidate)
    if (prepared.status !== 'prepared' && prepared.status !== 'bound') {
      // A retry-time identity mismatch proves this tuple does not own the
      // launcher. Other rejections can coexist with an earlier reservation.
      const unclaimed = prepared.detail === 'identity_mismatch'
        || (fresh && prepareRefusals.has(prepared.detail ?? ''))
      if (!candidate.mayHaveRegistered && unclaimed) {
        this.pending = undefined
      }
      throw new Error('prepare failed: ' + (prepared.detail ?? prepared.status))
    }
    if (prepared.status === 'bound') candidate.mayHaveRegistered = true
    // A previous daemon session may have expired while commit was uncertain.
    if (!fresh) await candidate.upstream.close()
    const id = await this.registerCandidate(candidate)
    if (prepared.status !== 'bound') {
      const commit = await this.claim('commit', candidate)
      if (commit.status !== 'bound') {
        throw new Error('commit failed: ' + (commit.detail ?? commit.status))
      }
    }
    this.boundId = id
    return { agent_id: id, team: identity.team }
  }

  private async registerCandidate(candidate: Candidate) {
    try {
      const id = await candidate.upstream.identity()
      candidate.mayHaveRegistered = true
      return id
    } catch (err) {
      if (err instanceof RegistrationOutcomeUnknown) candidate.mayHaveRegistered = true
      if (err instanceof RegistrationRejected && !candidate.mayHaveRegistered) {
        try { await this.release(candidate) } catch (abortErr) {
          throw new Error(detail(err) + '. ' + detail(abortErr))
        }
      }
      throw err
    }
  }
}
