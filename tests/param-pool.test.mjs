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
    const { now, advance } = fakeClock()
    const pool = new ParamPool({ now, sleep: () => Promise.resolve() })
    // brief 原文用真实 setTimeout + 同步推进的假时钟 + 立即 resolve 的 sleep stub：
    // 虚拟时间在真实计时器触发前就冲过 deadline，take 永远抛空，且异步循环会阻塞 vitest。
    // 改为在 take 内部推进假时钟（push 前快进 50ms），语义仍是"参数晚到，take 等到它"。
    const arriving = pool.take({ waitMs: 500 }).then((p) => p)
    await Promise.resolve()
    advance(50)
    pool.push('LATE')
    await expect(arriving).resolves.toBe('LATE')
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
