import type { DeliverySpec } from '../lib/delivery-spec.js'
import { canonicalKimiBaseUrl } from '../lib/kimi-url.js'
import { canonicalOpencodeBaseUrl, tryCanonicalOpencodeBaseUrl }
  from '../lib/opencode-url.js'
import { runtimeSchema, type ManagedRuntime } from './schema.js'

export function canonicalRuntime(input: ManagedRuntime): ManagedRuntime {
  const runtime = runtimeSchema.parse(input)
  if (runtime.agent_type === 'codex') {
    return { ...runtime, ws_url: new URL(runtime.ws_url).href }
  }
  if (runtime.agent_type === 'opencode') {
    return { ...runtime, base_url: canonicalOpencodeBaseUrl(runtime.base_url) }
  }
  if (runtime.agent_type === 'kimi-code') {
    return { ...runtime, base_url: canonicalKimiBaseUrl(runtime.base_url) }
  }
  return runtime
}

export function sameDelivery(a: DeliverySpec, b: DeliverySpec): boolean {
  const sorted = (value: DeliverySpec) => JSON.stringify(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  )
  return sorted(a) === sorted(b)
}

export function sameRuntimeAddress(a: DeliverySpec, b: DeliverySpec): boolean {
  if (a.kind === 'codex-appserver' && b.kind === a.kind) {
    return a.thread_id === b.thread_id
  }
  if (a.kind === 'claude-channel' && b.kind === a.kind) {
    return a.channel_session_id === b.channel_session_id
  }
  if (a.kind === 'opencode-server' && b.kind === a.kind) {
    const left = tryCanonicalOpencodeBaseUrl(a.base_url)
    return left !== undefined && left === tryCanonicalOpencodeBaseUrl(b.base_url)
      && a.session_id === b.session_id
  }
  return a.kind === 'kimi-server' && b.kind === a.kind
    && canonicalKimiBaseUrl(a.base_url) === canonicalKimiBaseUrl(b.base_url)
    && a.session_id === b.session_id
}

export function managedDelivery(runtime: ManagedRuntime): DeliverySpec {
  switch (runtime.agent_type) {
    case 'codex': return {
      kind: 'codex-appserver', thread_id: runtime.thread_id,
      ws_url: runtime.ws_url,
    }
    case 'claude-code': return {
      kind: 'claude-channel', channel_session_id: runtime.channel_session_id,
    }
    case 'opencode': return {
      kind: 'opencode-server', base_url: runtime.base_url,
      session_id: runtime.session_id,
    }
    case 'kimi-code': return {
      kind: 'kimi-server', base_url: runtime.base_url,
      session_id: runtime.session_id,
    }
  }
}

