import { describe, it, expectTypeOf, expect } from 'vitest';
import type { DeliverySpec } from '../src/lib/delivery-spec.js';
import * as deliverySpecModule from '../src/lib/delivery-spec.js';
import {
  parseDeliveryRow,
  serializeDelivery,
  validateDeliveryForWrite,
} from '../src/lib/delivery-spec.js';

describe('DeliverySpec discriminated union shape', () => {
  it('module loads from src/lib/delivery-spec', () => {
    expect(deliverySpecModule).toBeDefined();
  });

  it('accepts kind none with no payload fields', () => {
    const spec: DeliverySpec = { kind: 'none' };
    expect(spec.kind).toBe('none');
    expectTypeOf(spec).toExtend<{ kind: 'none' }>();
  });

  it('accepts kind claude-channel with channel_session_id', () => {
    const spec: DeliverySpec = {
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    };
    expect(spec.kind).toBe('claude-channel');
    if (spec.kind === 'claude-channel') {
      expectTypeOf(spec.channel_session_id).toEqualTypeOf<string>();
    }
  });

  it('accepts kind codex-appserver with thread_id, ws_url, optional auth_token_ref', () => {
    const specWithout: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    };
    const specWith: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    };
    expect(specWithout.kind).toBe('codex-appserver');
    expect(specWith.kind).toBe('codex-appserver');
    if (specWith.kind === 'codex-appserver') {
      expectTypeOf(specWith.thread_id).toEqualTypeOf<string>();
      expectTypeOf(specWith.ws_url).toEqualTypeOf<string>();
    }
  });

  it('accepts kind opencode-server with session_id, base_url, optional auth_token_ref', () => {
    const specWithout: DeliverySpec = {
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
    };
    const specWith: DeliverySpec = {
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'https://example.com',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    };
    expect(specWithout.kind).toBe('opencode-server');
    expect(specWith.kind).toBe('opencode-server');
    if (specWith.kind === 'opencode-server') {
      expectTypeOf(specWith.session_id).toEqualTypeOf<string>();
      expectTypeOf(specWith.base_url).toEqualTypeOf<string>();
    }
  });

  it('narrows kind via discriminated field', () => {
    const describe = (spec: DeliverySpec): string => {
      if (spec.kind === 'none') return 'none';
      if (spec.kind === 'claude-channel') return spec.channel_session_id;
      if (spec.kind === 'codex-appserver') return spec.thread_id;
      return spec.session_id;
    };
    expect(describe({ kind: 'none' })).toBe('none');
    expect(describe({ kind: 'claude-channel', channel_session_id: 'csid-xyz' })).toBe('csid-xyz');
    expect(
      describe({
        kind: 'codex-appserver',
        thread_id: '00000000-0000-0000-0000-000000000000',
        ws_url: 'ws://x',
      }),
    ).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('parseDeliveryRow (Task 1.2)', () => {
  it('kind none row with null payload returns {kind: none}', () => {
    const row = { delivery_kind: 'none', delivery_payload: null };
    expect(parseDeliveryRow(row)).toEqual({ kind: 'none' });
  });

  it('kind claude-channel row reconstructs channel_session_id from JSON payload', () => {
    const row = {
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":"csid-abc"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    });
  });

  it('throws corrupt_delivery_payload when non-none payload fails to parse as JSON', () => {
    const row = { delivery_kind: 'claude-channel', delivery_payload: 'not-json' };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });
});

describe('parseDeliveryRow read-side validation (harden-delivery-read-path)', () => {
  it('throws corrupt_delivery_payload when delivery_kind is unknown', () => {
    const row = { delivery_kind: 'irc', delivery_payload: '{}' };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for claude-channel with empty payload {}', () => {
    const row = { delivery_kind: 'claude-channel', delivery_payload: '{}' };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for claude-channel with empty channel_session_id', () => {
    const row = {
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":""}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for codex-appserver missing thread_id', () => {
    const row = {
      delivery_kind: 'codex-appserver',
      delivery_payload: '{"ws_url":"ws://127.0.0.1:8799"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for codex-appserver missing ws_url', () => {
    const row = {
      delivery_kind: 'codex-appserver',
      delivery_payload:
        '{"thread_id":"11111111-1111-4111-8111-111111111111"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for codex-appserver with empty auth_token_ref', () => {
    const row = {
      delivery_kind: 'codex-appserver',
      delivery_payload:
        '{"thread_id":"11111111-1111-4111-8111-111111111111","ws_url":"ws://127.0.0.1:8799","auth_token_ref":""}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('reconstructs codex-appserver with full payload including auth_token_ref', () => {
    const row = {
      delivery_kind: 'codex-appserver',
      delivery_payload:
        '{"thread_id":"11111111-1111-4111-8111-111111111111","ws_url":"wss://example/app","auth_token_ref":"env:TOKEN"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'wss://example/app',
      auth_token_ref: 'env:TOKEN',
    });
  });

  it('reconstructs codex-appserver without auth_token_ref omits the optional key', () => {
    const row = {
      delivery_kind: 'codex-appserver',
      delivery_payload:
        '{"thread_id":"22222222-2222-2222-2222-222222222222","ws_url":"ws://127.0.0.1:8799"}',
    };
    const spec = parseDeliveryRow(row);
    expect(spec).toEqual({
      kind: 'codex-appserver',
      thread_id: '22222222-2222-2222-2222-222222222222',
      ws_url: 'ws://127.0.0.1:8799',
    });
    expect(Object.prototype.hasOwnProperty.call(spec, 'auth_token_ref')).toBe(false);
  });

  it('throws corrupt_delivery_payload for opencode-server missing session_id', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload: '{"base_url":"http://127.0.0.1:18888"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for opencode-server with session_id not starting ses', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload: '{"session_id":"abc","base_url":"http://127.0.0.1:18888"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for opencode-server missing base_url', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload: '{"session_id":"ses_abc"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for opencode-server with empty auth_token_ref', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload:
        '{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888","auth_token_ref":""}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('reconstructs opencode-server with full payload including auth_token_ref', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload:
        '{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888","auth_token_ref":"OPENCODE_SERVER_PASSWORD"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    });
  });

  it('reconstructs opencode-server without auth_token_ref omits the optional key', () => {
    const row = {
      delivery_kind: 'opencode-server',
      delivery_payload:
        '{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}',
    };
    const spec = parseDeliveryRow(row);
    expect(spec).toEqual({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
    });
    expect(Object.prototype.hasOwnProperty.call(spec, 'auth_token_ref')).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(spec, 'runtime_generation'),
    ).toBe(false);
    if (spec.kind === 'opencode-server') {
      expect(spec.runtime_generation ?? 0).toBe(0);
    }
  });

  it('does not leak extra payload fields through the spread for claude-channel', () => {
    const row = {
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":"csid-abc","leak":"should-not-appear"}',
    };
    const spec = parseDeliveryRow(row);
    expect(spec).toEqual({ kind: 'claude-channel', channel_session_id: 'csid-abc' });
    expect(Object.prototype.hasOwnProperty.call(spec, 'leak')).toBe(false);
  });
});

describe('serializeDelivery (Task 1.3)', () => {
  it('serializes {kind: none} to {delivery_kind: none, delivery_payload: null}', () => {
    const spec: DeliverySpec = { kind: 'none' };
    expect(serializeDelivery(spec)).toEqual({
      delivery_kind: 'none',
      delivery_payload: null,
    });
  });

  it('serializes claude-channel to JSON string payload with channel_session_id', () => {
    const spec: DeliverySpec = {
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    };
    expect(serializeDelivery(spec)).toEqual({
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":"csid-abc"}',
    });
  });

  it('serializes codex-appserver to JSON payload with thread_id and ws_url', () => {
    const spec: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    };
    const result = serializeDelivery(spec);
    expect(result.delivery_kind).toBe('codex-appserver');
    expect(result.delivery_payload).not.toBeNull();
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    });
  });

  it('serializes codex-appserver with optional auth_token_ref when present', () => {
    const spec: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    };
    const result = serializeDelivery(spec);
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    });
  });

  it('serializes opencode-server to JSON payload with session_id and base_url', () => {
    const spec: DeliverySpec = {
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
    };
    const result = serializeDelivery(spec);
    expect(result.delivery_kind).toBe('opencode-server');
    expect(result.delivery_payload).toBe('{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}');
  });

  it('serializes opencode-server with optional auth_token_ref when present', () => {
    const spec: DeliverySpec = {
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    };
    const result = serializeDelivery(spec);
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    });
  });

  it('roundtrips parseDeliveryRow(serializeDelivery(spec)) === spec for each kind', () => {
    const specs: DeliverySpec[] = [
      { kind: 'none' },
      { kind: 'claude-channel', channel_session_id: 'csid-xyz' },
      {
        kind: 'codex-appserver',
        thread_id: '00000000-0000-0000-0000-000000000000',
        ws_url: 'ws://x',
      },
      {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-1111-1111-111111111111',
        ws_url: 'wss://y',
        auth_token_ref: 'env:FOO',
      },
      {
        kind: 'opencode-server',
        session_id: 'ses_a',
        base_url: 'http://127.0.0.1:18888',
      },
      {
        kind: 'opencode-server',
        session_id: 'ses_b',
        base_url: 'https://example.com',
        auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
      },
      {
        kind: 'kimi-server',
        session_id: 'session_a',
        base_url: 'http://127.0.0.1:58627',
      },
      {
        kind: 'kimi-server',
        session_id: 'session_b',
        base_url: 'https://example.com',
        auth_token_ref: 'KIMI_SERVER_TOKEN',
      },
    ];
    for (const spec of specs) {
      expect(parseDeliveryRow(serializeDelivery(spec))).toEqual(spec);
    }
  });
});

describe('validateDeliveryForWrite (Task 1.4)', () => {
  it('accepts {kind: none}', () => {
    const result = validateDeliveryForWrite({ kind: 'none' });
    expect(result).toEqual({ ok: { kind: 'none' } });
  });

  it('rejects kimi-server base_url carrying query, fragment, userinfo, or a bare "?"', () => {
    for (const base_url of [
      'http://127.0.0.1:58627/?a=1',
      'http://127.0.0.1:58627/#frag',
      'http://user:pw@127.0.0.1:58627',
      'http://127.0.0.1:58627/?',
      'http://127.0.0.1:58627/?#',
    ]) {
      expect(
        validateDeliveryForWrite({
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url,
        }),
        `base_url=${base_url} should be rejected`
      ).toEqual({ error: 'invalid_delivery', reason: 'invalid_base_url' });
    }
  });

  it('accepts {kind: claude-channel, channel_session_id: ...}', () => {
    const result = validateDeliveryForWrite({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    });
    expect(result).toEqual({
      ok: { kind: 'claude-channel', channel_session_id: 'csid-abc' },
    });
  });

  it('accepts {kind: codex-appserver, thread_id, ws_url, auth_token_ref?}', () => {
    const result = validateDeliveryForWrite({
      kind: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      auth_token_ref: 'CODEX_REMOTE_TOKEN',
    });
    expect(result).toEqual({
      ok: {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
        auth_token_ref: 'CODEX_REMOTE_TOKEN',
      },
    });
  });

  it('rejects unknown kind with reason unknown_kind', () => {
    const result = validateDeliveryForWrite({ kind: 'irc' });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'unknown_kind',
    });
  });

  it('rejects claude-channel missing channel_session_id with reason missing_channel_session_id', () => {
    const result = validateDeliveryForWrite({ kind: 'claude-channel' });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'missing_channel_session_id',
    });
  });

  it('rejects codex-appserver with invalid thread_id', () => {
    const result = validateDeliveryForWrite({
      kind: 'codex-appserver',
      thread_id: 'not-a-uuid',
      ws_url: 'ws://127.0.0.1:8799',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_thread_id',
    });
  });

  it('rejects codex-appserver with invalid ws_url', () => {
    const result = validateDeliveryForWrite({
      kind: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'http://127.0.0.1:8799',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_ws_url',
    });
  });

  it('rejects codex-appserver with blank auth_token_ref', () => {
    const result = validateDeliveryForWrite({
      kind: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      auth_token_ref: '   ',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_auth_token_ref',
    });
  });

  it('accepts kind opencode-server with valid session_id, base_url, optional auth_token_ref', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
      auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
    });
    expect(result).toEqual({
      ok: {
        kind: 'opencode-server',
        session_id: 'ses_abc',
        base_url: 'http://127.0.0.1:18888',
        auth_token_ref: 'OPENCODE_SERVER_PASSWORD',
      },
    });
  });

  it('rejects opencode-server with session_id not starting ses', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: 'abc',
      base_url: 'http://127.0.0.1:18888',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_session_id',
    });
  });

  it('rejects opencode-server with empty session_id', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: '',
      base_url: 'http://127.0.0.1:18888',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_session_id',
    });
  });

  it('rejects opencode-server with non-parseable base_url', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'not-a-url',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_base_url',
    });
  });

  it('rejects opencode-server with ws:// base_url (protocol mismatch)', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'ws://127.0.0.1:18888',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_base_url',
    });
  });

  it('rejects opencode-server with blank auth_token_ref', () => {
    const result = validateDeliveryForWrite({
      kind: 'opencode-server',
      session_id: 'ses_abc',
      base_url: 'http://127.0.0.1:18888',
      auth_token_ref: '   ',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_auth_token_ref',
    });
  });
});

describe('Task 1.5 scenario coverage audit (agent-delivery/spec.md)', () => {
  describe('Requirement: persistence maps to two columns', () => {
    it('scenario: writing kind none sets payload to NULL', () => {
      expect(serializeDelivery({ kind: 'none' })).toEqual({
        delivery_kind: 'none',
        delivery_payload: null,
      });
    });

    it('scenario: writing kind claude-channel serializes channel_session_id into payload', () => {
      expect(
        serializeDelivery({ kind: 'claude-channel', channel_session_id: 'csid-abc' }),
      ).toEqual({
        delivery_kind: 'claude-channel',
        delivery_payload: '{"channel_session_id":"csid-abc"}',
      });
    });

    it('scenario: reading back kind none row reconstructs {kind:none}', () => {
      expect(parseDeliveryRow({ delivery_kind: 'none', delivery_payload: null })).toEqual({
        kind: 'none',
      });
    });

    it('scenario: reading back kind claude-channel row reconstructs spec', () => {
      expect(
        parseDeliveryRow({
          delivery_kind: 'claude-channel',
          delivery_payload: '{"channel_session_id":"csid-abc"}',
        }),
      ).toEqual({ kind: 'claude-channel', channel_session_id: 'csid-abc' });
    });

    it('scenario: non-none row with unparseable payload fails with corrupt_delivery_payload', () => {
      expect(() =>
        parseDeliveryRow({ delivery_kind: 'claude-channel', delivery_payload: 'not-json' }),
      ).toThrow('corrupt_delivery_payload');
    });

    it('roundtrip: parse(serialize(spec)) is identity for every kind', () => {
      const specs: DeliverySpec[] = [
        { kind: 'none' },
        { kind: 'claude-channel', channel_session_id: 'csid-roundtrip' },
        {
          kind: 'codex-appserver',
          thread_id: '22222222-2222-2222-2222-222222222222',
          ws_url: 'ws://roundtrip',
        },
        {
          kind: 'codex-appserver',
          thread_id: '33333333-3333-3333-3333-333333333333',
          ws_url: 'wss://roundtrip',
          auth_token_ref: 'env:RT',
        },
      ];
      for (const spec of specs) {
        expect(parseDeliveryRow(serializeDelivery(spec))).toEqual(spec);
      }
    });
  });

  describe('Requirement: validation rejects unknown kinds at write time', () => {
    it('scenario: accepts kind none', () => {
      expect(validateDeliveryForWrite({ kind: 'none' })).toEqual({ ok: { kind: 'none' } });
    });

    it('scenario: accepts kind claude-channel with valid channel_session_id', () => {
      expect(
        validateDeliveryForWrite({ kind: 'claude-channel', channel_session_id: 'csid-ok' }),
      ).toEqual({ ok: { kind: 'claude-channel', channel_session_id: 'csid-ok' } });
    });

    it('scenario: accepts kind codex-appserver with valid thread_id and ws_url', () => {
      expect(
        validateDeliveryForWrite({
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'ws://127.0.0.1:8799',
          auth_token_ref: 'CODEX_REMOTE_TOKEN',
        }),
      ).toEqual({
        ok: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'ws://127.0.0.1:8799',
          auth_token_ref: 'CODEX_REMOTE_TOKEN',
        },
      });
    });

    it('scenario: rejects unknown kind irc with reason unknown_kind', () => {
      expect(validateDeliveryForWrite({ kind: 'irc' })).toEqual({
        error: 'invalid_delivery',
        reason: 'unknown_kind',
      });
    });

    it('scenario: rejects claude-channel missing channel_session_id', () => {
      expect(validateDeliveryForWrite({ kind: 'claude-channel' })).toEqual({
        error: 'invalid_delivery',
        reason: 'missing_channel_session_id',
      });
    });

    it('scenario: rejects kind codex-appserver with invalid thread_id', () => {
      expect(
        validateDeliveryForWrite({
          kind: 'codex-appserver',
          thread_id: 'thread-1',
          ws_url: 'ws://127.0.0.1:8799',
        }),
      ).toEqual({ error: 'invalid_delivery', reason: 'invalid_thread_id' });
    });

    it('scenario: rejects kind codex-appserver with invalid ws_url', () => {
      expect(
        validateDeliveryForWrite({
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'http://127.0.0.1:8799',
        }),
      ).toEqual({ error: 'invalid_delivery', reason: 'invalid_ws_url' });
    });

    it('scenario: rejects kind codex-appserver with blank auth_token_ref', () => {
      expect(
        validateDeliveryForWrite({
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'ws://127.0.0.1:8799',
          auth_token_ref: '   ',
        }),
      ).toEqual({ error: 'invalid_delivery', reason: 'invalid_auth_token_ref' });
    });
  });
});

describe('kimi-server delivery kind (add-kimi-code-poke)', () => {
  it('accepts kind kimi-server with session_id, base_url, optional auth_token_ref', () => {
    const specWithout: DeliverySpec = {
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
    };
    const specWith: DeliverySpec = {
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'https://example.com',
      auth_token_ref: 'KIMI_SERVER_TOKEN',
    };
    expect(specWithout.kind).toBe('kimi-server');
    expect(specWith.kind).toBe('kimi-server');
    if (specWith.kind === 'kimi-server') {
      expectTypeOf(specWith.session_id).toEqualTypeOf<string>();
      expectTypeOf(specWith.base_url).toEqualTypeOf<string>();
    }
  });

  it('reconstructs kimi-server row with full payload including auth_token_ref', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload:
        '{"session_id":"session_abc","base_url":"http://127.0.0.1:58627","auth_token_ref":"KIMI_SERVER_TOKEN"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
      auth_token_ref: 'KIMI_SERVER_TOKEN',
    });
  });

  it('reconstructs kimi-server row without auth_token_ref omits the optional key', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload: '{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}',
    };
    const spec = parseDeliveryRow(row);
    expect(spec).toEqual({
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
    });
    expect(Object.prototype.hasOwnProperty.call(spec, 'auth_token_ref')).toBe(false);
  });

  it('accepts a kimi-server session_id without any prefix constraint', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload: '{"session_id":"01JXYZABC","base_url":"http://127.0.0.1:58627"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'kimi-server',
      session_id: '01JXYZABC',
      base_url: 'http://127.0.0.1:58627',
    });
  });

  it('throws corrupt_delivery_payload for kimi-server missing session_id', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload: '{"base_url":"http://127.0.0.1:58627"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for kimi-server missing base_url', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload: '{"session_id":"session_abc"}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('throws corrupt_delivery_payload for kimi-server with empty auth_token_ref', () => {
    const row = {
      delivery_kind: 'kimi-server',
      delivery_payload:
        '{"session_id":"session_abc","base_url":"http://127.0.0.1:58627","auth_token_ref":""}',
    };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });

  it('serializes kimi-server to JSON payload with session_id and base_url', () => {
    const spec: DeliverySpec = {
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
    };
    expect(serializeDelivery(spec)).toEqual({
      delivery_kind: 'kimi-server',
      delivery_payload: '{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}',
    });
  });

  it('serializes kimi-server with optional auth_token_ref when present', () => {
    const spec: DeliverySpec = {
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
      auth_token_ref: 'KIMI_SERVER_TOKEN',
    };
    const result = serializeDelivery(spec);
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
      auth_token_ref: 'KIMI_SERVER_TOKEN',
    });
  });

  it('accepts kind kimi-server with valid session_id, base_url, optional auth_token_ref', () => {
    const result = validateDeliveryForWrite({
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
      auth_token_ref: 'KIMI_SERVER_TOKEN',
    });
    expect(result).toEqual({
      ok: {
        kind: 'kimi-server',
        session_id: 'session_abc',
        base_url: 'http://127.0.0.1:58627',
        auth_token_ref: 'KIMI_SERVER_TOKEN',
      },
    });
  });

  it('accepts kind kimi-server with a session_id that has no prefix constraint', () => {
    const result = validateDeliveryForWrite({
      kind: 'kimi-server',
      session_id: '01JXYZABC',
      base_url: 'http://127.0.0.1:58627',
    });
    expect(result).toEqual({
      ok: {
        kind: 'kimi-server',
        session_id: '01JXYZABC',
        base_url: 'http://127.0.0.1:58627',
      },
    });
  });

  it('rejects kimi-server with empty session_id', () => {
    const result = validateDeliveryForWrite({
      kind: 'kimi-server',
      session_id: '',
      base_url: 'http://127.0.0.1:58627',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_session_id',
    });
  });

  it('rejects kimi-server with ws:// base_url (protocol mismatch)', () => {
    const result = validateDeliveryForWrite({
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'ws://127.0.0.1:58627',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_base_url',
    });
  });

  it('rejects kimi-server with blank auth_token_ref', () => {
    const result = validateDeliveryForWrite({
      kind: 'kimi-server',
      session_id: 'session_abc',
      base_url: 'http://127.0.0.1:58627',
      auth_token_ref: '   ',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'invalid_auth_token_ref',
    });
  });
});
