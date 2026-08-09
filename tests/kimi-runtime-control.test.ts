import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { KimiRuntimeControlService } from '../src/mcp/kimi-runtime-control.js'
import type { ValidateKimiSessionResult } from '../src/mcp/reconnect.js'
import { buildServer } from '../src/daemon/server.js'

const BASE = 'http://127.0.0.1:58627'
const S1 = 'session_11111111-1111-4111-8111-111111111111'
const S2 = 'session_22222222-2222-4222-8222-222222222222'
const KEY = 'IK-launcher'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-kimi-commit-'))

describe('KimiRuntimeControlService.commit', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  function setup(probe?: () => Promise<ValidateKimiSessionResult>) {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const probeSession = vi.fn(probe ?? (async () => ({ ok: true as const })))
    return {
      repo,
      probeSession,
      register: new RegisterAgentService(db),
      svc: new KimiRuntimeControlService(repo, {
        localDevice: 'local',
        probeSession,
      }),
    }
  }

  function registerKimi(
    register: RegisterAgentService,
    args: { name: string; session_id: string; identity_key?: string }
  ): string {
    const res = register.register({
      connection_id: `conn-${args.name}`,
      agent_type: 'kimi-code',
      name: args.name,
      team: 't',
      identity_key: args.identity_key,
      delivery: {
        kind: 'kimi-server',
        session_id: args.session_id,
        base_url: BASE,
      },
    })
    if ('error' in res) throw new Error(JSON.stringify(res))
    return res.agent_id
  }

  const request = (session_id: string) => ({
    protocol_version: 1,
    identity_key: KEY,
    base_url: BASE,
    session_id,
  })

  it('adopts the key onto the row the coordinates already name', async () => {
    const { svc, repo, register, probeSession } = setup()
    const agent_id = registerKimi(register, { name: 'k1', session_id: S1 })

    const result = await svc.commit(request(S1))

    expect(result).toMatchObject({
      ok: true,
      state: 'committed',
      changed: false,
      probed: false,
      agent_id,
      name: 'k1',
      team: 't',
    })
    // Coordinates already matched, so the live session was never re-verified.
    expect(probeSession).not.toHaveBeenCalled()
    expect(repo.findByIdentityKey(KEY, 'local').map(r => r.name)).toEqual(['k1'])
  })

  it('refreshes coordinates by key once adopted, and probes first', async () => {
    const { svc, repo, register, probeSession } = setup()
    const agent_id = registerKimi(register, {
      name: 'k1', session_id: S1, identity_key: KEY,
    })

    const result = await svc.commit(request(S2))

    expect(result).toMatchObject({ ok: true, changed: true, probed: true })
    expect(probeSession).toHaveBeenCalledWith({
      base_url: BASE, session_id: S2, auth_token_ref: undefined,
    })
    expect(repo.findById(agent_id)!.delivery)
      .toMatchObject({ kind: 'kimi-server', session_id: S2 })
    // The old coordinates stop resolving, so no ghost claims them.
    expect(repo.findByKimiSession(BASE, S1, 'local')).toHaveLength(0)
  })

  it('never creates an identity: unknown key and unknown coordinates', async () => {
    const { svc, probeSession } = setup()

    expect(await svc.commit(request(S1))).toEqual({
      ok: true,
      need_register: true,
      state: 'unregistered',
      reason: 'identity_key_not_found',
    })
    expect(probeSession).not.toHaveBeenCalled()
  })

  it('fails closed when the probe refuses the new session', async () => {
    const notFound: ValidateKimiSessionResult = {
      error: 'session_not_found',
      detail: { base_url: BASE, session_id: S2, cause: 'archived' },
    }
    const { svc, repo, register } = setup(async () => notFound)
    const agent_id = registerKimi(register, {
      name: 'k1', session_id: S1, identity_key: KEY,
    })

    expect(await svc.commit(request(S2))).toMatchObject({
      ok: false,
      error: 'session_not_found',
    })
    // Nothing moved: the row still points at the session that still works.
    expect(repo.findById(agent_id)!.delivery)
      .toMatchObject({ session_id: S1 })
  })

  it('refuses coordinates another agent already claims', async () => {
    const { svc, register, repo } = setup()
    registerKimi(register, { name: 'k1', session_id: S1, identity_key: KEY })
    const other = registerKimi(register, { name: 'k2', session_id: S2 })

    expect(await svc.commit(request(S2))).toEqual({
      ok: false,
      error: 'session_claimed_by_other_agent',
      conflicting_agent_id: other,
      name: 'k2',
      team: 't',
    })
    expect(repo.findByIdentityKey(KEY, 'local').map(r => r.name)).toEqual(['k1'])
  })

  it('refuses a key that resolves to a non-kimi row', async () => {
    const { svc, register } = setup()
    const res = register.register({
      connection_id: 'conn-c',
      agent_type: 'claude-code',
      name: 'c1',
      team: 't',
      identity_key: KEY,
      runtime_ui_pid: 999123,
    })
    if ('error' in res) throw new Error('unexpected error')

    expect(await svc.commit(request(S1))).toMatchObject({
      ok: false,
      error: 'agent_type_conflict',
      expected: 'kimi-code',
      actual: 'claude-code',
    })
  })

  it('rejects a protocol version it does not implement', async () => {
    const { svc, probeSession } = setup()
    expect(await svc.commit({ ...request(S1), protocol_version: 2 })).toEqual({
      ok: false,
      error: 'protocol_version_mismatch',
      cli_protocol_version: 2,
      daemon_protocol_version: 1,
    })
    expect(probeSession).not.toHaveBeenCalled()
  })

  // last_seen_at is decision-bearing (the poke retry path reads it as
  // "recipient was active"), and it is what a launcher polls to tell whether a
  // bound session has actually called a tool. A launcher write must not forge
  // either signal.
  it('does not refresh last_seen_at', async () => {
    const { svc, repo, register } = setup()
    const agent_id = registerKimi(register, {
      name: 'k1', session_id: S1, identity_key: KEY,
    })
    const before = repo.findById(agent_id)!.last_seen_at

    await svc.commit(request(S2))

    expect(repo.findById(agent_id)!.last_seen_at).toBe(before)
  })

  it('never reports a runtime_generation', async () => {
    const { svc, register } = setup()
    registerKimi(register, { name: 'k1', session_id: S1, identity_key: KEY })
    const result = await svc.commit(request(S2)) as Record<string, unknown>
    expect(result).not.toHaveProperty('runtime_generation')
  })
})

describe('POST /api/runtime/kimi/commit', () => {
  const apps: FastifyInstance[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const app of apps) await app.close()
    apps.length = 0
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  async function boot(commit: (input: unknown) => Promise<unknown>) {
    const dir = tmp(); dirs.push(dir)
    const app = await buildServer({
      dbPath: join(dir, 'data.db'),
      localDevice: 'local',
      kimiRuntimeControlService: { commit } as never,
    })
    apps.push(app)
    return app
  }

  it('forwards a valid body and preserves the outcome', async () => {
    const commit = vi.fn(async () => ({ ok: true, state: 'committed' }))
    const app = await boot(commit)
    const payload = {
      protocol_version: 1,
      identity_key: KEY,
      base_url: BASE,
      session_id: S1,
    }

    const response = await app.inject({
      method: 'POST', url: '/api/runtime/kimi/commit', payload,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, state: 'committed' })
    expect(commit).toHaveBeenCalledWith(payload)
  })

  it('rejects a body that does not match the schema before calling the service', async () => {
    const commit = vi.fn(async () => ({ ok: true }))
    const app = await boot(commit)

    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/kimi/commit',
      payload: { protocol_version: 1, identity_key: KEY, base_url: BASE },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, error: 'invalid_request' })
    expect(commit).not.toHaveBeenCalled()
  })
})
