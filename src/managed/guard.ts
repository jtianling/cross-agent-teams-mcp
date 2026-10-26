import type Database from 'better-sqlite3'
import type { DeliverySpec } from '../lib/delivery-spec.js'
import { runtimeSchema } from './schema.js'
import { managedDelivery, sameRuntimeAddress } from './coordinates.js'

export function managedDeliveryExists(
  db: Database.Database, device: string, delivery: DeliverySpec | undefined,
): boolean {
  if (!delivery || delivery.kind === 'none') return false
  const rows = db.prepare(
    `SELECT runtime_json FROM managed_claims
     WHERE device = ? AND state = 'bound'`
  ).all(device) as Array<{ runtime_json: string }>
  return rows.some(row => {
    const runtime = runtimeSchema.parse(JSON.parse(row.runtime_json))
    return sameRuntimeAddress(managedDelivery(runtime), delivery)
  })
}

export function managedIdentityExists(
  db: Database.Database,
  input: { device: string; name?: string; team?: string;
    identity_key?: string; agent_id?: string },
): boolean {
  return db.prepare(
    `SELECT 1 FROM managed_claims WHERE device = ? AND state != 'released'
     AND ((name = ? AND team = ?) OR identity_key = ? OR agent_id = ?)`
  ).get(input.device, input.name ?? null, input.team ?? null,
    input.identity_key ?? null, input.agent_id ?? null) !== undefined
}
