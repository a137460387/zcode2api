// 确认 earliestWaitMs 的第二套判据：
//   blockingEnd 只扫 healthyAccs（健康号）→ 冷却号的历史窗**完全不参与**判据。
//   但冷却号一旦解禁（healthy 变 true），它的 lastUsed + MIN 可能仍然 > t → 立刻成为新的 blocking 号！
//   → 报出的 waitMs 在"冷却解禁那一刻"拿不到号，且剩余等待可以**重新变大**（不是单调递减）。
//
// 这是"门条件"与"waitMs 判据"的第二套不一致，正是上一轮 Critical 的同一形态：
//   - pick 的门 = all accounts filter(lastUsed>0 && nextThrottleAt>t)   ← 用**全体健康**（含冷却解禁后）
//   - earliestWaitMs 的 blockingEnd = healthyAccs（当前时刻的健康号）
//   → 用**当前**健康集合算未来等待，忽略"冷却号解禁后会变成 blocking"。
//
// 最小复现：一个冷却号 C（cooldownUntil = t+1000，lastUsedAt = t-500），无其它号。
//   此刻 healthy = [] → 走 !healthy.length 分支 → earliestWaitMs → selfHealing 有 C → oldestCool = t+1000 → waitMs = 1000。
//   按 1000 等待：t=1000 时 C 健康、lastUsed=t-500 → nextThrottleAt = t-500+2000 = t+1500 > t → **blocking** → 仍不发号！
//   即"按 waitMs 重试拿不到号"。
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const acc = (id, lastUsedAt, cooldownUntil) => ({ id, enabled: true, cooldownUntil, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt, lastError: null } })

const t = 1_000_000
// 最小复现：单号，冷却 1000ms，但它的节流窗还剩 1500ms
const accs = [acc('C', t - 500, t + 1000)]
const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
for (const a of accs) pool.lastPick.set(a.id, a.stats.lastUsedAt)

const r = pool.pick(null)
console.log('pick at t=1e6            ->', { account: r.account, waitMs: r.waitMs, reason: r.reason })
const t2 = t + r.waitMs
const pool2 = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t2 })
for (const a of accs) pool2.lastPick.set(a.id, a.stats.lastUsedAt)
const r2 = pool2.pick(null)
console.log(`pick at t=1e6+${r.waitMs} (after waiting waitMs) ->`, { account: r2.account, waitMs: r2.waitMs, reason: r2.reason })

// 再证"剩余等待非单调递减"（同一最小复现）
const series = []
for (const dt of [0, 200, 400, 600, 800, 1000, 1200, 1400, 1500, 1600]) {
  const pp = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t + dt })
  for (const a of accs) pp.lastPick.set(a.id, a.stats.lastUsedAt)
  const rr = pp.pick(null)
  series.push({ dt, account: rr.account?.id ?? null, waitMs: rr.waitMs })
}
console.log('waitMs over time (should be monotonically non-increasing, and 0/issued by dt=1500):')
console.table(series)
