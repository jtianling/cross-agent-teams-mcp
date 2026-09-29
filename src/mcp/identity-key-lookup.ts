import type Database from 'better-sqlite3'
import { z } from 'zod'
import { AgentsRepo } from '../storage/agents-repo.js'
import { listAgentsForTeam } from './list-agents.js'
import type { PublicAgentListRow } from './agent-public-row.js'

export const identityKeyLookupSchema = z.object({
  protocol_version: z.literal(1),
  identity_key: z.string().min(1).max(256),
}).strict()

type Input = z.infer<typeof identityKeyLookupSchema>
type Holder = {
  team: string
  name: string
  agent_type: PublicAgentListRow['agent_type']
  active: boolean
}
type Result =
  | { ok: false; error: 'not_found' }
  | (Input & { ok: true; holder: Holder })

export class IdentityKeyLookup {
  constructor(
    private readonly db: Database.Database,
    private readonly localDevice: string
  ) {}

  async lookup(input: Input): Promise<Result> {
    const match = new AgentsRepo(this.db)
      .findByIdentityKey(input.identity_key, this.localDevice)[0]
    if (!match) return { ok: false, error: 'not_found' }
    const { agents } = await listAgentsForTeam(
      this.db, match.team, this.localDevice
    )
    const row = agents.find(a => a.agent_id === match.agent_id)
    // The row may have been removed or renamed between the two reads.
    if (!row) return { ok: false, error: 'not_found' }
    return {
      ok: true,
      ...input,
      holder: {
        team: row.team,
        name: row.name,
        agent_type: row.agent_type,
        active: row.online,
      },
    }
  }
}
