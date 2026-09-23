import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
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
    // 新语义：第一个号被选中后进入节流窗，池内时钟不推进时第二次 pick 必须返回 null
    // （否则就是"连拍压同一个号"）。要拿到不同的号，须等时钟推进到下一个 ready。
    // 这里推进得比 minIntervalMs 更大，且大于两个号之间的 readyAt 差，故必能拿到另一个。
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
  // ---- 修复轮 1 新增：A. 连拍不坍缩 ----
  // 风控防线：pool 的时钟不推进（无 sessionKey、调用方不 sleep）时，绝不允许把绝大多数
  // 请求压在同一条"最早过期"的账号上。旧实现（只挑 readyAt 最小、无"是否已过冷却窗"门槛）
  // 实测 4 账号 40 次连拍得 37,1,1,1；600 次得 9997,1,1,1。
  it('does not collapse a burst onto one account (A: throttle gate on pick)', async () => {
    const accs = [await add(), await add(), await add(), await add()]
    const counts = new Map(accs.map((a) => [a.id, 0]))
    let nulls = 0
    for (let i = 0; i < 40; i++) {
      const r = pool.pick(null)
      if (r.account) counts.set(r.account.id, counts.get(r.account.id) + 1)
      else nulls++
    }
    const max = Math.max(...counts.values())
    // 旧代码：max = 37（时钟不推进，同一个号被连压）。新语义：首次拿到号后全员进节流窗。
    expect(max).toBeLessThanOrEqual(1)
    expect(nulls).toBe(39)
  })
  // 关键不变量：节流窗内的号**绝不能**被排在一个还没用过（raw readyAt 恰好等于 t+minIntervalMs，
  // 看起来"更早可用"）的号后面。否则一旦时钟推进很慢（真实网关每请求 ~1ms，远小于 2000ms 窗），
  // 排序会反复挑中"最旧"的那个号——正是连拍坍缩的形态。这条用例把该门槛钉死。
  it('never prefers a never-used account over one that is merely inside its throttle window', async () => {
    const a = await add(), b = await add()
    // list() 是字典序不是创建序，故断言"哪一个先被选中"不可靠；只断言行为本身：
    const first = pool.pick(null).account
    const untouched = [a.id, b.id].find((id) => id !== first.id)
    const probes = []
    for (let i = 0; i < 5; i++) probes.push(pool.pick(null))
    // 那个从未被用过的号也**绝不**该被选中：它在窗内同样受 minIntervalMs 约束
    expect(probes.every((r) => r.account === null)).toBe(true)
    expect(pool.lastPick.has(untouched)).toBe(false)
    expect(probes.every((r) => r.waitMs === 2000)).toBe(true)
  })
  // 真实网关节奏：时钟每请求只前进 ~1ms，远小于 2000ms 节流窗。旧实现下同一个"最早"的号
  // 会被压 37/40 次；新语义下时钟推进本身就"消耗"了等待，故应逐个放行不同账号。
  it('does not collapse when the clock advances by only 1ms per pick', async () => {
    const accs = [await add(), await add(), await add(), await add()]
    const counts = new Map(accs.map((a) => [a.id, 0]))
    // 40ms 内每个号最多被放行 2 次（40/2000 向上取整），且必须不止一个号拿到过请求。
    // 只看 40 次里有没有换号是没有意义的（窗内本就该一个号都不放行），故额外推进到
    // 一个完整窗口再看轮询：推进 2000ms 后必须有**第二个**不同的号被选中。
    for (let i = 0; i < 40; i++) {
      clock.t += 1
      const r = pool.pick(null)
      if (r.account) counts.set(r.account.id, counts.get(r.account.id) + 1)
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2)
    const usedIds = [...counts.entries()].filter(([, c]) => c > 0).map(([id]) => id)
    expect(usedIds.length).toBe(1) // 40ms 内只放行过一个号（节流窗未过）
    // 窗过后必须轮到**别的**号（轮询）：从未用过的号按"最久未用"优先，故换号而非再压同一个
    clock.t += 2000
    const next = pool.pick(null).account
    expect(next).not.toBeNull()
    expect(next.id).not.toBe(usedIds[0])
  })
  it('returns a readable reason and a meaningful waitMs when every healthy account is throttled', async () => {
    await add(), await add(), await add(), await add()
    pool.pick(null) // 只可能有一个号被选中，4 个号全部进入 2000ms 节流窗
    const r = pool.pick(null)
    expect(r.account).toBeNull()
    // reason 必须与"冷却/停用/需重登"区分开：不能复用 'cooling'
    expect(r.reason).not.toContain('cooling')
    expect(r.reason).toContain('throttl')
    // waitMs 必须是"最早的账号还需等多久"，否则调用方无从决定等多久
    expect(r.waitMs).toBe(2000)
  })
  it('unthrottles after clock advances to the next ready account', async () => {
    const a = await add()
    const first = pool.pick(null).account
    expect(first.id).toBe(a.id)
    expect(pool.pick(null).account).toBeNull() // 仍在 2000ms 节流窗内
    clock.t += 1999
    expect(pool.pick(null).account).toBeNull() // 差 1ms 也不行
    clock.t += 1
    expect(pool.pick(null).account?.id).toBe(a.id) // 到点即放行
  })
  // ---- 修复轮 1 新增：C3. lastPick 清理 ----
  it('drops lastPick entries for accounts that no longer exist (status() sweep)', async () => {
    const a = await add(), b = await add()
    pool.pick(null)
    clock.t += 2000 // 过一个窗口，才能让第二个号也被记账
    pool.pick(null)
    expect(pool.lastPick.size).toBe(2)
    const [gone, kept] = [a.id, b.id].filter((id) => pool.lastPick.has(id))
    store.delete(gone)
    pool.status()
    expect(pool.lastPick.has(gone)).toBe(false)
    expect(pool.lastPick.has(kept)).toBe(true) // 只清已消失的 id
  })
  // 会话亲和：同一 sessionKey 反复 pick 必须粘在同一账号上（health 允许时），
  // 且该绑定不会把别的会话也拖到同一个号上。同样不依赖创建顺序。
  // **注意（修复轮 2）**：亲和命中同样要过 `minIntervalMs` 节流门，故"稳定性"必须在
  // **时钟推进**下测——时钟不推进时同会话连拍本就该被挡住（否则 header 就是绕过节流的口子）。
  it('session affinity sticks to the same healthy account', async () => {
    const a = await add(), b = await add()
    const stuck = pool.pick('s1').account.id
    expect([a.id, b.id]).toContain(stuck)
    clock.t += 2000 // 过一节流窗：亲和号解禁，且本轮没有更"久未用"的号能把它顶掉
    expect(pool.pick('s1').account.id).toBe(stuck)
    clock.t += 2000
    expect(pool.pick('s1').account.id).toBe(stuck)
  })
  it('affinity is per-session (different sessions can land on different accounts)', async () => {
    const a = await add(), b = await add()
    const s1 = pool.pick('s1').account.id
    clock.t += 2000 // 过一节流窗，第二个会话才有号可拿（新语义：窗内不发号）
    const s2 = pool.pick('s2').account.id
    expect([a.id, b.id]).toContain(s1)
    expect([a.id, b.id]).toContain(s2)
    expect(s2).not.toBe(s1) // 两号各被一个会话粘住（修复轮 2：同窗内不得把 s1 的号再发一次）
    // 两个会话各自粘住自己的号
    clock.t += 2000
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

  // ---- 修复轮 2 新增：① Critical — 会话亲和分支不得绕过节流门 ----
  // `sessionKey` 直接来自客户端可任意设置的 `x-session-id` 请求头，因此"带同一个 header +
  // 客户端不节流连发"必须不能绕过 `minIntervalMs`。旧实现只查 `healthy()`（enabled/needsRelogin/
  // noPackage/cooldown），不查节流窗，直接发号——实测同一 sessionKey 连拍 200 次得 200/200 全落
  // 同一个号（非亲和路径同期是 1 + 199 null）。被压的正是"刚用过的那个号"，与本任务第一轮
  // Critical（37,1,1,1）是同一类风控防线失效，只是触发条件是带 header。
  it('does not let an affinity hit bypass the throttle gate (burst on one sessionKey)', async () => {
    const accs = [await add(), await add(), await add(), await add()]
    const counts = new Map(accs.map((a) => [a.id, 0]))
    let nulls = 0
    for (let i = 0; i < 200; i++) {
      const r = pool.pick('s-burst')
      if (r.account) counts.set(r.account.id, counts.get(r.account.id) + 1)
      else nulls++
    }
    // 时钟冻结下亲和**不能**把 200 次请求全压在一个号上；至多放行一次（与非亲和路径同门）。
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(1)
    expect(nulls).toBe(199)
  })
  // 设计选择（修复轮 2 定案）：亲和号被节流时**不特殊照顾、也不等待它**，而是走与非亲和路径
  // 完全相同的那两层门——"还有历史号在窗内就一律不发号"。于是：
  //  - 绑定号仍在窗内 → `{account:null, waitMs:真实剩余, reason:'throttled'}`（不会把同一个号再发一次，
  //    也不会硬等它——`pick` 是同步接口，等待是调用方按 `waitMs` 做的事）；
  //  - 绑定号过窗后**依旧是它**（会话一致性得以保持，而不是被轮询换走）；
  //  - 只有当它变得**不健康**（冷却/停用/需重登/无套餐）或亲和过期时，才真正**换号回落**。
  // 这样"回落"只发生在"原号真的不能用了"，而"节流"由统一的 `throttled` 门处理，两者不混淆。
  it('falls back to another account when the affinity account is throttled', async () => {
    const a = await add(), b = await add()
    const stuck = pool.pick('s1').account.id
    // 时钟不推进：绑定号仍在窗内 → 不发号；waitMs 是真实剩余等待（不变相压号）
    const throttled = pool.pick('s1')
    expect(throttled.account).toBeNull()
    expect(throttled.reason).toContain('throttl')
    expect(throttled.waitMs).toBe(2000)
    // 过一节流窗后仍是**同一个**绑定号（会话一致性不被轮询破坏）
    clock.t += 2000
    expect(pool.pick('s1').account.id).toBe(stuck)
    // 真正的回落：绑定号变得不健康（冷却）时，换到另一个号，且亲和绑定被改写到新号
    await store.update(stuck, { cooldownUntil: clock.t + 600_000 })
    clock.t += 2000
    const r = pool.pick('s1')
    expect([a.id, b.id]).toContain(r.account?.id)
    expect(r.account?.id).not.toBe(stuck)
    expect(pool.affinity.get('s1').accountId).toBe(r.account.id)
  })

  // ---- 修复轮 2 新增：② Important — 全冷却时 waitMs 必须是真实剩余等待 ----
  it('reports the true remaining wait when every account is cooling down', async () => {
    const accs = [await add(), await add(), await add()]
    for (const [i, acc] of accs.entries()) {
      await store.update(acc.id, { cooldownUntil: clock.t + 30 * 60_000 + i * 1000 })
    }
    const r0 = pool.pick(null)
    expect(r0.account).toBeNull()
    expect(r0.reason).toContain('cooling')
    // 旧实现硬编码 waitMs: 0 —— 每个请求都会立即失败/立即重试
    expect(r0.waitMs).toBe(30 * 60_000)
    expect(r0.waitMs).not.toBe(0)
    // 随钟递减而非恒定
    clock.t += 60_000
    expect(pool.pick(null).waitMs).toBe(29 * 60_000)
    clock.t += 120_000
    expect(pool.pick(null).waitMs).toBe(27 * 60_000)
    // 过窗即放行
    clock.t += 27 * 60_000
    expect(pool.pick(null).account).not.toBeNull()
  })
  // ---- 修复轮 2 新增：④ 可区分信号 — "等一会儿就好" vs "需要人工干预" ----
  // 后者的 `waitMs` 必须是 `null`（而不是 0 / 正数）：T15 看到 null 就应停止重试并返回
  // 503/告警等待人工登录或启用，绝不能把它当成"立刻重试"。
  it('signals waitMs=null when no account can become available without human action', async () => {
    const a = await add(), b = await add(), c = await add()
    await store.update(a.id, { enabled: false })
    await store.update(b.id, { needsRelogin: true })
    await store.update(c.id, { noPackage: true })
    const r = pool.pick(null)
    expect(r.account).toBeNull()
    expect(r.waitMs).toBeNull()
    expect(r.reason).toContain('cooling') // 既有文案保留（T15/T17 已按 'cooling' 断言）
    expect(r.warn).toBe('human action required')
    // 与"冷却中"（可自愈）明确区分：冷却给得出正数 waitMs
    const d = await add()
    await store.update(d.id, { cooldownUntil: clock.t + 5000 })
    const r2 = pool.pick(null)
    expect(r2.waitMs).toBe(5000)
    expect(r2.warn).toBeUndefined()
    // 纯节流情形同样给正数 waitMs（不需要人工干预）
    await store.update(d.id, { enabled: false })
    await store.update(store.list()[0].id, {})
    const e = await add()
    pool.pick(null)
    const r3 = pool.pick(null)
    expect(r3.account).toBeNull()
    expect(r3.reason).toContain('throttl')
    expect(r3.waitMs).toBe(2000)
  })
})

// ---- 修复轮 1 新增：内存账 / 磁盘账分叉（C） ----
describe('AccountPool memory vs disk accounting', () => {
  it('takes max(memory, disk) so a newer disk value is never ignored', async () => {
    const a = await add()
    // 构造"内存更旧、磁盘更新"：内存账 = 1e6，磁盘 lastUsedAt = 1.01e6（markSuccess 只写磁盘）
    clock.t = 1_000_000
    expect(pool.pick(null).account.id).toBe(a.id) // 内存账落在 1e6
    clock.t = 1_010_000
    await pool.markSuccess(store.get(a.id)) // 只更新磁盘的 lastUsedAt = 1.01e6
    expect(store.get(a.id).stats.lastUsedAt).toBe(1_010_000)
    // 旧实现用 ?? 取内存优先 → lastUsed = 1e6 → nextThrottleAt = 1002000（比正确值早 10s 放行，放宽风控）
    expect(pool.lastUsed(store.get(a.id))).toBe(1_010_000)
    expect(pool.nextThrottleAt(store.get(a.id))).toBe(1_012_000)
  })
  it('warns once (with account id and error) when the lastUsedAt write fails', async () => {
    const a = await add()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bad = { list: () => store.list(), update: () => Promise.reject(new Error('disk full')) }
      const p = new AccountPool(bad, { minIntervalMs: 2000, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
      p.pick(null)
      await new Promise((r) => setTimeout(r, 0)) // 让 .catch 落地
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(a.id)
      expect(String(warn.mock.calls[0][0])).toContain('disk full')
    } finally {
      warn.mockRestore()
    }
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
  it('recordUsage is concurrency-safe (no lost updates)', async () => {    // 网关并发处理请求时会同时记账；用 AccountStore 的按 id 串行化保证不丢更新。
    const a = await add()
    await Promise.all(Array.from({ length: 50 }, () => pool.recordUsage(a.id, { inputTokens: 1, outputTokens: 1 })))
    const s = store.get(a.id).stats
    expect(s.requests).toBe(50)
    expect(s.inputTokens).toBe(50)
    expect(s.outputTokens).toBe(50)
  })
})
