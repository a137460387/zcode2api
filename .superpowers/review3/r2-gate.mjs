// 性质 4：门与挑号是否真共享同一条件？
// 用"前一轮 Critical 的精确输入"直接打门：已过窗老号 A + 窗内号 B/C + 亲和绑定 B。
// 以及更强变体：A 已过窗，B 窗内，C 窗内，且 affinity 绑 A/B/C 各种组合；
// 以及 nextThrottleAt 序 vs lastUsed 序"不一致"的极端构造。
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000

function mk(accs, t) {
  const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) },
    { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) if (a.stats.lastUsedAt > 0) pool.lastPick.set(a.id, a.stats.lastUsedAt)
  return pool
}
const acc = (id, lastUsedAt, over = {}) => ({ id, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt, lastError: null }, ...over })

const out = []
const t = 1_000_000

// 场景 1：门只看 used[0] 的旧缺陷形态（A 已过窗，B/C 窗内）
{
  const accs = [acc('A', t - 60_000), acc('B', t - 100), acc('C', t - 200)]
  const p = mk(accs, t)
  const r = p.pick(null)
  out.push({ case: '1: passed-window A + in-window B,C; pick(null)', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 2：亲和绑定到窗内号
{
  const accs = [acc('X', t - 60_000), acc('Y', t - 50)]
  const p = mk(accs, t)
  p.affinity.set('s', { accountId: 'Y', at: t - 1000 })
  const r = p.pick('s')
  out.push({ case: '2: affinity bound to in-window Y', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 3：亲和绑定到"已过窗"号 A，但同时有窗内号 B —— 旧缺陷最危险的组合（亲和点名要挑 A，但 B 在窗内）
{
  const accs = [acc('A', t - 60_000), acc('B', t - 500)]
  const p = mk(accs, t)
  p.affinity.set('s', { accountId: 'A', at: t - 10 })
  const r = p.pick('s')
  out.push({ case: '3: affinity bound to passed-window A while B in window', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 4：无数号 + 一个窗内号（老缺陷里 fresh 会插队）
{
  const accs = [acc('A', t - 100), { id: 'N', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } }]
  const p = mk(accs, t)
  const r = p.pick(null)
  out.push({ case: '4: fresh N + in-window A', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 5：lastUsed 序与 nextThrottleAt 序**完全不同**的构造（老号 lastUsed 最小但 nextThrottleAt 最大）
{
  // A: lastUsed 很旧但 cooldownUntil 已过（nextThrottleAt = lastUsed+MIN，最小）→ 旧门 used[0]，wait<=0
  // B: lastUsed 稍新，仍在窗内（nextThrottleAt 最大）
  const accs = [acc('A', t - 5000), acc('B', t - 10)]
  const p = mk(accs, t)
  const r = p.pick(null)
  out.push({ case: '5: extreme order mismatch A(old) B(just used)', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 6：所有历史号都已过窗 + 有 fresh → 应该能发号（不能过度阻断）
{
  const accs = [acc('A', t - 50_000), { id: 'N', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } }]
  const p = mk(accs, t)
  const r = p.pick(null)
  out.push({ case: '6: all passed-window + fresh exists -> should issue', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason })
}
// 场景 7：所有历史号都过窗、无 fresh → 应发最久未用者
{
  const accs = [acc('A', t - 50_000), acc('B', t - 40_000)]
  const p = mk(accs, t)
  const r = p.pick(null)
  out.push({ case: '7: all passed-window, no fresh -> LRU', account: r.account?.id ?? null, waitMs: r.waitMs })
}
console.log(JSON.stringify(out, null, 2))
