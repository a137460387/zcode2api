// 严重度评估：earliestWaitMs 的第二套判据（冷却号解禁后变成 blocking 号）会导致
//  "按 waitMs 重试拿不到号"——但每次重试都会拿到一个新的正 waitMs，不会死循环。
//  统计真实网关行为：一直按 waitMs 重试，总共需要多少次 round-trip / 累计等待多久才拿到号？
//  与"正确 waitMs（= 最晚过窗时刻）"对比，量化浪费的 round-trip 次数与总等待。
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const acc = (id, lastUsedAt, cooldownUntil) => ({ id, enabled: true, cooldownUntil, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt, lastError: null } })

function simulate(accs, t0, verbose = false) {
  // 正确的"最早可发号"时刻：全体历史号（含将解禁的冷却号）的最晚过窗时刻 与 最早冷却解禁 的 max
  const allUsed = accs.filter((a) => a.stats.lastUsedAt > 0)
  const latestWindow = allUsed.length ? Math.max(...allUsed.map((a) => a.stats.lastUsedAt + MIN)) : t0
  const earliestCool = Math.min(...accs.map((a) => a.cooldownUntil ?? 0).filter((c) => c > t0))
  const trueReady = Math.max(latestWindow, Math.min(...accs.filter((a) => (a.cooldownUntil ?? 0) > t0).map((a) => a.cooldownUntil ?? Infinity), Infinity) === Infinity ? latestWindow : Math.max(latestWindow, earliestCool))

  let t = t0, retries = 0, totalWait = 0
  const trace = []
  for (let i = 0; i < 20; i++) {
    const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
    for (const a of accs) if (a.stats.lastUsedAt > 0) pool.lastPick.set(a.id, a.stats.lastUsedAt)
    const r = pool.pick(null)
    if (r.account) { trace.push({ t: t - t0, got: r.account.id }); return { retries, totalWait, trace, got: r.account.id } }
    trace.push({ t: t - t0, issued: null, waitMs: r.waitMs, reason: r.reason.slice(0, 12) })
    if (r.waitMs === null || r.waitMs === 0) break
    retries++; totalWait += r.waitMs; t += r.waitMs
  }
  return { retries, totalWait, trace, got: null }
}

// 场景：1 号冷却 1000ms，节流窗还剩 1500ms（冷却更早解禁）
const t0 = 1_000_000
const accs = [acc('C', t0 - 500, t0 + 1000)]
const s = simulate(accs, t0)
console.log('scenario: cooling ends 1000ms, throttle window left 1500ms')
console.log(JSON.stringify(s, null, 2))

// 场景：5 个号，冷却号解禁时刻各不相同且早于各自的节流窗结束（真实"重启+暴风冷却"形态）
const accs2 = [
  acc('a', t0 - 300, 0),
  acc('b', t0 - 1500, 0),
  acc('c', t0 - 900, t0 + 700),
  acc('d', t0 - 100, t0 + 300),
]
const s2 = simulate(accs2, t0)
console.log('scenario: 4 accounts, mixed cooling/throttle')
console.log(JSON.stringify(s2, null, 2))
