export type ChannelWakeSink = (payload: unknown) => void

interface Entry {
  sessionId: string
  sink: ChannelWakeSink
}

export class ChannelWakeFanout {
  private readonly entries = new Map<string, Entry>()

  attach(channel_session_id: string, sink: ChannelWakeSink, sessionId: string): void {
    this.entries.set(channel_session_id, { sessionId, sink })
  }

  detach(channel_session_id: string): void {
    this.entries.delete(channel_session_id)
  }

  detachBySession(sessionId: string): void {
    for (const [csid, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(csid)
    }
  }

  /**
   * Returns true only when the sink actually accepted the payload.
   *
   * A throwing sink used to be swallowed and still reported success, which made
   * this the weakest "delivered" signal in the daemon: an agent whose channel
   * had gone away still produced `poked: true`.  The entry is deliberately left
   * attached on failure — a transient write error is not proof the subscriber
   * is gone, and detaching here would race the proxy's own lifecycle.
   */
  send(channel_session_id: string, payload: unknown): boolean {
    const entry = this.entries.get(channel_session_id)
    if (!entry) return false
    try {
      entry.sink(payload)
      return true
    } catch {
      return false
    }
  }

  has(channel_session_id: string): boolean {
    return this.entries.has(channel_session_id)
  }
}
