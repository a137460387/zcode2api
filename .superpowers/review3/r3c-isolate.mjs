// 隔离 retryStillBlocked：按 waitMs 重试仍被挡 —— 是低估还是"过窗那一刻冷却号仍在冷却"造成的边界？
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const cases = []
for (let trial = 0; trial < 3000; trial++) {
  const t = 1_000_000
  const accs = []
  const nWin = 1 + Math.floor(Math.random() * 3)
  const nCool = 1 + Math.floor(Math.random() * 3)
  const nFresh = Math.random() < 0.3 ? 1 : 0
  for (let i = 0; i < nWin; i++) accs.push({ id: `w${i}`, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - Math.floor(Math.random() * MIN), lastError: null } })
  for (let i = 0; i < nCool; i++) accs.push({ id: `c${i}`, enabled: true, cooldownUntil: t + 1 + Math.floor(Math.random() * MIN), needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - Math.floor(Math.random() * 10 * MIN), lastError: null } })
  for (let i = 0; i < nFresh; i++) accs.push({ id: `f${i}`, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } })
  const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) if (a.stats.lastUsedAt > 0) pool.lastPick.set(a.id, a.stats.lastUsedAt)
  const r = pool.pick(null)
  if (r.account !== null) continue
  const healthyWindowed = accs.filter((a) => a.enabled !== false && a.needsRelogin !== true && a.noPackage !== true && a.cooldownUntil <= t && a.stats.lastUsedAt > 0 && a.stats.lastUsedAt + MIN > t)
  if (!healthyWindowed.length) continue
  const trueWait = Math.max(...healthyWindowed.map((a) => a.stats.lastUsedAt + MIN - t))
  const t2 = t + r.waitMs
  const pool2 = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t2 })
  for (const a of accs) if (a.stats.lastUsedAt > 0) pool2.lastPick.set(a.id, a.stats.lastUsedAt)
  const r2 = pool2.pick(null)
  if (r2.account === null) {
    // 重试时刻 t2，哪些健康号仍未过窗？以及是否有任何健康号存在？
    const healthyAtT2 = accs.filter((a) => a.enabled !== false && a.needsRelogin !== true && a.noPackage !== true && a.cooldownUntil <= t2)
    cases.push({
      waitMs: r.waitMs, trueWait, t2Offset: r.waitMs, reason: r2.reason, r2waitMs: r2.waitMs,
      healthyAtT2: healthyAtT2.length,
      stillWindowed: healthyAtT2.filter((a) => a.stats.lastUsedAt > 0 && a.stats.lastUsedAt + MIN > t2).map((a) => ({ id: a.id, remain: a.stats.lastUsedAt + MIN - t2 })),
      note: 'retry blocked',
    })
  }
}
console.log(JSON.stringify({ blockedSamples: cases.length, examples: cases.slice(0, 8) }, null, 2))
