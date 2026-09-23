import { describe, it, expect, beforeEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'

let store, pool, clock
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-pool-'))
  store = new AccountStore(dir)
  clock = { t: 1_000_000 }
  pool = new AccountPool(store, {
    minIntervalMs: 2000,
    cooldown3012Ms: 30 * 60_000,
    now: () => clock.t,
  })
})
const add = async (over = {}) =>
  store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: String(Math.random()).slice(2) }, ...over }))
// 注意：AccountStore.save/update 现为 async（Task 3 演进），下面 add() 的调用点均需 await。

describe('AccountPool.pick', () => {
  it('returns null with reason when empty', () => {
    expect(pool.pick(null).account).toBeNull()
    expect(pool.pick(null).reason).toBe('no accounts')
  })
  // 注意：pick() 的"最早可用"排序在平秩时以 store.list() 给的顺序为准，而 list()
  // 是 fs.readdirSync（文件名/字典序），**不是**创建顺序。故断言不能绑定"先创建的先被选中"，
  // 否则约 50% 概率随机失败（实测 300 次中仅 140 次 pick 命中最先创建的账号）。
  // 这里断言的是行为本身：两次 pick 必须落到两个不同的健康账号（轮询真的在轮换）。
  it('round-robins across healthy accounts by least-recently-used', async () => {
    const a = await add(), b = await add()
    const first = pool.pick(null).account
    expect([a.id, b.id]).toContain(first.id)
    clock.t += 10_000
    const second = pool.pick(null).account
    expect([a.id, b.id]).toContain(second.id)
    expect(second.id).not.toBe(first.id) // 关键：不重复压同一个号
  })
  it('respects minIntervalMs as waitMs', async () => {
    const a = await add()
    pool.markSuccess(a)
    const r = pool.pick(null)
    expect(r.account.id).toBe(a.id)
    expect(r.waitMs).toBe(2000)
  })
  // 会话亲和：同一 sessionKey 反复 pick 必须粘在同一账号上（health 允许时），
  // 且该绑定不会把别的会话也拖到同一个号上。同样不依赖创建顺序。
  it('session affinity sticks to the same healthy account', async () => {
    const a = await add(), b = await add()
    const stuck = pool.pick('s1').account.id
    expect([a.id, b.id]).toContain(stuck)
    expect(pool.pick('s1').account.id).toBe(stuck)
    expect(pool.pick('s1').account.id).toBe(stuck)
  })
  it('affinity is per-session (different sessions can land on different accounts)', async () => {
    const a = await add(), b = await add()
    const s1 = pool.pick('s1').account.id
    const s2 = pool.pick('s2').account.id
    expect([a.id, b.id]).toContain(s1)
    expect([a.id, b.id]).toContain(s2)
    // 两个会话各自粘住自己的号
    expect(pool.pick('s1').account.id).toBe(s1)
    expect(pool.pick('s2').account.id).toBe(s2)
  })

  it('skips cooling / disabled / needsRelogin / noPackage accounts', async () => {
    const a = await add()
    await store.update(a.id, { cooldownUntil: clock.t + 60_000 })
    expect(pool.pick(null).reason).toContain('cooling')
    await store.update(a.id, { cooldownUntil: 0, enabled: false })
    expect(pool.pick(null).reason).toContain('cooling')
    await store.update(a.id, { enabled: true, needsRelogin: true })
    expect(pool.pick(null).reason).toContain('cooling')
    await store.update(a.id, { needsRelogin: false, noPackage: true })
    expect(pool.pick(null).reason).toContain('cooling')
  })
})

describe('AccountPool error handling', () => {
  // strikes 是**累计**风控次数（brief 规则：第 3 次起 24h 冷却、第 5 次停用待人工），
  // 不是"当前 24h 窗口内的计数"：故 24h 时间跳变只让第 4、5 次继续累加，不会重置计数
  // （只有 markSuccess 清零）。原 brief 测试在跳变后直接断言 enabled=false，
  // 与"24h 窗口内计数"的读法矛盾，这里按其断言所要求的累计语义写明确。
  it('3012: cooldown 30min, 3rd strike → 24h, 5th cumulative strike → disabled', async () => {
    const a = await add()
    await pool.markError(a, { status: 405, code: 3012 })
    expect(store.get(a.id).strikes).toBe(1)
    expect(store.get(a.id).cooldownUntil).toBe(clock.t + 30 * 60_000)
    clock.t += 60_000
    await pool.markError(store.get(a.id), { status: 405, code: 3012 })
    expect(store.get(a.id).strikes).toBe(2)
    expect(store.get(a.id).cooldownUntil).toBe(clock.t + 30 * 60_000)
    clock.t += 60_000
    await pool.markError(store.get(a.id), { status: 405, code: 3012 })
    expect(store.get(a.id).strikes).toBe(3)
    expect(store.get(a.id).cooldownUntil).toBe(clock.t + 24 * 60 * 60_000)
    // 第 4、5 次继续累加至 5 → 停用（strikes 不因时间流逝而回退）
    clock.t += 24 * 60 * 60_000 + 1
    await pool.markError(store.get(a.id), { status: 405, code: 3012 })
    expect(store.get(a.id).strikes).toBe(4)
    expect(store.get(a.id).enabled).toBe(true)
    await pool.markError(store.get(a.id), { status: 405, code: 3012 })
    expect(store.get(a.id).strikes).toBe(5)
    expect(store.get(a.id).enabled).toBe(false)
  })
  it('401 → needsRelogin; 1113 → noPackage; 429 → 60s cooldown', async () => {
    const a = await add(), b = await add(), c = await add()
    await pool.markError(a, { status: 401, code: null })
    expect(store.get(a.id).needsRelogin).toBe(true)
    await pool.markError(b, { status: 429, code: 1113 })
    expect(store.get(b.id).noPackage).toBe(true)
    await pool.markError(c, { status: 429, code: null })
    expect(store.get(c.id).cooldownUntil).toBe(clock.t + 60_000)
  })
  it('markSuccess resets strikes and cooldown', async () => {
    const a = await add()
    await pool.markError(a, { status: 405, code: 3012 })
    await pool.markSuccess(store.get(a.id))
    expect(store.get(a.id).strikes).toBe(0)
    expect(store.get(a.id).cooldownUntil).toBe(0)
    expect(store.get(a.id).stats.lastUsedAt).toBe(clock.t)
  })
  it('recordUsage accumulates token stats', async () => {
    const a = await add()
    await pool.recordUsage(a.id, { inputTokens: 10, outputTokens: 5 })
    await pool.recordUsage(a.id, { inputTokens: 1, outputTokens: 2 })
    const s = store.get(a.id).stats
    expect(s.inputTokens).toBe(11)
    expect(s.outputTokens).toBe(7)
    expect(s.requests).toBe(2)
  })
  it('recordUsage is concurrency-safe (no lost updates)', async () => {
    // 网关并发处理请求时会同时记账；用 AccountStore 的按 id 串行化保证不丢更新。
    const a = await add()
    await Promise.all(Array.from({ length: 50 }, () => pool.recordUsage(a.id, { inputTokens: 1, outputTokens: 1 })))
    const s = store.get(a.id).stats
    expect(s.requests).toBe(50)
    expect(s.inputTokens).toBe(50)
    expect(s.outputTokens).toBe(50)
  })
})
