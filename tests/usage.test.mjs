import { describe, it, expect } from 'vitest'
import { createRequestLog } from '../src/usage.js'

describe('createRequestLog', () => {
  it('keeps newest first and caps size', () => {
    const log = createRequestLog({ max: 3 })
    log.add({ model: 'a' })
    log.add({ model: 'b' })
    log.add({ model: 'c' })
    log.add({ model: 'd' })
    expect(log.list().map((e) => e.model)).toEqual(['d', 'c', 'b'])
    expect(log.list(1)[0].model).toBe('d')
    expect(log.list()[0].at).toBeGreaterThan(0)
  })
})
