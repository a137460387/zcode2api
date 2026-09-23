import { describe, it, expect, vi } from 'vitest'
import { createGateway, GatewayError } from '../src/gateway.js'

/**
 * 假账号池，按 T4 的**最终契约**构造（brief 示例里的 fakePool 是旧的 `{account, reason}` 形态，
 * 与 T4 三轮修复后的 `pick` 不符，见下方注释）：
 *
 * `pick(sessionKey)` 三种形态：
 * - `{ account, waitMs }` —— 选中该号；`waitMs` 是**建议节流间隔**（不等待）。
 * - `{ account: null, waitMs: <正数>, reason }` —— 暂时无号（节流窗内/冷却中），
 *   调用方**必须**等 `waitMs` 后重试。这是正常路径。
 * - `{ account: null, waitMs: null, warn: 'human action required', reason }` —— 需人工干预，
 *   调用方**必须**立即失败（按 waitMs 重试会无限循环）。
 *
 * scripts 的每一项是一次 `pick` 的返回值；脚本耗尽后返回"需人工干预"，因此任何
 * 未被网关正确处理的循环都会在这里暴露成 503（而不是测试挂起）。
 */
function fakePool(scripts, { onPick } = {}) {
  let i = 0
  const record = (r) => {
    onPick?.(i, r)
    return r
  }
  return {
    pick: () => {
      const r = i < scripts.length ? scripts[i++] : { account: null, waitMs: null, reason: 'exhausted', warn: 'human action required' }
      return record(r)
    },
    markSuccess: async () => {},
    markError: async (acc, e) => acc.errors.push(e),
  }
}

const acc = (id, type = 'oauth') => ({ id, type, jwt: 'J', apiKey: 'K', stats: {}, errors: [] })
/**
 * 200 响应必须带 `.text()`：网关要解析 body 判 `code`（上游存在"HTTP 200 包业务错误码"的
 * 形态，如 3001/3007/3012/1113），因此真实 200 Response 一定可读体。brief 示例里的
 * `ok = () => ({status: 200})` 没有 `.text()`，与它自己的实现（`res.status === 200` 即成功、
 * 不读体）一致但与实测协议不符——这里按"忠实模拟真实 Response"补齐。
 */
const ok = () => ({ status: 200, text: async () => '{"code":0}' })
const err = (status, body) => ({ status, text: async () => body })

describe('gateway.complete', () => {
  it('retries 3007 with a fresh param without switching accounts', async () => {
    const account = acc('a1')
    const pool = fakePool([{ account, waitMs: 0 }])
    const paramPool = { take: async () => 'P' + Math.random() }
    const params = []
    const senders = {
      oauth: async ({ param }) => {
        params.push(param)
        return params.length < 3 ? err(400, '{"code":3007,"msg":"captcha verify failed"}') : ok()
      },
      apikey: async () => ok(),
    }
    const g = createGateway({ pool, paramPool, senders, config: { maxRetries: 2 } })
    const r = await g.complete({ model: 'GLM-5.3' }, {})
    expect(r.response.status).toBe(200)
    expect(params.length).toBe(3)
    // 三次发送用的是同一个账号（3007 是参数问题，不换号）：pool 只应被取号一次
    // ——fakePool 的单条脚本恰好只够一次 pick，若网关多取一次就会 503。
    // markError 仍会被调用以记录真实 status/code；3007 的"不冷却"由池内部决定。
    expect(account.errors.every((e) => e.code === 3007)).toBe(true)
  })

  it('3012: marks error, switches account, exhausts → GatewayError 429 with hint', async () => {
    const a1 = acc('a1'), a2 = acc('a2')
    const pool = fakePool([{ account: a1, waitMs: 0 }, { account: a2, waitMs: 0 }])
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => err(405, '{"code":3012,"msg":"blocked"}'), apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    await expect(g.complete({ model: 'GLM-5.3' }, {})).rejects.toMatchObject({ status: 429, code: 3012 })
    expect(a1.errors[0].code).toBe(3012)
    expect(a2.errors[0].code).toBe(3012)
  })

  it('401 marks needsRelogin via pool.markError and switches', async () => {
    const a1 = acc('a1'), a2 = acc('a2')
    const pool = fakePool([{ account: a1, waitMs: 0 }, { account: a2, waitMs: 0 }])
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async ({ account }) => (account.id === 'a1' ? err(401, '{"code":401}') : ok()), apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    const r = await g.complete({ model: 'GLM-5.3' }, {})
    expect(r.response.status).toBe(200)
    expect(r.account.id).toBe('a2')
    expect(a1.errors[0].status).toBe(401)
  })

  it('apikey accounts use the apikey sender without param', async () => {
    const a1 = acc('b1', 'apikey')
    const pool = fakePool([{ account: a1, waitMs: 0 }])
    const seen = []
    const g = createGateway({
      pool,
      paramPool: { take: async () => { throw new Error('should not take param') } },
      senders: { oauth: async () => ok(), apikey: async (args) => { seen.push(args); return ok() } },
      config: { maxRetries: 2 },
    })
    await g.complete({ model: 'glm-5.3' }, {})
    expect(seen.length).toBe(1)
    expect(seen[0].account.type).toBe('apikey')
  })

  it('client errors (400) pass through without retry', async () => {
    const a1 = acc('a1')
    const pool = fakePool([{ account: a1, waitMs: 0 }])
    let calls = 0
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => { calls++; return err(400, '{"type":"error","error":{"message":"bad"}}') }, apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    await expect(g.complete({ model: 'GLM-5.3' }, {})).rejects.toMatchObject({ status: 400 })
    expect(calls).toBe(1)
  })

  it('no accounts → 503', async () => {
    const g = createGateway({
      pool: fakePool([]),
      paramPool: { take: async () => 'P' },
      senders: {},
      config: { maxRetries: 2 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 503 })
  })

  // ── 以下为账号池最终契约（T4）要求、brief 示例未覆盖的分支 ──────────────────────

  it('no account + positive waitMs: waits then retries, succeeds on the next pick', async () => {
    const a1 = acc('a1')
    const seen = []
    const pool = fakePool(
      [
        { account: null, waitMs: 30, reason: 'all accounts within min interval (throttled)' },
        { account: a1, waitMs: 0 },
      ],
      { onPick: (i, r) => seen.push({ i, r }) },
    )
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => ok(), apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    const r = await g.complete({ model: 'GLM-5.3' }, {})
    expect(r.response.status).toBe(200)
    expect(r.account.id).toBe('a1')
    expect(seen.length).toBe(2)
  })

  it('no account + waitMs === null (human action required): fails immediately without spinning', async () => {
    const picks = []
    const pool = fakePool([], { onPick: (i) => picks.push(i) })
    const picksOrig = pool.pick
    pool.pick = () => {
      const r = { account: null, waitMs: null, reason: 'all accounts cooling down or disabled', warn: 'human action required' }
      picks.push(r)
      return r
    }
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => ok(), apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 503 })
    // 立即失败：只取过一次号，没有按 waitMs 空转重试
    expect(picks.length).toBe(1)
  })

  it('caps total pick attempts when the pool stays throttled (no infinite wait)', async () => {
    let picks = 0
    const pool = {
      pick: () => {
        picks++
        return { account: null, waitMs: 1, reason: 'all accounts within min interval (throttled)' }
      },
      markSuccess: async () => {},
      markError: async () => {},
    }
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => ok(), apikey: async () => ok() },
      config: { maxRetries: 2, maxPickAttempts: 3 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 503 })
    // 上限语义（照 brief 的 `++pickAttempts > maxPickAttempts`）：第 maxPickAttempts+1 次
    // 取号时判定越界并抛出，故总取号次数 = maxPickAttempts + 1，而不是无限。
    expect(picks).toBe(4)
  })

  it('passes the real status/code to markError and lets the pool own cooldown (no gateway-side cooling)', async () => {
    const a1 = acc('a1')
    const calls = []
    const pool = {
      pick: () => ({ account: a1, waitMs: 0 }),
      markSuccess: async () => {},
      markError: async (account, e) => { calls.push({ account, e }); account.errors.push(e) },
    }
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => err(405, '{"code":3012,"msg":"blocked"}'), apikey: async () => ok() },
      config: { maxRetries: 0 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 429, code: 3012 })
    // 只传真实 status/code；网关不自行写 cooldownUntil / strikes
    expect(calls.length).toBe(1)
    expect(calls[0].e).toEqual({ status: 405, code: 3012 })
  })

  it('awaits the async pool methods (no lost markError/markSuccess)', async () => {
    const a1 = acc('a1')
    const order = []
    const pool = {
      pick: () => ({ account: a1, waitMs: 0 }),
      markSuccess: async () => { await null; order.push('markSuccess') },
      markError: async () => { await null; order.push('markError') },
    }
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => ok(), apikey: async () => ok() },
      config: { maxRetries: 0 },
    })
    await g.complete({}, {})
    expect(order).toEqual(['markSuccess'])
  })

  it('3007 exhausted (paramRetries > maxRetries) surfaces the upstream error instead of looping', async () => {
    const a1 = acc('a1')
    const pool = fakePool([{ account: a1, waitMs: 0 }])
    let calls = 0
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => { calls++; return err(400, '{"code":3007,"msg":"captcha verify failed"}') }, apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 400, code: 3007 })
    // 首次 + maxRetries(2) 次换参重试 = 3 次发送；不换号（pool 只发过一个号）
    expect(calls).toBe(3)
  })

  it('1113 marks the account and surfaces 429 with a package hint', async () => {
    const a1 = acc('a1')
    const pool = fakePool([{ account: a1, waitMs: 0 }])
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => err(403, '{"code":1113,"msg":"no package"}'), apikey: async () => ok() },
      config: { maxRetries: 0 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 429, code: 1113 })
    expect(a1.errors[0].code).toBe(1113)
  })

  it('5xx switches accounts and retries', async () => {
    const a1 = acc('a1'), a2 = acc('a2')
    const pool = fakePool([{ account: a1, waitMs: 0 }, { account: a2, waitMs: 0 }])
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async ({ account }) => (account.id === 'a1' ? err(502, 'bad gateway') : ok()), apikey: async () => ok() },
      config: { maxRetries: 2 },
    })
    const r = await g.complete({}, {})
    expect(r.account.id).toBe('a2')
    expect(a1.errors[0].status).toBe(502)
  })

  it('network error from a sender switches accounts and eventually 502s', async () => {
    const a1 = acc('a1'), a2 = acc('a2')
    const pool = fakePool([{ account: a1, waitMs: 0 }, { account: a2, waitMs: 0 }])
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async () => { throw new Error('ECONNRESET') }, apikey: async () => ok() },
      config: { maxRetries: 1 },
    })
    await expect(g.complete({}, {})).rejects.toMatchObject({ status: 502 })
    expect(a1.errors[0].status).toBe(0)
    expect(a1.errors[0].code).toContain('ECONNRESET')
    expect(a2.errors.length).toBe(1)
  })

  it('GatewayError exposes status/code/hint/upstreamStatus', async () => {
    const g = createGateway({
      pool: fakePool([]),
      paramPool: { take: async () => 'P' },
      senders: {},
      config: { maxRetries: 2 },
    })
    const e = await g.complete({}, {}).catch((x) => x)
    expect(e).toBeInstanceOf(GatewayError)
    expect(e.name).toBe('GatewayError')
    expect(e.status).toBe(503)
    expect(e.hint).toBeTruthy()
  })

  it('uses a fresh random sessionId per call by default', async () => {
    const a1 = acc('a1')
    const pool = { pick: () => ({ account: a1, waitMs: 0 }), markSuccess: async () => {}, markError: async () => {} }
    const sids = []
    const g = createGateway({
      pool,
      paramPool: { take: async () => 'P' },
      senders: { oauth: async ({ sessionId }) => { sids.push(sessionId); return ok() }, apikey: async () => ok() },
      config: { maxRetries: 0 },
    })
    await g.complete({}, {})
    await g.complete({}, {})
    expect(sids.length).toBe(2)
    expect(sids[0]).not.toBe(sids[1])
  })

  it('does not await a positive waitMs after a successful pick (it is a pacing hint)', async () => {
    vi.useFakeTimers()
    try {
      const a1 = acc('a1')
      const pool = fakePool([{ account: a1, waitMs: 2000 }])
      const g = createGateway({
        pool,
        paramPool: { take: async () => 'P' },
        senders: { oauth: async () => ok(), apikey: async () => ok() },
        config: { maxRetries: 0 },
      })
      const p = g.complete({}, {})
      // 若误把"建议节流间隔"当成"必须等待"，这里在假时钟下会永远挂住
      const r = await Promise.race([p, new Promise((res) => setImmediate(() => res('pending')))])
      expect(r).not.toBe('pending')
      expect(r.response.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not sleep through a cooldown: returns the classified error when the pool has no account left', async () => {
    /**
     * 实测复现（对真实 AccountPool）：两号都吃 3012 后，`pick` 返回
     * `{account:null, waitMs:60000, reason:'all accounts cooling down or disabled'}`——
     * **正数 waitMs 且无 warn**（池只在 waitMs===null 时才给 warn）。
     * 若网关此时按契约"等 waitMs 再重试"，请求会在 30min~24h 的冷却窗里干睡，客户端早已超时。
     * 正确行为：手上已有分类好的 429/3012，直接抛给客户端。
     *
     * 这里临时把 setTimeout 换成"记录但立即执行"，使"误睡 60s"变成可检测的失败
     * （否则测试既慢又难判定）；断言不再发生任何真实等待。
     */
    const a1 = acc('a1'), a2 = acc('a2')
    let i = 0
    const pool = {
      pick: () => (i++ === 0 ? { account: a1, waitMs: 0 } : i === 2 ? { account: a2, waitMs: 0 } : { account: null, waitMs: 60_000, reason: 'all accounts cooling down or disabled' }),
      markSuccess: async () => {},
      markError: async (a, e) => a.errors.push(e),
    }
    const sleeps = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); return realSetTimeout(fn, 0) }
    try {
      const g = createGateway({
        pool,
        paramPool: { take: async () => 'P' },
        senders: { oauth: async () => err(405, '{"code":3012,"msg":"blocked"}'), apikey: async () => ok() },
        config: { maxRetries: 2 },
      })
      await expect(g.complete({}, {})).rejects.toMatchObject({ status: 429, code: 3012 })
      // 绝不为 60s 冷却窗排任何等待
      expect(sleeps.filter((ms) => ms >= 60_000).length).toBe(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    expect(a1.errors[0].code).toBe(3012)
    expect(a2.errors[0].code).toBe(3012)
  })

  it('still waits when throttled with no prior error (positive waitMs is the normal path)', async () => {
    // 与上一条对照：**没有**已分类错误时，正数 waitMs 是冷启动尖峰的正常路径，必须等待后重试。
    const a1 = acc('a1')
    let i = 0
    const pool = {
      pick: () => (i++ === 0
        ? { account: null, waitMs: 20, reason: 'all accounts within min interval (throttled)' }
        : { account: a1, waitMs: 0 }),
      markSuccess: async () => {},
      markError: async () => {},
    }
    const sleeps = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms) => { sleeps.push(ms); return realSetTimeout(fn, 0) }
    try {
      const g = createGateway({
        pool,
        paramPool: { take: async () => 'P' },
        senders: { oauth: async () => ok(), apikey: async () => ok() },
        config: { maxRetries: 2 },
      })
      const r = await g.complete({}, {})
      expect(r.response.status).toBe(200)
      expect(sleeps).toContain(20)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})
