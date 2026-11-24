#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { DeferredRegistration, registerTool, registerToolFor } from './deferred.js'
import { getLaunch, ownsLaunch } from './launch.js'
import { offlineTools } from './offline-tools.js'
import {
  allowed, callTool, detail, discoverTools, info, listTools, redact, Upstream,
} from './upstream.js'

async function main() {
  if (process.argv[2] === '--capabilities-json') {
    console.log(JSON.stringify({ defer_registration: 1 }))
    return
  }
  const env = process.env
  const launch = getLaunch(env)
  const owner = launch && await ownsLaunch(launch.pid) ? launch : undefined
  const named = owner?.mode === 'named' ? new Upstream(env, owner) : undefined
  const deferred = owner?.mode === 'deferred' ? new DeferredRegistration(env, owner)
    : undefined
  const server = new Server(info, {
    capabilities: { tools: deferred ? { listChanged: true } : {} },
  })
  let heartbeat: NodeJS.Timeout | undefined
  let collisionRetry: NodeJS.Timeout | undefined
  let closing = false
  const collisionBackoffMs = [150, 300, 600, 1200]
  function startHeartbeat(upstream?: Upstream) {
    if (!upstream || heartbeat || closing) return
    if (deferred) void server.sendToolListChanged().catch(report)
    let retries = 0
    const check = () => {
      clearTimeout(collisionRetry)
      collisionRetry = undefined
      void upstream.run(client => client.ping({ timeout: 5000 })).then(
        () => { retries = 0 },
        err => {
          report(err)
          if (!deferred && !closing && retries < collisionBackoffMs.length
            && detail(err).includes('"agent_id_collision"')) {
            collisionRetry = setTimeout(check, collisionBackoffMs[retries++]).unref()
          }
        },
      )
    }
    check()
    heartbeat = setInterval(check, 30_000).unref()
  }
  server.oninitialized = () => startHeartbeat(named)
  attachTools(server, named, deferred, startHeartbeat)
  server.onerror = report
  process.stdin.once('end', () => {
    closing = true
    clearInterval(heartbeat)
    clearTimeout(collisionRetry)
    void server.close().then(() => deferred ? deferred.close() : named?.close()).catch(report)
  })
  await server.connect(new StdioServerTransport())
}

function attachTools(
  server: Server, named: Upstream | undefined, deferred: DeferredRegistration | undefined,
  startHeartbeat: (upstream?: Upstream) => void,
) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const active = named ?? deferred?.active
    const regTool = registerToolFor(process.env)
    if (active) {
      const page = await active.run(listTools)
      return deferred ? { tools: [regTool, ...page.tools] } : page
    }
    if (!deferred) return { tools: [] }
    try {
      const page = await discoverTools(process.env, deferred.owner.pid)
      return { tools: [regTool, ...page.tools] }
    } catch (err) {
      report(new Error('tools/list discovery failed: ' + detail(err)))
      return { tools: [regTool, ...offlineTools] }
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    if (deferred && params.name === registerTool.name) {
      try {
        const identity = await deferred.register(params.arguments)
        startHeartbeat(deferred.active)
        const payload = process.env.XATS_AGY_AGENTAPI === '1'
          ? {
              ...identity,
              next_step: 'Run `xats-agy-channel-bind` once via run_command to enable automatic xats inbox wakeups.',
            }
          : identity
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
      } catch (err) {
        throw new Error(redact(detail(err), process.env))
      }
    }
    if (!allowed.has(params.name) || (!named && !deferred)) {
      throw new McpError(ErrorCode.InvalidParams, 'Tool unavailable in this session')
    }
    let upstream = named ?? deferred?.active
    if (!upstream) {
      try { upstream = await deferred?.recover() } catch (err) {
        throw new Error(redact(detail(err), process.env))
      }
      if (!upstream) throw new McpError(ErrorCode.InvalidParams, 'Call register_agent first')
      startHeartbeat(upstream)
    }
    return upstream.run((client, retire) =>
      callTool(client, params.name, params.arguments, signal, retire))
  })
}

function report(err: unknown) {
  console.error('xats-agy-mcp: ' + redact(detail(err), process.env))
}

main().catch(err => {
  report(err)
  process.exitCode = 1
})
