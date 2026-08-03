import { kimiBaseUrlIssue } from './kimi-url.js';

export type DeliveryNone = {
  kind: 'none';
};

export type DeliveryClaudeChannel = {
  kind: 'claude-channel';
  channel_session_id: string;
};

export type DeliveryCodexAppserver = {
  kind: 'codex-appserver';
  thread_id: string;
  ws_url: string;
  auth_token_ref?: string;
};

export type DeliveryOpencodeServer = {
  kind: 'opencode-server';
  session_id: string;
  base_url: string;
  auth_token_ref?: string;
  runtime_generation?: number;
};

export type DeliveryKimiServer = {
  kind: 'kimi-server';
  session_id: string;
  base_url: string;
  auth_token_ref?: string;
};

export type DeliverySpec =
  | DeliveryNone
  | DeliveryClaudeChannel
  | DeliveryCodexAppserver
  | DeliveryOpencodeServer
  | DeliveryKimiServer;

export type DeliveryKind = DeliverySpec['kind'];

export const DELIVERY_KINDS: readonly DeliveryKind[] = [
  'none',
  'claude-channel',
  'codex-appserver',
  'opencode-server',
  'kimi-server',
] as const;

export type DeliveryRow = {
  delivery_kind: string;
  delivery_payload: string | null;
};

export function parseDeliveryRow(row: DeliveryRow): DeliverySpec {
  const kind = row.delivery_kind;
  if (kind === 'none') {
    return { kind: 'none' };
  }
  if (!(DELIVERY_KINDS as readonly string[]).includes(kind)) {
    throw new Error('corrupt_delivery_payload');
  }
  let payload: unknown;
  try {
    payload = row.delivery_payload == null ? {} : JSON.parse(row.delivery_payload);
  } catch {
    throw new Error('corrupt_delivery_payload');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('corrupt_delivery_payload');
  }
  const record = payload as Record<string, unknown>;
  if (kind === 'claude-channel') {
    const csid = record.channel_session_id;
    if (typeof csid !== 'string' || csid.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    return { kind: 'claude-channel', channel_session_id: csid };
  }
  if (kind === 'codex-appserver') {
    const threadId = record.thread_id;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    const wsUrl = record.ws_url;
    if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    const hasAuthTokenRef = Object.prototype.hasOwnProperty.call(record, 'auth_token_ref');
    if (hasAuthTokenRef) {
      const authTokenRef = record.auth_token_ref;
      if (typeof authTokenRef !== 'string' || authTokenRef.length === 0) {
        throw new Error('corrupt_delivery_payload');
      }
      return {
        kind: 'codex-appserver',
        thread_id: threadId,
        ws_url: wsUrl,
        auth_token_ref: authTokenRef,
      };
    }
    return { kind: 'codex-appserver', thread_id: threadId, ws_url: wsUrl };
  }
  if (kind === 'opencode-server') {
    const sessionId = record.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !sessionId.startsWith('ses')) {
      throw new Error('corrupt_delivery_payload');
    }
    const baseUrl = record.base_url;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    const hasRuntimeGeneration = Object.prototype.hasOwnProperty.call(
      record,
      'runtime_generation',
    );
    const runtimeGeneration = record.runtime_generation;
    if (hasRuntimeGeneration && (
      typeof runtimeGeneration !== 'number'
      || !Number.isSafeInteger(runtimeGeneration)
      || runtimeGeneration < 0
    )) {
      throw new Error('corrupt_delivery_payload');
    }
    const hasAuthTokenRef = Object.prototype.hasOwnProperty.call(record, 'auth_token_ref');
    if (hasAuthTokenRef) {
      const authTokenRef = record.auth_token_ref;
      if (typeof authTokenRef !== 'string' || authTokenRef.length === 0) {
        throw new Error('corrupt_delivery_payload');
      }
      return {
        kind: 'opencode-server',
        session_id: sessionId,
        base_url: baseUrl,
        auth_token_ref: authTokenRef,
        ...(hasRuntimeGeneration
          ? { runtime_generation: runtimeGeneration as number }
          : {}),
      };
    }
    return {
      kind: 'opencode-server',
      session_id: sessionId,
      base_url: baseUrl,
      ...(hasRuntimeGeneration
        ? { runtime_generation: runtimeGeneration as number }
        : {}),
    };
  }
  if (kind === 'kimi-server') {
    const sessionId = record.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    const baseUrl = record.base_url;
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error('corrupt_delivery_payload');
    }
    const hasAuthTokenRef = Object.prototype.hasOwnProperty.call(record, 'auth_token_ref');
    if (hasAuthTokenRef) {
      const authTokenRef = record.auth_token_ref;
      if (typeof authTokenRef !== 'string' || authTokenRef.length === 0) {
        throw new Error('corrupt_delivery_payload');
      }
      return {
        kind: 'kimi-server',
        session_id: sessionId,
        base_url: baseUrl,
        auth_token_ref: authTokenRef,
      };
    }
    return { kind: 'kimi-server', session_id: sessionId, base_url: baseUrl };
  }
  throw new Error('corrupt_delivery_payload');
}

export function serializeDelivery(spec: DeliverySpec): DeliveryRow {
  if (spec.kind === 'none') {
    return { delivery_kind: 'none', delivery_payload: null };
  }
  const { kind, ...rest } = spec;
  return {
    delivery_kind: kind,
    delivery_payload: JSON.stringify(rest),
  };
}

export type DeliveryValidationReason =
  | 'unknown_kind'
  | 'missing_channel_session_id'
  | 'invalid_thread_id'
  | 'invalid_ws_url'
  | 'invalid_auth_token_ref'
  | 'invalid_runtime_generation'
  | 'invalid_session_id'
  | 'invalid_base_url';

export type ValidateDeliveryResult =
  | { ok: DeliverySpec }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readTrimmedString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

export function validateDeliveryForWrite(input: unknown): ValidateDeliveryResult {
  if (typeof input !== 'object' || input === null) {
    return { error: 'invalid_delivery', reason: 'unknown_kind' };
  }
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'none') {
    return { ok: { kind: 'none' } };
  }
  if (kind === 'claude-channel') {
    const csid = readTrimmedString(record, 'channel_session_id');
    if (csid === undefined || csid.length === 0) {
      return { error: 'invalid_delivery', reason: 'missing_channel_session_id' };
    }
    return { ok: { kind: 'claude-channel', channel_session_id: csid } };
  }
  if (kind === 'codex-appserver') {
    const threadId = readTrimmedString(record, 'thread_id');
    if (threadId === undefined || threadId.length === 0 || !UUID_RE.test(threadId)) {
      return { error: 'invalid_delivery', reason: 'invalid_thread_id' };
    }

    const wsUrl = readTrimmedString(record, 'ws_url');
    if (wsUrl === undefined || wsUrl.length === 0) {
      return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
    }
    try {
      const parsed = new URL(wsUrl);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
      }
    } catch {
      return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
    }

    const authTokenRef = readTrimmedString(record, 'auth_token_ref');
    if (authTokenRef === '') {
      return { error: 'invalid_delivery', reason: 'invalid_auth_token_ref' };
    }

    return {
      ok: {
        kind: 'codex-appserver',
        thread_id: threadId,
        ws_url: wsUrl,
        ...(authTokenRef === undefined ? {} : { auth_token_ref: authTokenRef }),
      },
    };
  }
  if (kind === 'opencode-server') {
    const sessionId = readTrimmedString(record, 'session_id');
    if (sessionId === undefined || sessionId.length === 0 || !sessionId.startsWith('ses')) {
      return { error: 'invalid_delivery', reason: 'invalid_session_id' };
    }

    const baseUrl = readTrimmedString(record, 'base_url');
    if (baseUrl === undefined || baseUrl.length === 0) {
      return { error: 'invalid_delivery', reason: 'invalid_base_url' };
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'invalid_delivery', reason: 'invalid_base_url' };
      }
    } catch {
      return { error: 'invalid_delivery', reason: 'invalid_base_url' };
    }

    const authTokenRef = readTrimmedString(record, 'auth_token_ref');
    if (authTokenRef === '') {
      return { error: 'invalid_delivery', reason: 'invalid_auth_token_ref' };
    }
    const hasRuntimeGeneration = Object.prototype.hasOwnProperty.call(
      record,
      'runtime_generation',
    );
    const runtimeGeneration = record.runtime_generation;
    if (hasRuntimeGeneration && (
      typeof runtimeGeneration !== 'number'
      || !Number.isSafeInteger(runtimeGeneration)
      || runtimeGeneration < 0
    )) {
      return { error: 'invalid_delivery', reason: 'invalid_runtime_generation' };
    }

    return {
      ok: {
        kind: 'opencode-server',
        session_id: sessionId,
        base_url: baseUrl,
        ...(hasRuntimeGeneration
          ? { runtime_generation: runtimeGeneration as number }
          : {}),
        ...(authTokenRef === undefined ? {} : { auth_token_ref: authTokenRef }),
      },
    };
  }
  if (kind === 'kimi-server') {
    const sessionId = readTrimmedString(record, 'session_id');
    if (sessionId === undefined || sessionId.length === 0) {
      return { error: 'invalid_delivery', reason: 'invalid_session_id' };
    }

    const baseUrl = readTrimmedString(record, 'base_url');
    if (baseUrl === undefined || baseUrl.length === 0) {
      return { error: 'invalid_delivery', reason: 'invalid_base_url' };
    }
    // The persistence boundary enforces the same URL invariant as the tool
    // schemas: a delivery-object register (e.g. agent_type=custom) must not
    // be able to store a kimi base_url no endpoint can be built from.
    if (kimiBaseUrlIssue(baseUrl) !== undefined) {
      return { error: 'invalid_delivery', reason: 'invalid_base_url' };
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'invalid_delivery', reason: 'invalid_base_url' };
      }
    } catch {
      return { error: 'invalid_delivery', reason: 'invalid_base_url' };
    }

    const authTokenRef = readTrimmedString(record, 'auth_token_ref');
    if (authTokenRef === '') {
      return { error: 'invalid_delivery', reason: 'invalid_auth_token_ref' };
    }

    return {
      ok: {
        kind: 'kimi-server',
        session_id: sessionId,
        base_url: baseUrl,
        ...(authTokenRef === undefined ? {} : { auth_token_ref: authTokenRef }),
      },
    };
  }
  return { error: 'invalid_delivery', reason: 'unknown_kind' };
}
