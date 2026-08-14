import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { PreRegisterCodexPaneService } from '../src/mcp/pre-register-codex-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-declared-'))

describe('PreRegisterCodexPaneService declared identity', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo
  let service: PreRegisterCodexPaneService

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
    service = new PreRegisterCodexPaneService(repo, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      carrierAlive: () => false,
    })
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(dir => rmSync(dir, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function registerDeclared(team: string, agentName: string) {
    return service.register({
      pane_id: '%25',
      xats_agent_id: 'U1',
      team,
      agent_name: agentName,
    })
  }

  it('trims edges while preserving spaces and single quotes', () => {
    expect(registerDeclared(' monkeys team ', " mvr 'coder' ")).toMatchObject({
      ok: true,
      received_fields: expect.arrayContaining(['team', 'agent_name']),
    })
    expect(repo.getByPaneId('%25')).toMatchObject({
      team: 'monkeys team',
      agent_name: "mvr 'coder'",
    })
  })

  it('passes the normalized declaration to the accepted hook', () => {
    const onAccepted = vi.fn()
    service = new PreRegisterCodexPaneService(repo, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      carrierAlive: () => false,
      onAccepted,
    })
    expect(registerDeclared(' monkeys ', ' mvr-coder ')).toMatchObject({
      ok: true,
    })
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({
      team: 'monkeys',
      agent_name: 'mvr-coder',
    }))
  })

  it('accepts a colon in team and stores half a declaration', () => {
    const result = service.register({
      pane_id: '%25',
      xats_agent_id: 'U1',
      team: 'monkeys:a',
    })
    expect(result).toMatchObject({ ok: true })
    expect(repo.getByPaneId('%25')).toMatchObject({
      team: 'monkeys:a',
      agent_name: null,
    })
  })

  it.each([
    ['agent_name', 'mvr-coder(monkeys)'],
    ['agent_name', 'mvr-coder:jt'],
    ['team', 'monkeys(a)'],
    ['agent_name', 'mvr"coder'],
    ['agent_name', 'mvr\ncoder'],
    ['agent_name', 'mvr\rcoder'],
    ['team', 'monkeys\tteam'],
    ['team', 'monkeys\u0085team'],
    ['agent_name', 'mvr\u2028coder'],
    ['team', 'monkeys\u2029team'],
    ['agent_name', '   '],
    ['team', '   '],
  ] as const)('rejects invalid %s without writing state', (field, value) => {
    const result = service.register({
      pane_id: '%25',
      xats_agent_id: 'U1',
      [field]: value,
    })
    expect(result).toMatchObject({ error: 'invalid_arguments' })
    expect((result as { detail: string }).detail).toContain(field)
    expect(repo.getByPaneId('%25')).toBeUndefined()
  })

  it('validation happens before replacing an existing row', () => {
    expect(registerDeclared('monkeys', 'mvr-coder')).toMatchObject({ ok: true })
    const before = repo.getByPaneId('%25')
    const result = registerDeclared('monkeys', 'mvr-coder(monkeys)')
    expect(result).toMatchObject({ error: 'invalid_arguments' })
    expect(repo.getByPaneId('%25')).toEqual(before)
  })
})
