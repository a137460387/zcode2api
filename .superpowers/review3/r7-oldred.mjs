// 验证修复轮 3 的 5 条新测试是否真在断言不变量（而非形式化）：
// 用 git show 恢复 5d72245 的 src/accounts.js 到临时文件，让新测试 import 它，看是否真红。
import fs from 'node:fs'
import { execSync } from 'node:child_process'
const old = execSync('git show 5d72245:src/accounts.js', { cwd: 'D:/code/Ai/zcode2api', encoding: 'utf8' })
fs.writeFileSync('D:/code/Ai/zcode2api/.superpowers/review3/accounts-old.js', old)
console.log('wrote old accounts.js, bytes', old.length)
// 报告声称：5d72245 上新测试 5 条失败。这里独立复现最关键的两条（门不变量 + 规模化不变量）。
const { AccountPool } = await import('./accounts-old.js')
const MIN = 2000

// ① 门不变量：A 已过窗 + B/C 窗内 → 旧实现返回 A（违反）
{
  const t = 1_000_000
  const accs = [
    { id: 'A', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { lastUsedAt: t - 60_000 } },
    { id: 'B', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { lastUsedAt: t - 100 } },
    { id: 'C', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { lastUsedAt: t - 200 } },
  ]
  const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) p.lastPick.set(a.id, a.stats.lastUsedAt)
  const r = p.pick(null)
  console.log('OLD gate invariant: pick(null) ->', r.account?.id ?? null, 'waitMs', r.waitMs, '(new code: null)')
}

// ② 规模化不变量：旧实现应有非 0 违反率
{
  let issued = 0, viol = 0, minGap = Infinity
  for (let trial = 0; trial < 200; trial++) {
    const clk = { t: 1_000_000 }
    const n = 3 + Math.floor(Math.random() * 3)
    const accs = Array.from({ length: n }, (_, i) => ({ id: `u${trial}-${i}`, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { lastUsedAt: 0 } }))
    const p = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
    const seen = new Map()
    for (let s = 0; s < 40; s++) {
      clk.t += 1 + Math.floor(Math.random() * 1500)
      const r = p.pick(Math.random() < 0.5 ? 'sess' : null)
      if (r.account) { issued++; const pv = seen.get(r.account.id); if (pv !== undefined) { const g = clk.t - pv; minGap = Math.min(minGap, g); if (g < MIN) viol++ } seen.set(r.account.id, clk.t) }
    }
  }
  console.log('OLD scale invariant: issued', issued, 'violations', viol, `(${(100 * viol / Math.max(1, issued)).toFixed(1)}%)`, 'minGap', minGap)
}
