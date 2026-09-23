export function createRequestLog({ max = 200 } = {}) {
  const entries = []
  return {
    add(entry) {
      entries.unshift({ ...entry, at: Date.now() })
      if (entries.length > max) entries.length = max
    },
    list(limit = 50) {
      return entries.slice(0, limit)
    },
  }
}
