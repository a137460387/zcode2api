import { describe, it, expect, vi } from 'vitest'
import { ParamPool, ParamPoolEmpty } from '../src/captcha/pool.js'

function fakeClock() {
  const state = { t: 1000 }
  return { now: () => state.t, advance: (ms) => { state.t += ms } }
}

describe('ParamPool', () => {
  it('push and takeSync respect FIFO and TTL', () => {
    const { now, advance } = fakeClock()
    const pool = new ParamPool({ ttlMs: 8000, now })
    pool.push('P1')
    pool.push('P2')
    expect(pool.takeSync()).toBe('P1')
    expect(pool.takeSync()).toBe('P2')
    expect(pool.takeSync()).toBeNull()
    pool.push('P3')
    advance(9000)
    expect(pool.takeSync()).toBeNull() // expired
    expect(pool.status().pool).toBe(0)
  })

  it('take waits until a param arrives', async () => {
    const { now } = fakeClock()
    const pool = new ParamPool({ now, sleep: () => Promise.resolve() })
    setTimeout(() => pool.push('LATE'), 5)
    const p = await pool.take({ waitMs: 500 })
    expect(p).toBe('LATE')
  })

  it('take throws ParamPoolEmpty after waitMs', async () => {
    const pool = new ParamPool({ sleep: () => Promise.resolve() })
    await expect(pool.take({ waitMs: 10 })).rejects.toThrow(ParamPoolEmpty)
  })

  it('caps the pool at maxSize', () => {
    const { now } = fakeClock()
    const pool = new ParamPool({ maxSize: 2, now })
    pool.push('1'); pool.push('2'); pool.push('3')
    expect(pool.status().pool).toBe(2)
  })
})
