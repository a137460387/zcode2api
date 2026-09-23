// 性质 5：混合冷却 + 节流 + 停用的复杂池
// 性质 6：亲和 + 节流交互（绑定号健康但在窗内 → 全体不发号；绑定号不健康 → 立即改绑）
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const out = []

// ---- 性质 5：复杂池 ----
{
  const t = 1_000_000
  const accs = [
    { id: 'H1', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 50_000, lastError: null } }, // 健康已过窗
    { id: 'H2', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 500, lastError: null } },   // 健康窗内
    { id: 'CD', enabled: true, cooldownUntil: t + 60_000, needsRelogin: false, noPackage: false, strikes: 1, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 1000, lastError: null } }, // 冷却
    { id: 'RL', enabled: true, cooldownUntil: 0, needsRelogin: true, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 100, lastError: null } },   // 需重登
    { id: 'NP', enabled: false, cooldownUntil: 0, needsRelogin: false, noPackage: true, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 100, lastError: null } },   // 停用
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) if (a.stats.lastUsedAt > 0) p.lastPick.set(a.id, a.stats.lastUsedAt)
  const r = p.pick(null)
  out.push({ check: 'P5 mixed pool: in-window healthy exists -> must not issue', account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason, expectNull: true, pass: r.account === null && r.waitMs === 1500 })
}
// ---- 性质 5b：可人工干预（全停用/需重登/无套餐）→ waitMs null + warn ----
{
  const t = 1_000_000
  const accs = [
    { id: 'A', enabled: false, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 5, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } },
    { id: 'B', enabled: true, cooldownUntil: 0, needsRelogin: true, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } },
    { id: 'C', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: true, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } },
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  const r = p.pick(null)
  out.push({ check: 'P5b all human-action -> waitMs null + warn', waitMs: r.waitMs, warn: r.warn, reason: r.reason, pass: r.account === null && r.waitMs === null && r.warn === 'human action required' })
}
// ---- 性质 6a：绑定号健康但在窗内 → 全体不发号，waitMs 真实，且重试后仍是它 ----
{
  const t = 1_000_000
  const accs = [
    { id: 'BND', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 100, lastError: null } },
    { id: 'OTH', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 60_000, lastError: null } },
  ]
  let tt = t
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => tt })
  for (const a of accs) if (a.stats.lastUsedAt > 0) p.lastPick.set(a.id, a.stats.lastUsedAt)
  p.affinity.set('s', { accountId: 'BND', at: t - 10 })
  const r = p.pick('s')
  const r1 = { account: r.account?.id ?? null, waitMs: r.waitMs, reason: r.reason }
  tt = t + 1900
  const r2 = p.pick('s')
  out.push({ check: 'P6a bound healthy but in-window -> no issue; after wait, still bound', first: r1, after: { account: r2.account?.id ?? null, waitMs: r2.waitMs }, pass: r1.account === null && r1.waitMs === 1900 && r2.account?.id === 'BND' })
}
// ---- 性质 6b：绑定号不健康（冷却）→ 立即改绑 ----
{
  const t = 1_000_000
  const accs = [
    { id: 'BND', enabled: true, cooldownUntil: t + 600_000, needsRelogin: false, noPackage: false, strikes: 1, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 100_000, lastError: null } },
    { id: 'OTH', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 100_000, lastError: null } },
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) if (a.stats.lastUsedAt > 0) p.lastPick.set(a.id, a.stats.lastUsedAt)
  p.affinity.set('s', { accountId: 'BND', at: t - 10 })
  const r = p.pick('s')
  out.push({ check: 'P6b bound unhealthy (cooling) -> immediately rebind', account: r.account?.id ?? null, waitMs: r.waitMs, newBinding: p.affinity.get('s')?.accountId, pass: r.account?.id === 'OTH' && p.affinity.get('s')?.accountId === 'OTH' })
}
console.log(JSON.stringify(out, null, 2))
