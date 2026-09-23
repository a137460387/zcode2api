// 独立验证 1b：更大规模 + 对抗模式。目标 >=5000 次发号。
// 加入的对抗性输入（都是"上一轮 Critical 的触发条件"的变体）：
//  - 已过窗老号 + 刚用过号混合（存在"门被老号打开"的历史条件）
//  - 亲和绑定到窗内号
//  - 亲和绑定到已过窗号
//  - 时钟 0 推进 / 1ms 推进 / 大跳
//  - 池 1-8 号，其中部分是"从不使用"的新号
//  - 人工 bind() 把 session 绑到任意号
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'

const MIN = 2000
let totalIssued = 0
let violations = 0
let worst = Infinity
let minGapAny = Infinity
const samples = []
let minWaitMsUnder = 0

function mkPool(n, clk) {
  const accs = Array.from({ length: n }, (_, i) => newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: `u${i}` } }))
  const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) },
    { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
  return { accs, pool }
}

// 模式 A：纯随机（大头，保证发号量）
for (let trial = 0; trial < 700; trial++) {
  const clk = { t: 1_000_000 + trial * 7919 }
  const n = 2 + Math.floor(Math.random() * 7) // 2-8
  const { accs, pool } = mkPool(n, clk)
  const last = new Map()
  const sk = ['s1', 's2', 's3', null]
  for (let step = 0; step < 60; step++) {
    // 随机推进：含 0 推进（连拍）
    const roll = Math.random()
    if (roll < 0.15) { /* 0 推进 */ }
    else if (roll < 0.5) clk.t += Math.floor(Math.random() * 1501)
    else clk.t += Math.floor(Math.random() * 20001)
    // 随机人工改绑
    if (Math.random() < 0.1) pool.bind('s2', accs[Math.floor(Math.random() * accs.length)].id)
    const r = pool.pick(sk[Math.floor(Math.random() * sk.length)])
    if (r.account) {
      totalIssued++
      const prev = last.get(r.account.id)
      if (prev !== undefined) {
        const gap = clk.t - prev
        if (gap < minGapAny) minGapAny = gap
        if (gap < MIN) { violations++; worst = Math.min(worst, gap); if (samples.length < 6) samples.push({ mode: 'A', trial, step, id: r.account.id, gap }) }
      }
      last.set(r.account.id, clk.t)
    }
  }
}

// 模式 B：构造"已过窗老号 + 刚用过号 + 亲和绑定窗内号"的持续状态
for (let trial = 0; trial < 300; trial++) {
  const clk = { t: 5_000_000 + trial * 30011 }
  const { accs, pool } = mkPool(3, clk)
  const last = new Map()
  // 老号 A：很久前用过
  pool.lastPick.set(accs[0].id, clk.t - 100_000)
  for (let step = 0; step < 60; step++) {
    clk.t += Math.floor(Math.random() * 1800)
    const sk = ['s1', 's2', null][Math.floor(Math.random() * 3)]
    const r = pool.pick(sk)
    if (r.account) {
      totalIssued++
      const prev = last.get(r.account.id)
      if (prev !== undefined) {
        const gap = clk.t - prev
        if (gap < minGapAny) minGapAny = gap
        if (gap < MIN) { violations++; worst = Math.min(worst, gap); if (samples.length < 6) samples.push({ mode: 'B', trial, step, id: r.account.id, gap }) }
      }
      last.set(r.account.id, clk.t)
      // 60% 概率把 A 重新设为"已过窗老号"，维持"门可能被老号打开"的条件
      if (Math.random() < 0.6) pool.lastPick.set(accs[0].id, clk.t - 50_000)
    }
  }
}

// 模式 C：waitMs 是否低估（null 时按 waitMs 重试必须能拿到号）
for (let trial = 0; trial < 200; trial++) {
  const clk = { t: 9_000_000 + trial * 10007 }
  const { accs, pool } = mkPool(3, clk)
  pool.pick(null) // 记账让其进窗
  // 另一个号冷却，解禁早于节流窗（这是上一轮的低估触发条件）
  const other = accs.find((a) => !pool.lastPick.has(a.id))
  const cd = clk.t + 1000
  const store2 = { list: () => accs.map((a) => (a.id === other.id ? { ...a, cooldownUntil: cd } : a)), update: () => Promise.resolve(null) }
  const p2 = new AccountPool(store2, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
  p2.lastPick = new Map(pool.lastPick)
  const r = p2.pick(null)
  if (r.account === null && typeof r.waitMs === 'number') {
    const before = clk.t
    clk.t += r.waitMs
    const r2 = p2.pick(null)
    if (r2.account === null) { minWaitMsUnder++; if (samples.length < 8) samples.push({ mode: 'C', trial, waitMs: r.waitMs, retryReason: r2.reason }) }
  }
}

console.log(JSON.stringify({
  totalIssued,
  violations,
  worstGapMs: worst === Infinity ? 'Infinity' : worst,
  minGapObservedMs: minGapAny === Infinity ? 'Infinity' : minGapAny,
  waitMsUnderestimates: minWaitMsUnder,
  samples,
  pass: violations === 0 && minWaitMsUnder === 0,
}, null, 2))
process.exit(violations === 0 && minWaitMsUnder === 0 ? 0 : 1)
