import { z } from 'zod'

const label = z.string().trim().min(1).max(256)
const url = z.string().url().refine(value => {
  if (!URL.canParse(value)) return false
  const parsed = new URL(value)
  return ['http:', 'https:'].includes(parsed.protocol)
    && !parsed.username && !parsed.password
    && !value.includes('?') && !value.includes('#')
}, 'Expected an HTTP URL without credentials, query, or fragment')

export const managedAgentType = z.enum([
  'codex', 'claude-code', 'opencode', 'kimi-code',
])
export const fenceSchema = z.object({
  claim_id: z.string().uuid(),
  instance_id: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const control = {
  protocol_version: z.literal(1),
  identity_key: label,
}
export const prepareSchema = z.object({
  ...control,
  name: label.refine(value => !/[:()]/.test(value)),
  team: label.refine(value => !/[()]/.test(value)),
  agent_type: managedAgentType,
  instance_id: z.string().uuid(),
  previous: fenceSchema.optional(),
}).strict()
export const runtimeSchema = z.discriminatedUnion('agent_type', [
  z.object({
    agent_type: z.literal('codex'),
    thread_id: z.string().uuid(),
    ws_url: z.string().url().refine(value => {
      if (!URL.canParse(value)) return false
      const parsed = new URL(value)
      return ['ws:', 'wss:'].includes(parsed.protocol)
        && !parsed.username && !parsed.password
        && !value.includes('?') && !value.includes('#')
    }),
  }).strict(),
  z.object({
    agent_type: z.literal('claude-code'),
    ui_pid: z.number().int().positive(),
    channel_session_id: label,
  }).strict(),
  z.object({
    agent_type: z.literal('opencode'),
    base_url: url,
    session_id: label.refine(value => value.startsWith('ses')),
  }).strict(),
  z.object({
    agent_type: z.literal('kimi-code'),
    base_url: url,
    session_id: label,
  }).strict(),
])
export const controlSchema = z.object({
  ...control, fence: fenceSchema,
}).strict()
export const bindSchema = controlSchema.extend({ runtime: runtimeSchema })
export const statusSchema = controlSchema.extend({
  runtime: runtimeSchema.optional(),
})

export type Fence = z.infer<typeof fenceSchema>
export type PrepareInput = z.infer<typeof prepareSchema>
export type ControlInput = z.infer<typeof controlSchema>
export type BindInput = z.infer<typeof bindSchema>
export type ManagedRuntime = z.infer<typeof runtimeSchema>
export type ManagedAgentType = z.infer<typeof managedAgentType>
