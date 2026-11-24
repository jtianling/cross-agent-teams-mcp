import { createHmac, randomUUID } from 'node:crypto'
import { chmod, mkdir, rmdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { cleanup, key } from './antigravity-stdio-harness.js'

type Frame = {
  op: 'status' | 'prepare' | 'commit' | 'abort'
  launch_id: string
  attempt: string
  name?: string
  team?: string
  proof: string
}
type Reply = { status: string, detail?: string, name?: string, team?: string }

export async function claims() {
  const launchId = randomUUID()
  const root = '/tmp/xats-agy-' + process.getuid!()
  if (await mkdir(root, { recursive: true, mode: 0o700 })) {
    cleanup.push(() => rmdir(root).catch(err => {
      if (err.code !== 'ENOTEMPTY') throw err
    }))
  }
  const path = join(root, launchId + '.sock')
  const frames: Frame[] = []
  const state: { bound?: Reply, respond?: (req: Frame) => Reply | null } = {}
  const server = createServer(peer => {
    let line = ''
    peer.setEncoding('utf8').on('data', chunk => {
      line += chunk
      if (!line.endsWith('\n')) return
      const req = JSON.parse(line) as Frame
      frames.push(req)
      const keys = ['op', 'launch_id', 'attempt', 'proof']
      if (req.op !== 'status') keys.push('name', 'team')
      const message = ['xats-agy-defer-v1', req.op, launchId, req.name ?? '',
        req.team ?? '', req.attempt].join('\0')
      const proof = createHmac('sha256', key).update(message).digest('hex')
      let response: Reply | null
      if (req.launch_id !== launchId || req.proof !== proof ||
        Object.keys(req).sort().join() !== keys.sort().join() ||
        !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(req.attempt)) {
        response = { status: 'unavailable', detail: 'invalid_request' }
      } else if (state.respond) response = state.respond(req)
      else if (req.op === 'status') response = state.bound ?? { status: 'unbound' }
      else if (req.op === 'commit') {
        state.bound = { status: 'bound', name: req.name, team: req.team }
        response = { status: 'bound' }
      } else if (req.op === 'abort') response = { status: 'released' }
      else response = { status: state.bound ? 'bound' : 'prepared' }
      peer.end(response ? JSON.stringify(response) + '\n' : '')
    })
  })
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(path, resolve))
  cleanup.push(() => new Promise((resolve, reject) =>
    server.close(err => err ? reject(err) : resolve())))
  await chmod(path, 0o600)
  return { frames, state, ops: () => frames.map(req => req.op), env: {
    XATS_AGY_LAUNCH_ID: launchId, XATS_AGY_DEFER_REGISTRATION: '1',
    XATS_AGY_IDENTITY_KEY: key,
  } }
}
