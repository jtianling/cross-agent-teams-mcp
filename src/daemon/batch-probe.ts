// A proof can be shared only by callers queued before its probe starts.
export function batchProbe<T, A = string>(
  read: (input: A) => Promise<T>, group: (input: A) => string = String,
) {
  const queued = new Map<string, Promise<T>>()
  return (input: A): Promise<T> => {
    const key = group(input)
    const existing = queued.get(key)
    if (existing) return existing
    const probe = new Promise<T>((resolve, reject) => {
      setImmediate(() => {
        queued.delete(key)
        Promise.resolve().then(() => read(input)).then(resolve, reject)
      })
    })
    queued.set(key, probe)
    return probe
  }
}
