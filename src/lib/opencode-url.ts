export function canonicalOpencodeBaseUrl(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_base_url')
  }
  if (
    raw.includes('?')
    || raw.includes('#')
    || parsed.username.length > 0
    || parsed.password.length > 0
  ) {
    throw new Error('invalid_base_url')
  }
  return parsed.toString().replace(/\/+$/, '')
}

export function tryCanonicalOpencodeBaseUrl(
  raw: unknown
): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    return canonicalOpencodeBaseUrl(raw)
  } catch {
    return undefined
  }
}
