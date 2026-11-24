import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_KINDS, parseDeliveryRow, serializeDelivery, validateDeliveryForWrite,
  type DeliverySpec,
} from '../src/lib/delivery-spec.js';

const kind = 'antigravity-pty';
const launch_id = randomUUID();
const spec = { kind, launch_id } as const;

describe(kind, () => {
  it('round trips only the launch id', () => {
    expect(DELIVERY_KINDS).toContain(kind);
    expect(validateDeliveryForWrite(spec)).toEqual({ ok: spec });
    const row = serializeDelivery(spec);
    expect(row).toEqual({
      delivery_kind: kind, delivery_payload: JSON.stringify({ launch_id }),
    });
    expect(parseDeliveryRow(row)).toEqual(spec);
  });

  it.each([
    {}, { launch_id: null }, { launch_id: '../other' },
    { launch_id: launch_id.slice(0, 14) + '7' + launch_id.slice(15) },
    { launch_id: launch_id.slice(0, 19) + '7' + launch_id.slice(20) },
    { launch_id: launch_id + '\n' },
    { launch_id, url: 'http://localhost' },
    { launch_id, socket_path: '/tmp/other' }, { launch_id, prompt: 'extra' },
  ])('rejects malformed or extended payloads at every boundary', payload => {
    const input = { kind, ...payload };
    expect(validateDeliveryForWrite(input)).toMatchObject({
      error: 'invalid_delivery',
    });
    expect(() => serializeDelivery(input as DeliverySpec)).toThrow();
    expect(() => parseDeliveryRow({
      delivery_kind: kind, delivery_payload: JSON.stringify(payload),
    })).toThrow('corrupt_delivery_payload');
  });

  it('rejects an embedded kind in the stored payload', () => {
    expect(() => parseDeliveryRow({
      delivery_kind: kind, delivery_payload: JSON.stringify(spec),
    })).toThrow('corrupt_delivery_payload');
  });
});
