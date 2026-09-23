// 独立验证 1：规模化 minIntervalMs 不变量（内存 store，200 组 × 40 步，池 2-6）
// 故意与实现者测试不同：池大小 2-6、健康号、pick(null)/pick(session) 混合、时钟随机推进 0~1500ms，
// 且统计"每一个账号"的相邻发号间隔。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'

const MIN = 2000
let totalIssued = 0
let violations = 0
let worst = Infinity
let minGapAny = Infinity
const details = []

for (let trial = 0; trial < 200; trial++) {
  const clk = { t: 1_000_000 + trial * 1000 }
  const n = 2 + Math.floor(Math.random() * 5) // 2-6
  const accs = Array.from({ length: n }, (_, i) => {
    const f = newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: `t${trial}u${i}` } })
    return f
  })
  const store = {
    list: () => accs,
    update: () => Promise.resolve(null),
  }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
  const last = new Map()
  const sessKeys = ['s1', 's2', 's3', null]
  for (let step = 0; step < 40; step++) {
    clk.t += Math.floor(Math.random() * 1501)
    const sk = sessKeys[Math.floor(Math.random() * sessKeys.length)]
    const r = pool.pick(sk)
    if (r.account) {
      totalIssued++
      const prev = last.get(r.account.id)
      if (prev !== undefined) {
        const gap = clk.t - prev
        if (gap < minGapAny) minGapAny = gap
        if (gap < MIN) {
          violations++
          if (gap < worst) worst = gap
          if (details.length < 5) details.push({ trial, step, id: r.account.id, gap, sk })
        }
      }
      last.set(r.account.id, clk.t)
    }
  }
}

console.log(JSON.stringify({
  trials: 200,
  stepsPerTrial: 40,
  totalIssued,
  violations,
  worstGapMs: worst === Infinity ? 'Infinity' : worst,
  minGapObservedMs: minGapAny === Infinity ? 'Infinity' : minGapAny,
  sampleViolations: details,
  pass: violations === 0,
}, null, 2))
process.exit(violations === 0 ? 0 : 1)
