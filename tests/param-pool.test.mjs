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

describe('ParamPool 配置健壮性', () => {
  // maxSize 为负数曾让 push() 的淘汰循环永不退出（对空数组 shift() 恒返回 undefined），
  // 同步死循环会阻塞事件循环、挂死整个进程。用超时守卫确保此测试本身不会挂住。
  it('negative or invalid maxSize is clamped instead of hanging push()', async () => {
    const enc = () => new Promise((r) => setTimeout(() => r('TIMEOUT'), 1000))
    const run = async () => {
      const p = new ParamPool({ maxSize: -1 })
      p.push('a')
      p.push('b')
      return `pool=${p.status().pool}`
    }
    const r = await Promise.race([run(), enc()])
    expect(r).not.toBe('TIMEOUT')
    expect(r).toBe('pool=0')

    // NaN / undefined / 小数也被规范为合法整数
    const p2 = new ParamPool({ maxSize: NaN })
    p2.push('x')
    expect(p2.status().pool).toBe(0)
    const p3 = new ParamPool({ maxSize: 2.7 })
    p3.push('1'); p3.push('2'); p3.push('3')
    expect(p3.status().pool).toBe(2)
  })

  it('maxSize 0 means the pool never retains params', () => {
    const p = new ParamPool({ maxSize: 0 })
    p.push('x')
    expect(p.takeSync()).toBeNull()
    expect(p.status().received).toBe(1)
  })
})

// 农场页按"新鲜度"补充参数（不只按数量）——此前提按数量时，池满即停产出，
// 池里参数逐秒变陈，取到陈参数会被上游判 3007。故 status() 需暴露最新参数年龄。
describe('ParamPool.status 暴露参数新鲜度', () => {
  it('空池时 newestAgeMs 为 null', () => {
    const p = new ParamPool({})
    expect(p.status().newestAgeMs).toBeNull()
  })

  it('newestAgeMs 反映"最新"那个参数的年龄（不是最旧的）', () => {
    let t = 1000
    const p = new ParamPool({ ttlMs: 600000, maxSize: 6, now: () => t })
    p.push('OLD')
    t += 30000
    p.push('NEW')
    expect(p.status().newestAgeMs).toBe(0)  // 刚推入的
    t += 5000
    expect(p.status().newestAgeMs).toBe(5000)
  })

  it('取走最新参数后，newestAgeMs 退回到剩下的最新者', () => {
    let t = 1000
    // usableMs 显式放大到与 ttl 同量级：本用例只关心 newestAgeMs 的算法，
    // 而两次 push 之间隔了 40s，默认 usableMs=40s 会把先推的那个判为过时效并丢弃
    // （那是另一条规则，由下面的用例单独覆盖）。
    const p = new ParamPool({ ttlMs: 600000, maxSize: 6, usableMs: 600000, now: () => t })
    p.push('A')
    t += 40000
    p.push('B')
    expect(p.status().newestAgeMs).toBe(0)
    p.takeSync() // 取走 A（FIFO）
    expect(p.status().newestAgeMs).toBe(0) // B 仍是 0 龄
    t += 10000
    expect(p.status().newestAgeMs).toBe(10000)
  })
})

/**
 * 参数"可用时效"（usableMs）：过时效的参数**不再递给上游**。
 *
 * 实测教训：池里 4 个陈参数时，一次请求把初次 + 2 次重试全打在陈参数上，
 * 全部换回 3007，客户端拿到 400。与其递出去换一个错误，不如在池里就丢掉。
 */
describe('ParamPool：过时效的参数被丢弃而不是递给上游', () => {
  it('超过 usableMs 的参数在 takeSync 时被丢弃并计数', () => {
    let clock = 1_000_000
    const pool = new ParamPool({ usableMs: 40_000, now: () => clock })
    pool.push('fresh-1')
    clock += 45_000
    pool.push('fresh-2')
    clock += 1_000
    // 队首的 fresh-1 已 46s（>40s），应被丢掉；拿到的是 1s 前的 fresh-2
    expect(pool.takeSync()).toBe('fresh-2')
    expect(pool.discarded).toBe(1)
    expect(pool.takeSync()).toBeNull()
  })

  it('status 同时给出 pool 与 usable（池满但全陈时 usable=0）', () => {
    let clock = 1_000_000
    const pool = new ParamPool({ usableMs: 40_000, now: () => clock })
    for (let i = 0; i < 3; i += 1) pool.push('p' + i)
    expect(pool.status().usable).toBe(3)
    clock += 41_000
    const st = pool.status()
    expect(st.pool).toBe(3)     // 仍在 ttl 内，还占着内存
    expect(st.usable).toBe(0)   // 但一个都不能用——农场据此补货
    expect(st.usableMs).toBe(40_000)
  })

  it('ttl 仍然生效：超过 ttl 的参数连内存都不再保留', () => {
    let clock = 1_000_000
    const pool = new ParamPool({ ttlMs: 60_000, usableMs: 40_000, now: () => clock })
    pool.push('p')
    clock += 61_000
    expect(pool.status().pool).toBe(0)
  })

  it('可用时效内的参数正常取出（不误伤新鲜参数）', () => {
    let clock = 1_000_000
    const pool = new ParamPool({ usableMs: 40_000, now: () => clock })
    pool.push('a'); clock += 10_000
    pool.push('b'); clock += 10_000
    expect(pool.takeSync()).toBe('a')
    expect(pool.takeSync()).toBe('b')
    expect(pool.discarded).toBe(0)
  })

  it('take() 在只剩陈参数时等待新参数而不是把陈的递出去', async () => {
    let clock = 1_000_000
    const pool = new ParamPool({ usableMs: 40_000, now: () => clock, sleep: async () => { clock += 30_000 } })
    pool.push('stale')
    clock += 45_000
    // 第一次 takeSync 丢掉陈参数 → 无参数 → sleep（时钟推进）→ 仍无 → 直到超时
    await expect(pool.take({ waitMs: 5_000 })).rejects.toThrow(/empty/)
    expect(pool.discarded).toBe(1)
  })

  it('usableMs 为 0 时等同于"立刻过期"（显式配置的语义，不是缺陷）', () => {
    const pool = new ParamPool({ usableMs: 0, now: () => 1_000_000 })
    pool.push('p')
    expect(pool.takeSync()).toBeNull()
    expect(pool.discarded).toBe(1)
  })
})
