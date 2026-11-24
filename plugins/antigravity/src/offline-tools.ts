import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const offlineTools: Tool[] = [
  {
    name: 'get_inbox',
    description: 'Read unread mail and advance the mailbox cursor.',
    inputSchema: {
      type: 'object', properties: { limit: { type: 'integer' } },
    },
  },
  {
    name: 'send_message',
    description: 'Send a message by recipient name. Supply to_team for cross-team mail.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['to_agent_name', 'body'],
      properties: {
        to_agent_name: { type: 'string', minLength: 1 },
        to_team: { type: 'string', minLength: 1 },
        subject: { type: 'string' }, body: { type: 'string', minLength: 1 },
        auto_poke: { type: 'boolean' }, need_reply: { type: 'boolean' },
        await_ack_s: { type: 'integer', minimum: 0, maximum: 30, default: 10 },
      },
    },
  },
]
