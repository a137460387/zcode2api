// P3 修正版：trueWait 只取**健康**（enabled/needsRelogin/noPackage/cooldown 全过）的历史号——
// 冷却号不参与 pick 的门（实现者的注释与语义一致）。这是"waitMs 是否低估"的正确参照。
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
let cases = 0, under = 0
const samples = []
let overshoot = 0
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
  cases++
  if (r.account !== null) continue
  // 参照：下一次"真的能发号"的时刻 = 所有健康历史号都过窗的时刻（若存在窗内健康历史号）
  const healthyWindowed = accs.filter((a) => a.enabled !== false && a.needsRelogin !== true && a.noPackage !== true && a.cooldownUntil <= t && a.stats.lastUsedAt > 0 && a.stats.lastUsedAt + MIN > t)
  if (healthyWindowed.length) {
    const trueWait = Math.max(...healthyWindowed.map((a) => a.stats.lastUsedAt + MIN - t))
    if (r.waitMs < trueWait) { under++; if (samples.length < 5) samples.push({ trial, waitMs: r.waitMs, trueWait, nWin, nCool, nFresh }) }
    // 也检查"按 waitMs 等待后必须能拿到号"（这是 waitMs 的真正契约）
    const t2 = t + r.waitMs
    const accs2 = accs.map((a) => ({ ...a }))
    const pool2 = new AccountPool({ list: () => accs2, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t2 })
    for (const a of accs2) if (a.stats.lastUsedAt > 0) pool2.lastPick.set(a.id, a.stats.lastUsedAt)
    const r2 = pool2.pick(null)
    if (r2.account === null) overshoot++
  }
}
console.log(JSON.stringify({ cases, underestimated: under, retryStillBlocked: overshoot, pass: under === 0 && overshoot === 0, samples }, null, 2))
