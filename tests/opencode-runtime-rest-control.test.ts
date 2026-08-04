import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/daemon/server.js'
import type {
  OpencodeRuntimeControlService,
} from '../src/daemon/rest-api.js'
import type {
  CommitOpencodeRuntimeRestInput,
  ReserveOpencodeRuntimeRestInput,
} from '../src/mcp/opencode-runtime-control-schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-runtime-rest-'))

function runtimeService() {
  const reserve = vi.fn(
    (_input: ReserveOpencodeRuntimeRestInput): unknown => ({
      ok: true,
      need_register: true,
      state: 'unregistered',
    })
  )
  const commit = vi.fn(
    async (_input: CommitOpencodeRuntimeRestInput): Promise<unknown> => ({
      ok: true,
      delivery_committed: true,
      connection_bound: false,
    })
  )
  return { reserve, commit }
}

interface BootOptions {
  service?: OpencodeRuntimeControlService
  token?: string
  logs?: string[]
}

describe('OpenCode runtime REST control', () => {
  const apps: FastifyInstance[] = []
  const dirs: string[] = []

  async function boot(options: BootOptions = {}): Promise<FastifyInstance> {
    const dir = tmp()
    dirs.push(dir)
    const app = await buildServer({
      dbPath: join(dir, 'data.db'),
      localDevice: 'local',
      runtimeControlService: options.service ?? runtimeService(),
      token: options.token,
      mcpLog: options.logs?.push.bind(options.logs),
    })
    apps.push(app)
    return app
  }

  afterEach(async () => {
    for (const app of apps) await app.close()
    apps.length = 0
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('3.1 forwards reserve fields and preserves fresh HTTP 200 outcome', async () => {
    const service = runtimeService()
    const app = await boot({ service })
    const input = {
      identity_key: 'a',
      runtime_generation: 2,
      protocol_version: 1,
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload: input,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      need_register: true,
      state: 'unregistered',
    })
    expect(service.reserve).toHaveBeenCalledOnce()
    expect(service.reserve).toHaveBeenCalledWith(input)
    expect(service.commit).not.toHaveBeenCalled()
  })

  it('3.1 forwards commit fields and preserves successful outcome', async () => {
    const service = runtimeService()
    const app = await boot({ service })
    const input = {
      identity_key: 'runtime-key',
      runtime_generation: 3,
      protocol_version: 1,
      base_url: 'http://127.0.0.1:3000',
      session_id: 'ses_exact',
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/commit',
      payload: input,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      delivery_committed: true,
      connection_bound: false,
    })
    expect(service.commit).toHaveBeenCalledOnce()
    expect(service.commit).toHaveBeenCalledWith(input)
    expect(service.reserve).not.toHaveBeenCalled()
  })

  it('3.1 preserves unsuccessful domain outcomes behind HTTP 200', async () => {
    const service = runtimeService()
    service.reserve.mockReturnValue({
      ok: false,
      error: 'stale_runtime_generation',
      current_runtime_generation: 5,
    })
    service.commit.mockResolvedValue({
      ok: false,
      error: 'connection_bind_trigger_failed',
    })
    const app = await boot({ service })

    const reserve = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload: {
        identity_key: 'reserve-key',
        runtime_generation: 4,
        protocol_version: 1,
      },
    })
    const commit = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/commit',
      payload: {
        identity_key: 'commit-key',
        runtime_generation: 5,
        protocol_version: 1,
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_exact',
      },
    })

    expect(reserve.statusCode).toBe(200)
    expect(reserve.json()).toEqual({
      ok: false,
      error: 'stale_runtime_generation',
      current_runtime_generation: 5,
    })
    expect(commit.statusCode).toBe(200)
    expect(commit.json()).toEqual({
      ok: false,
      error: 'connection_bind_trigger_failed',
    })
  })

  it('3.2 rejects strict schema failures before service invocation', async () => {
    const key = 'secret-input'
    const service = runtimeService()
    const app = await boot({ service })
    const invalidBodies = [
      {
        identity_key: key,
        runtime_generation: 1,
        protocol_version: 1,
        [key]: 'unknown-field',
      },
      {
        identity_key: key,
        runtime_generation: 1,
        protocol_version: 1,
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_exact',
        [key]: 'unknown-field',
      },
      { identity_key: key, runtime_generation: 1 },
      {
        identity_key: key,
        runtime_generation: 0,
        protocol_version: 1,
      },
      {
        identity_key: key,
        runtime_generation: 1,
        protocol_version: 1,
        base_url: `http://127.0.0.1:3000?key=${key}`,
        session_id: 'ses_exact',
      },
      {
        identity_key: key,
        runtime_generation: 1,
        protocol_version: 1,
        base_url: 'http://127.0.0.1:3000',
        session_id: 'latest',
      },
    ]

    for (const body of invalidBodies) {
      const url = 'base_url' in body
        ? '/api/runtime/opencode/commit'
        : '/api/runtime/opencode/reserve'
      const response = await app.inject({
        method: 'POST',
        url,
        payload: body,
      })
      const result = response.json()
      expect(response.statusCode).toBe(400)
      expect(result).toMatchObject({ ok: false, error: 'invalid_request' })
      expect(result.detail).toBe('Request body does not match schema')
      expect(response.body).not.toContain(key)
    }
    expect(service.reserve).not.toHaveBeenCalled()
    expect(service.commit).not.toHaveBeenCalled()
  })

  it('3.2 rejects malformed JSON with a stable envelope', async () => {
    const service = runtimeService()
    const app = await boot({ service })

    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      headers: { 'content-type': 'application/json' },
      payload: '{"identity_key":"secret-input",',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      ok: false,
      error: 'invalid_request',
      detail: 'Invalid JSON body',
    })
    expect(response.body).not.toContain('secret-input')
    expect(service.reserve).not.toHaveBeenCalled()
  })

  it('3.2 keeps protocol mismatch as a service outcome', async () => {
    const service = runtimeService()
    service.reserve.mockReturnValue({
      ok: false,
      error: 'protocol_version_mismatch',
      cli_protocol_version: 999,
      daemon_protocol_version: 1,
    })
    const app = await boot({ service })
    const input = {
      identity_key: 'protocol-key',
      runtime_generation: 1,
      protocol_version: 999,
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload: input,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: false,
      error: 'protocol_version_mismatch',
      cli_protocol_version: 999,
      daemon_protocol_version: 1,
    })
    expect(service.reserve).toHaveBeenCalledWith(input)
  })

  it('3.2 applies bearer auth and remote origin gates first', async () => {
    const service = runtimeService()
    const app = await boot({ service, token: 'daemon-token' })
    const payload = {
      identity_key: 'runtime-key',
      runtime_generation: 1,
      protocol_version: 1,
    }

    const noToken = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload,
    })
    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      headers: { authorization: 'Bearer wrong-token' },
      payload,
    })
    const remote = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      headers: {
        authorization: 'Bearer daemon-token',
        'x-forwarded-for': '127.0.0.1',
      },
      remoteAddress: '10.0.0.42',
      payload,
    })

    expect(noToken.statusCode).toBe(401)
    expect(wrongToken.statusCode).toBe(401)
    expect(remote.statusCode).toBe(403)
    expect(service.reserve).not.toHaveBeenCalled()
  })

  it('3.3 never echoes keys from normal or exceptional paths', async () => {
    const key = 'runtime-secret-exception'
    const logs: string[] = []
    const service = runtimeService()
    const app = await boot({ service, logs })
    const payload = {
      identity_key: key,
      runtime_generation: 1,
      protocol_version: 1,
    }

    const normal = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload,
    })
    service.reserve.mockImplementation(() => {
      throw new Error(`internal failure for ${key}`)
    })
    const exceptional = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload,
    })
    service.reserve.mockImplementation(() => {
      const error = new Error(`storage failure for ${key}`)
      error.name = 'SqliteError'
      throw error
    })
    const storage = await app.inject({
      method: 'POST',
      url: '/api/runtime/opencode/reserve',
      payload,
    })

    expect(normal.statusCode).toBe(200)
    expect(normal.json()).toEqual({
      ok: true,
      need_register: true,
      state: 'unregistered',
    })
    expect(exceptional.statusCode).toBe(500)
    expect(exceptional.json()).toEqual({
      ok: false,
      error: 'internal_error',
    })
    expect(storage.statusCode).toBe(503)
    expect(storage.json()).toEqual({
      ok: false,
      error: 'storage_unavailable',
    })
    expect(normal.body + exceptional.body + storage.body).not.toContain(key)
    expect(logs.join('\n')).not.toContain(key)
  })
})
