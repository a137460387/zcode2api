// 控制者 #1 复现：大型随机序列，最小同号间隔
// 控制者 #2/#3：已过窗号 + 刚用过号（含亲和绑定）→ 不发号
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const out = []

// #1：与实现者测试同构的场景（200 组 × 40 步，单 sessionKey 混合），统计最小间隔
{
  let issued = 0, viol = 0, minGap = Infinity
  for (let trial = 0; trial < 200; trial++) {
    const clk = { t: 1_000_000 }
    const n = 3 + Math.floor(Math.random() * 3)
    const accs = Array.from({ length: n }, (_, i) => ({ id: `u${trial}-${i}`, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: 0, lastError: null } }))
    const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
    const seen = new Map()
    for (let s = 0; s < 40; s++) {
      clk.t += 1 + Math.floor(Math.random() * 1500)
      const r = p.pick(Math.random() < 0.5 ? 'sess' : null)
      if (r.account) {
        issued++
        const prev = seen.get(r.account.id)
        if (prev !== undefined) { const g = clk.t - prev; minGap = Math.min(minGap, g); if (g < MIN) viol++ }
        seen.set(r.account.id, clk.t)
      }
    }
  }
  out.push({ check: 'controller #1: 200x40 random sequences', issued, violations: viol, minGapMs: minGap === Infinity ? 'Infinity' : minGap, pass: viol === 0 })
}
// #2：已过窗号 + 刚用过号 → null, waitMs=1950
{
  const t = 1_000_001
  const accs = [
    { id: 'A', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 60_000, lastError: null } },
    { id: 'B', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 50, lastError: null } },
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) p.lastPick.set(a.id, a.stats.lastUsedAt)
  const r = p.pick(null)
  out.push({ check: 'controller #2: passed-window + just-used -> no issue', account: r.account, waitMs: r.waitMs, reason: r.reason, pass: r.account === null && r.waitMs === 1950 })
}
// #3：亲和绑定刚用过的号 → 被挡
{
  const t = 1_000_001
  const accs = [
    { id: 'X', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 60_000, lastError: null } },
    { id: 'Y', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 50, lastError: null } },
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) p.lastPick.set(a.id, a.stats.lastUsedAt)
  p.affinity.set('sess', { accountId: 'Y', at: t - 1000 })
  const r = p.pick('sess')
  out.push({ check: 'controller #3: affinity bound to just-used -> blocked', account: r.account, waitMs: r.waitMs, reason: r.reason, pass: r.account === null })
}
console.log(JSON.stringify(out, null, 2))
