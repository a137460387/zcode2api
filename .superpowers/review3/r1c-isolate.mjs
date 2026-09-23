// 隔离：违反是否只由我"事后直接改写 lastPick（模拟外部/持久层状态变化）"造成？
// 变量：是否在循环里 p.lastPick.set(pool内部账) —— 等价于"进程重启后从磁盘恢复更旧的历史"
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000

function run(mutate) {
  let violations = 0, issued = 0, worst = Infinity, minGap = Infinity
  const samples = []
  for (let trial = 0; trial < 300; trial++) {
    const clk = { t: 5_000_000 + trial * 30011 }
    const accs = Array.from({ length: 3 }, (_, i) => newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } }))
    const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) },
      { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
    pool.lastPick.set(accs[0].id, clk.t - 100_000)
    const last = new Map()
    for (let step = 0; step < 60; step++) {
      clk.t += Math.floor(Math.random() * 1800)
      const r = pool.pick(['s1', 's2', null][Math.floor(Math.random() * 3)])
      if (r.account) {
        issued++
        const p = last.get(r.account.id)
        if (p !== undefined) { const g = clk.t - p; minGap = Math.min(minGap, g); if (g < MIN) { violations++; worst = Math.min(worst, g); if (samples.length < 3) samples.push({ trial, step, id: r.account.id, gap: g }) } }
        last.set(r.account.id, clk.t)
        if (mutate && Math.random() < 0.6) pool.lastPick.set(accs[0].id, clk.t - 50_000)
      }
    }
  }
  return { mutate, issued, violations, worst: worst === Infinity ? 'Inf' : worst, minGap: minGap === Infinity ? 'Inf' : minGap, samples }
}
console.log(JSON.stringify([run(false), run(true)], null, 2))
