import { expect, it, vi } from 'vitest'
import { batchProbe } from '../src/daemon/batch-probe.js'

it('shares queued snapshots only for the same socket generation', async () => {
  type Socket = { path: string; inode: number }
  const finishes: Array<(n: number) => void> = []
  const read = vi.fn((_socket: Socket) =>
    new Promise<number>(resolve => finishes.push(resolve)))
  const panes = batchProbe(read, s => JSON.stringify([s.path, s.inode]))
  const socket = { path: '/fixture', inode: 10 }
  const first = panes(socket)
  const same = panes({ ...socket })
  const replaced = panes({ ...socket, inode: 11 })
  await new Promise(resolve => setImmediate(resolve))
  const recheck = panes(socket)
  await new Promise(resolve => setImmediate(resolve))
  expect(read).toHaveBeenCalledTimes(3)
  finishes.forEach((finish, i) => finish(i))
  expect(await Promise.all([first, same, replaced, recheck])).toEqual([0, 0, 1, 2])
})
