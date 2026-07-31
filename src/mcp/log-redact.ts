/**
 * Render an error as `<class>: <message>` for log lines, replacing every
 * occurrence of the in-scope identity_key value with `[redacted]` so a thrown
 * error can never leak the key into logs.  The full string is composed FIRST
 * and redacted as a whole: the key may hide in the class name too (a custom
 * `Error.name` embedding the key, or a key that literally equals "Error").
 */
export function describeRedactedError(
  error: unknown,
  redactValue?: string | null
): string {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  const full = `${name}: ${message}`
  return redactValue ? full.replaceAll(redactValue, '[redacted]') : full
}
