import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remindctlReader } from '../src/reminders/remindctl.js'

const LIST = 'bfe44969-fcb1-49a2-a9c3-a4c711f83bbd'
const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'xats-remindctl-fixture-'))
  dirs.push(dir)
  const scenario = { authorized: true, reminders: [], ...options }
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))
  writeFileSync(join(dir, 'remindctl'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const root = __dirname
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json')))
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'status') {
  process.stdout.write(JSON.stringify({authorized: scenario.authorized, status: 'fixture'}))
} else if (scenario.fail) {
  process.stderr.write('fixture specific failure')
  process.exitCode = 1
} else if (scenario.hang || (scenario.hangInfo && process.argv[2] === 'info')) {
  setTimeout(() => {}, 60000)
} else if (process.argv[2] === 'info') {
  process.stdout.write(JSON.stringify(scenario.native ?? scenario.reminders[0]))
} else {
  process.stdout.write(scenario.invalid ? '{invalid' : JSON.stringify(scenario.reminders))
}
`, { mode: 0o700 })
  vi.stubEnv('PATH', `${dir}:${process.env.PATH}`)
  return {
    calls: () => readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line)),
  }
}

describe('remindctl reader subprocess boundary', () => {
  it('starts no subprocess when the read is already cancelled', async () => {
    const h = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(remindctlReader.read(LIST, controller.signal)).rejects.toThrow()
    expect(() => h.calls()).toThrow(/ENOENT/)
  })

  it('does not start the next native command after cancellation', async () => {
    const reminders = ['first', 'second'].map(id => ({
      id, listID: LIST, title: 'Fixture', isCompleted: false,
    }))
    const h = fixture({ reminders, hangInfo: true })
    const controller = new AbortController()
    const result = remindctlReader.read(LIST, controller.signal,
      { nativeTags: true })
    const rejected = expect(result).rejects.toMatchObject({
      code: 'remindctl_failed',
    })
    await vi.waitFor(() => {
      expect(h.calls()).toContainEqual([
        'info', 'first', '--native', '--json', '--no-input',
      ])
    }, { timeout: 5000, interval: 20 })
    controller.abort()
    await rejected
    expect(h.calls().filter(call => call[0] === 'info')).toHaveLength(1)
  })

  it('reads and validates native tags only when the watch requests them', async () => {
    const reminder = { id: 'one', listID: LIST, title: 'Fixture',
      isCompleted: false }
    const h = fixture({ reminders: [reminder], native: {
      ...reminder, tags: ['已审核'], isFlagged: false,
    } })
    await expect(remindctlReader.read(LIST, new AbortController().signal,
      { nativeTags: true })).resolves.toMatchObject([{ tags: ['已审核'] }])
    expect(h.calls()).toEqual([
      ['status', '--json', '--no-input'],
      ['show', 'all', '--list-id', LIST, '--json', '--no-input'],
      ['info', 'one', '--native', '--json', '--no-input'],
    ])
  })

  it.each([
    {}, { tags: '已审核' }, { tags: [], id: 'different' },
    { tags: [], listID: '02db6e38-c775-4ea6-8f22-31aa74076e81' },
  ])('rejects missing or mismatched native data: %j', async change => {
    const reminder = { id: 'one', listID: LIST, title: 'Fixture',
      isCompleted: false }
    fixture({ reminders: [reminder], native: { ...reminder, ...change } })
    await expect(remindctlReader.read(LIST, new AbortController().signal,
      { nativeTags: true })).rejects.toMatchObject({
      code: 'invalid_remindctl_output',
    })
  })

  it('uses read-only noninteractive commands and parses the list', async () => {
    const h = fixture({ reminders: [{
      id: 'one', listID: LIST, title: 'Fixture', isCompleted: false,
    }] })
    const result = await remindctlReader.read(LIST, new AbortController().signal)
    expect(result).toHaveLength(1)
    expect(h.calls()).toEqual([
      ['status', '--json', '--no-input'],
      ['show', 'all', '--list-id', LIST, '--json', '--no-input'],
    ])
  })

  it('never requests authorization or reads task contents when unauthorized', async () => {
    const h = fixture({ authorized: false })
    await expect(remindctlReader.read(LIST, new AbortController().signal))
      .rejects.toMatchObject({ code: 'reminders_not_authorized' })
    expect(h.calls()).toEqual([['status', '--json', '--no-input']])
  })

  it.each([
    { invalid: true },
    { reminders: [{ id: 'missing-required-fields' }] },
    { reminders: [{
      id: 'wrong-list', listID: '02db6e38-c775-4ea6-8f22-31aa74076e81',
      title: 'Fixture', isCompleted: false,
    }] },
  ])('rejects invalid output instead of treating it as empty: %j', async data => {
    fixture(data)
    await expect(remindctlReader.read(LIST, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_remindctl_output' })
  })

  it('retains the specific command failure', async () => {
    fixture({ fail: true })
    await expect(remindctlReader.read(LIST, new AbortController().signal))
      .rejects.toThrow('fixture specific failure')
  })

  it('aborts the child when the monitor shuts down', async () => {
    fixture({ hang: true })
    const controller = new AbortController()
    const reading = remindctlReader.read(LIST, controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ code: 'remindctl_failed' })
  })
})
