import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import {
  OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
  OpencodeRuntimeRecoveryService,
  __peekOpencodeRecoveryPromptSchedules,
  clearAllOpencodeRecoveryPromptSchedules,
} from '../src/mcp/opencode-runtime-recovery.js'

const PROTOCOL = OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION
const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-runtime-service-'))

interface SetupOptions {
  probeTimeoutMs?: number
  promptTimeoutMs?: number
  probe?: (args: {
    base_url: string
    session_id: string
    auth_token_ref?: string
  }) => Promise<{ ok: true } | { error: string }>
  send?: (args: {
    delivery: {
      kind: 'opencode-server'
      base_url: string
      session_id: string
      auth_token_ref?: string
      runtime_generation?: number
    }
    content: string
    signal: AbortSignal
  }) => Promise<
    | { ok: true; transport_used: 'opencode-server'; session_id: string }
    | { error: 'opencode_inject_failed' }
  >
}

function setup(options: SetupOptions = {}) {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db, { localDevice: 'local' })
  const repo = new AgentsRepo(db)
  const probe = vi.fn(options.probe ?? (async () => ({ ok: true as const })))
  const send = vi.fn(options.send ?? (async args => ({
    ok: true as const,
    transport_used: 'opencode-server' as const,
    session_id: args.delivery.session_id,
  })))
  const service = new OpencodeRuntimeRecoveryService(repo, {
    localDevice: 'local',
    probeTimeoutMs: options.probeTimeoutMs,
    promptTimeoutMs: options.promptTimeoutMs,
    probeExactSession: probe,
    sendRecoveryPrompt: send,
  })
  return { dir, db, repo, service, probe, send }
}

function registerRuntime(
  repo: AgentsRepo,
  args: {
    key: string
    name?: string
    generation?: number
    base_url?: string
    session_id?: string
    agent_type?: 'opencode' | 'codex'
  }
): string {
  const generation = args.generation ?? 1
  return repo.register({
    agent_type: args.agent_type ?? 'opencode',
    name: args.name ?? 'open',
    team: 'dev',
    identity_key: args.key,
    opencode_runtime_generation: generation,
    delivery: args.agent_type === 'codex'
      ? {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'ws://127.0.0.1:8799',
        }
      : {
          kind: 'opencode-server',
          base_url: args.base_url ?? 'http://127.0.0.1:3000',
          session_id: args.session_id ?? 'ses_old',
          auth_token_ref: 'OPENCODE_PASSWORD',
          runtime_generation: generation,
        },
  }).agent_id
}

describe('OpenCode runtime recovery service', () => {
  const cleanups: Array<{ dir: string; close: () => void }> = []

  afterEach(() => {
    clearAllOpencodeRecoveryPromptSchedules()
    for (const cleanup of cleanups) {
      cleanup.close()
      rmSync(cleanup.dir, { recursive: true, force: true })
    }
    cleanups.length = 0
  })

  function track(result: ReturnType<typeof setup>): ReturnType<typeof setup> {
    cleanups.push({ dir: result.dir, close: () => result.db.close() })
    return result
  }

  it('returns unregistered without writing an unknown key', () => {
    const { db, service } = track(setup())
    const result = service.reserve({
      identity_key: 'missing',
      runtime_generation: 1,
      protocol_version: PROTOCOL,
    })
    expect(result).toEqual({
      ok: true,
      need_register: true,
      state: 'unregistered',
    })
    const count = db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as {
      n: number
    }
    expect(count.n).toBe(0)
  })

  it('enforces type and generation ordering with idempotent equality', () => {
    const { repo, service } = track(setup())
    registerRuntime(repo, { key: 'codex-key', agent_type: 'codex' })
    expect(service.reserve({
      identity_key: 'codex-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'agent_type_conflict' })

    registerRuntime(repo, { key: 'open-key', generation: 2 })
    expect(service.reserve({
      identity_key: 'open-key',
      runtime_generation: 1,
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'stale_runtime_generation' })
    expect(service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })).toMatchObject({ ok: true, changed: false })
    expect(service.reserve({
      identity_key: 'open-key',
      runtime_generation: 3,
      protocol_version: PROTOCOL,
    })).toMatchObject({ ok: true, changed: true })
    expect(
      repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )?.opencode_runtime_generation
    ).toBe(3)
  })

  it('converges when another reserve wins the same generation CAS', () => {
    const result = track(setup())
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    const original = result.repo.compareAndSetOpencodeRuntimeGeneration
      .bind(result.repo)
    vi.spyOn(result.repo, 'compareAndSetOpencodeRuntimeGeneration')
      .mockImplementation(args => {
        original(args)
        return { changes: 0 }
      })

    expect(result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })).toEqual({
      ok: true,
      state: 'reserved',
      runtime_generation: 2,
      changed: false,
    })
  })

  it('fails protocol mismatch before write, probe, or prompt', async () => {
    const { repo, service, probe, send } = track(setup())
    registerRuntime(repo, { key: 'open-key' })
    expect(service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL + 1,
    })).toMatchObject({ error: 'protocol_version_mismatch' })
    expect(await service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL + 1,
    })).toMatchObject({ error: 'protocol_version_mismatch' })
    expect(probe).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects lower, higher, and same-generation delivery '
    + 'conflicts pre-probe', async () => {
    const { repo, service, probe } = track(setup())
    registerRuntime(repo, { key: 'open-key', generation: 2 })
    expect(await service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'stale_runtime_generation' })
    expect(await service.commit({
      identity_key: 'open-key',
      runtime_generation: 3,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_generation_not_reserved' })
    expect(await service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_other',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_generation_conflict' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('commits exact delivery, preserves auth, and sends a key-free '
    + 'prompt', async () => {
    const { repo, service, probe, send } = track(setup())
    registerRuntime(repo, { key: 'secret-key', generation: 1 })
    service.reserve({
      identity_key: 'secret-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await service.commit({
      identity_key: 'secret-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001/',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    })).toEqual({
      ok: true,
      state: 'delivery_committed',
      delivery_committed: true,
      connection_bound: false,
      recovery_prompt: 'scheduled',
    })
    expect(probe).toHaveBeenCalledWith({
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      auth_token_ref: 'OPENCODE_PASSWORD',
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].delivery).toMatchObject({
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      runtime_generation: 2,
      auth_token_ref: 'OPENCODE_PASSWORD',
    })
    expect(send.mock.calls[0]![0].content)
      .not.toContain('secret-key')
  })

  it('reports prompt failure after commit and converges on identical '
    + 'retry', async () => {
    let calls = 0
    const result = track(setup({
      send: async args => {
        calls += 1
        if (calls === 1) return { error: 'opencode_inject_failed' }
        return {
          ok: true,
          transport_used: 'opencode-server',
          session_id: args.delivery.session_id,
        }
      },
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })
    const input = {
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    }
    expect(await result.service.commit(input)).toMatchObject({
      error: 'connection_bind_trigger_failed',
      delivery_committed: true,
      connection_bound: false,
    })
    expect(await result.service.commit(input)).toMatchObject({
      ok: true,
      state: 'delivery_committed',
    })
    expect(result.probe).toHaveBeenCalledTimes(1)
    expect(result.send).toHaveBeenCalledTimes(2)
  })

  it('fences an older probe that finishes after a newer generation', async () => {
    const pending = new Map<string, (value: { ok: true }) => void>()
    const result = track(setup({
      probe: args => new Promise(resolve => {
        pending.set(args.session_id, resolve)
      }),
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })
    const older = result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3002',
      session_id: 'ses_two',
      protocol_version: PROTOCOL,
    })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 3,
      protocol_version: PROTOCOL,
    })
    const newer = result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 3,
      base_url: 'http://127.0.0.1:3003',
      session_id: 'ses_three',
      protocol_version: PROTOCOL,
    })
    pending.get('ses_three')!({ ok: true })
    expect(await newer).toMatchObject({ ok: true })
    pending.get('ses_two')!({ ok: true })
    expect(await older).toMatchObject({ error: 'stale_runtime_generation' })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )?.delivery
    ).toMatchObject({
      session_id: 'ses_three',
      runtime_generation: 3,
    })
  })

  it('cancels generation N prompt work when N+1 is reserved', async () => {
    const result = track(setup())
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    const commit = result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })
    expect(__peekOpencodeRecoveryPromptSchedules()).toHaveLength(1)
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })
    expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
    expect(await commit).toMatchObject({
      error: 'connection_bind_trigger_failed',
      delivery_committed: true,
    })
    expect(result.send).not.toHaveBeenCalled()
  })

  it('keeps distinct keys and exact sessions isolated in the same team', async () => {
    const result = track(setup())
    registerRuntime(result.repo, {
      key: 'key-a',
      name: 'pane-a',
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_a_old',
    })
    registerRuntime(result.repo, {
      key: 'key-b',
      name: 'pane-b',
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_b_old',
    })
    for (const [key, session] of [
      ['key-a', 'ses_a_new'],
      ['key-b', 'ses_b_new'],
    ] as const) {
      result.service.reserve({
        identity_key: key,
        runtime_generation: 2,
        protocol_version: PROTOCOL,
      })
      expect(await result.service.commit({
        identity_key: key,
        runtime_generation: 2,
        base_url: 'http://127.0.0.1:3001',
        session_id: session,
        protocol_version: PROTOCOL,
      })).toMatchObject({ ok: true })
    }
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey('key-a', 'local')?.delivery
    ).toMatchObject({ session_id: 'ses_a_new' })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey('key-b', 'local')?.delivery
    ).toMatchObject({ session_id: 'ses_b_new' })
  })

  it('rejects a delivery pair already owned by another identity '
    + 'pre-probe', async () => {
    const result = track(setup())
    registerRuntime(result.repo, {
      key: 'key-a',
      name: 'pane-a',
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_a',
    })
    registerRuntime(result.repo, {
      key: 'key-b',
      name: 'pane-b',
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_b',
    })
    result.service.reserve({
      identity_key: 'key-a',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'key-a',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_b',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_delivery_conflict' })
    expect(result.probe).not.toHaveBeenCalled()
  })

  it('rejects canonical-equivalent legacy delivery pairs pre-probe', async () => {
    const result = track(setup())
    registerRuntime(result.repo, {
      key: 'target-key',
      name: 'target',
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
    })
    registerRuntime(result.repo, {
      key: 'owner-key',
      name: 'owner',
      base_url: 'HTTP://LOCALHOST:80/',
      session_id: 'ses_taken',
    })
    result.service.reserve({
      identity_key: 'target-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'target-key',
      runtime_generation: 2,
      base_url: 'http://localhost',
      session_id: 'ses_taken',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_delivery_conflict' })
    expect(result.probe).not.toHaveBeenCalled()
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'target-key',
        'local'
      )?.delivery
    ).toMatchObject({ session_id: 'ses_old' })
  })

  it('rechecks canonical delivery collision after the exact probe', async () => {
    let result: ReturnType<typeof setup>
    result = track(setup({
      probe: async () => {
        registerRuntime(result.repo, {
          key: 'late-owner-key',
          name: 'late-owner',
          base_url: 'HTTP://LOCALHOST:80/',
          session_id: 'ses_late',
        })
        return { ok: true }
      },
    }))
    registerRuntime(result.repo, {
      key: 'target-key',
      name: 'target',
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
    })
    result.service.reserve({
      identity_key: 'target-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'target-key',
      runtime_generation: 2,
      base_url: 'http://localhost',
      session_id: 'ses_late',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_delivery_conflict' })
    expect(result.probe).toHaveBeenCalledTimes(1)
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'target-key',
        'local'
      )?.delivery
    ).toMatchObject({ session_id: 'ses_old' })
  })

  it('rejects a commit when type changes during the exact probe', async () => {
    let result: ReturnType<typeof setup>
    result = track(setup({
      probe: async () => {
        result.db.prepare(
          `UPDATE agents
           SET agent_type = 'custom',
               register_generation = register_generation + 1
           WHERE identity_key = 'open-key'`
        ).run()
        return { ok: true }
      },
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'agent_type_conflict' })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey('open-key', 'local')?.delivery
    ).toMatchObject({ session_id: 'ses_old', runtime_generation: 1 })
  })

  it('rejects a commit when registration changes during the exact probe', async () => {
    let result: ReturnType<typeof setup>
    result = track(setup({
      probe: async () => {
        result.db.prepare(
          `UPDATE agents
           SET register_generation = register_generation + 1
           WHERE identity_key = 'open-key'`
        ).run()
        return { ok: true }
      },
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'runtime_commit_cas_conflict' })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey('open-key', 'local')?.delivery
    ).toMatchObject({ session_id: 'ses_old', runtime_generation: 1 })
  })

  it('rejects reconnect when type changes during the exact probe', async () => {
    let result: ReturnType<typeof setup>
    result = track(setup({
      probe: async () => {
        result.db.prepare(
          `UPDATE agents
           SET agent_type = 'custom',
               register_generation = register_generation + 1
           WHERE identity_key = 'open-key'`
        ).run()
        return { ok: true }
      },
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })

    expect(await result.service.validateReconnect({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
    })).toMatchObject({ error: 'agent_type_conflict' })
  })

  it('converges concurrent same-generation same-delivery commits', async () => {
    let probeCount = 0
    let releaseProbe!: () => void
    const probeBarrier = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const result = track(setup({
      probe: async () => {
        probeCount += 1
        if (probeCount === 2) releaseProbe()
        await probeBarrier
        return { ok: true }
      },
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })
    const input = {
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    }

    const commits = await Promise.all([
      result.service.commit(input),
      result.service.commit(input),
    ])
    expect(commits).toEqual([
      expect.objectContaining({ ok: true, delivery_committed: true }),
      expect.objectContaining({ ok: true, delivery_committed: true }),
    ])
    expect(result.probe).toHaveBeenCalledTimes(2)
    expect(result.send).toHaveBeenCalledTimes(1)
  })

  it('bounds an exact probe that never resolves without writing', async () => {
    const result = track(setup({
      probe: () => new Promise(() => {}),
      probeTimeoutMs: 10,
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    })).toMatchObject({
      error: 'opencode_unreachable',
      detail: 'exact_session_probe_timeout',
    })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )?.delivery
    ).toMatchObject({ session_id: 'ses_old', runtime_generation: 1 })
    expect(result.send).not.toHaveBeenCalled()
  })

  it('bounds a reconnect exact probe that never resolves', async () => {
    const result = track(setup({
      probe: () => new Promise(() => {}),
      probeTimeoutMs: 10,
    }))
    const agentId = registerRuntime(result.repo, {
      key: 'open-key',
      generation: 1,
    })

    expect(await result.service.validateReconnect({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
    })).toMatchObject({
      error: 'opencode_unreachable',
      detail: 'exact_session_probe_timeout',
    })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )?.agent_id
    ).toBe(agentId)
  })

  it('bounds a recovery prompt that never resolves after commit', async () => {
    let promptSignal: AbortSignal | undefined
    let aborted = false
    const result = track(setup({
      send: args => {
        promptSignal = args.signal
        return new Promise((_, reject) => {
          args.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('late prompt abort'))
          }, { once: true })
        })
      },
      promptTimeoutMs: 10,
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })

    expect(await result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 2,
      base_url: 'http://127.0.0.1:3001',
      session_id: 'ses_new',
      protocol_version: PROTOCOL,
    })).toMatchObject({
      error: 'connection_bind_trigger_failed',
      delivery_committed: true,
      connection_bound: false,
      detail: {
        error: 'opencode_inject_failed',
        detail: 'recovery_prompt_timeout',
      },
    })
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )?.delivery
    ).toMatchObject({ session_id: 'ses_new', runtime_generation: 2 })
    expect(promptSignal?.aborted).toBe(true)
    expect(aborted).toBe(true)
    expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
  })

  it('settles and clears the prompt when its state check throws', async () => {
    const result = track(setup())
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    const current = result.repo.findOpencodeRuntimeByIdentityKey(
      'open-key',
      'local'
    )
    vi.spyOn(result.repo, 'findOpencodeRuntimeByIdentityKey')
      .mockReturnValueOnce(current)
      .mockImplementation(() => {
        throw new Error('prompt state read failed')
      })

    const commit = result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })
    const settled = await Promise.race([
      commit,
      new Promise(resolve => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(settled).toMatchObject({
      error: 'connection_bind_trigger_failed',
      detail: {
        error: 'opencode_inject_failed',
        detail: 'prompt state read failed',
      },
    })
    expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
  })

  it('clears a prompt invalidated by a newer registration', async () => {
    const result = track(setup())
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    const current = result.repo.findOpencodeRuntimeByIdentityKey(
      'open-key',
      'local'
    )
    vi.spyOn(result.repo, 'findOpencodeRuntimeByIdentityKey')
      .mockReturnValueOnce(current)
      .mockReturnValueOnce({
        ...current!,
        register_generation: current!.register_generation + 1,
      })

    expect(await result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })).toMatchObject({ error: 'connection_bind_trigger_failed' })
    expect(result.send).not.toHaveBeenCalled()
    expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
  })

  it('aborts an in-flight prompt when N+1 is reserved', async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })
    let promptSignal: AbortSignal | undefined
    const result = track(setup({
      send: args => {
        promptSignal = args.signal
        resolveStarted()
        return new Promise((_, reject) => {
          args.signal.addEventListener(
            'abort',
            () => reject(new Error('late N prompt abort')),
            { once: true }
          )
        })
      },
      promptTimeoutMs: 1_000,
    }))
    registerRuntime(result.repo, { key: 'open-key', generation: 1 })
    const commit = result.service.commit({
      identity_key: 'open-key',
      runtime_generation: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_old',
      protocol_version: PROTOCOL,
    })
    await started

    expect(result.service.reserve({
      identity_key: 'open-key',
      runtime_generation: 2,
      protocol_version: PROTOCOL,
    })).toMatchObject({ ok: true, changed: true })
    expect(promptSignal?.aborted).toBe(true)
    expect(await commit).toMatchObject({
      error: 'connection_bind_trigger_failed',
      delivery_committed: true,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(result.send).toHaveBeenCalledTimes(1)
    expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
    expect(
      result.repo.findOpencodeRuntimeByIdentityKey(
        'open-key',
        'local'
      )
    ).toMatchObject({
      opencode_runtime_generation: 2,
      delivery: { session_id: 'ses_old', runtime_generation: 1 },
    })
  })

  it('aborts prompts on reconnect cancellation and daemon clear', async () => {
    for (const action of ['reconnect', 'daemon_clear'] as const) {
      let resolveStarted!: () => void
      const started = new Promise<void>(resolve => {
        resolveStarted = resolve
      })
      let promptSignal: AbortSignal | undefined
      const result = track(setup({
        send: args => {
          promptSignal = args.signal
          resolveStarted()
          return new Promise((_, reject) => {
            args.signal.addEventListener(
              'abort',
              () => reject(new Error(`late ${action} prompt abort`)),
              { once: true }
            )
          })
        },
        promptTimeoutMs: 1_000,
      }))
      const agentId = registerRuntime(result.repo, {
        key: `${action}-key`,
        name: action,
        generation: 1,
      })
      const commit = result.service.commit({
        identity_key: `${action}-key`,
        runtime_generation: 1,
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_old',
        protocol_version: PROTOCOL,
      })
      await started

      if (action === 'reconnect') {
        result.service.cancelPrompt(agentId, 1)
      } else {
        clearAllOpencodeRecoveryPromptSchedules()
      }
      expect(promptSignal?.aborted).toBe(true)
      expect(await commit).toMatchObject({
        error: 'connection_bind_trigger_failed',
        delivery_committed: true,
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(result.send).toHaveBeenCalledTimes(1)
      expect(__peekOpencodeRecoveryPromptSchedules()).toEqual([])
      expect(
        result.repo.findOpencodeRuntimeByIdentityKey(
          `${action}-key`,
          'local'
        )?.delivery
      ).toMatchObject({ session_id: 'ses_old', runtime_generation: 1 })
    }
  })
})
