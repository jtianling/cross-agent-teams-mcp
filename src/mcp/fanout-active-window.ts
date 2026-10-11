export const FANOUT_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Timestamps are written with toISOString(), so the cutoff compares as text.
export function fanoutActiveCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - FANOUT_ACTIVE_WINDOW_MS).toISOString()
}
