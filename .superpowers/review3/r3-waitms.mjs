// 性质 3 + 控制者 6 项复现（#4 waitMs 不低估；#2/#3 门；#5 affinity 清理；#6 公平性；#1 不变量已单独跑）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const out = []

// --- 性质 3：随机混合"窗内健康号 + 冷却号"，冷却剩余小于窗内等待 → waitMs >= 窗内等待
{
  let cases = 0, under = 0, badRetry = 0
  const samples = []
  for (let trial = 0; trial < 2000; trial++) {
    const t = 1_000_000
    const accs = []
    const nWin = 1 + Math.floor(Math.random() * 3)
    const nCool = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < nWin; i++) accs.push({ kind: 'win', id: `w${i}`, enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - Math.floor(Math.random() * (MIN - 1)), lastError: null } })
    for (let i = 0; i < nCool; i++) accs.push({ kind: 'cool', id: `c${i}`, enabled: true, cooldownUntil: t + 1 + Math.floor(Math.random() * (MIN - 1)), needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t, lastError: null } })
    const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
    for (const a of accs) if (a.stats.lastUsedAt > 0) pool.lastPick.set(a.id, a.stats.lastUsedAt)
    const r = pool.pick(null)
    cases++
    // 真实窗内等待 = 最晚过窗的历史号 (used+MIN - t)
    const trueWait = Math.max(...accs.filter((a) => a.stats.lastUsedAt > 0).map((a) => a.stats.lastUsedAt + MIN - t))
    if (r.account !== null) { samples.push({ note: 'unexpected issue', r }); continue }
    if (r.waitMs < trueWait) { under++; if (samples.length < 5) samples.push({ trial, waitMs: r.waitMs, trueWait }) }
  }
  out.push({ check: 'P3 waitMs not underestimated (win+cooling mix)', cases, underestimated: under, pass: under === 0, samples })
}

// --- 控制者 #4：窗内剩 2000 + 冷却剩 1000 → waitMs=2000
{
  const t = 1_000_000
  const accs = [
    { id: 'H', enabled: true, cooldownUntil: 0, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t, lastError: null } },
    { id: 'C', enabled: true, cooldownUntil: t + 1000, needsRelogin: false, noPackage: false, strikes: 0, stats: { requests: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: t - 10 * 60_000, lastError: null } },
  ]
  const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) }, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
  for (const a of accs) pool.lastPick.set(a.id, a.stats.lastUsedAt)
  const r = pool.pick(null)
  out.push({ check: "controller #4: window 2000 vs cooling 1000", waitMs: r.waitMs, expected: 2000, pass: r.waitMs === 2000 })
}

// --- 控制者 #5：status() 清理过期 affinity（5000 → 0）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3d-'))
  const store = new AccountStore(dir)
  await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'u' } }))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  clock.t += 100_000
  for (let i = 0; i < 5000; i++) pool.affinity.set(`s${i}`, { accountId: 'x', at: clock.t })
  clock.t += 2 * 60 * 60 * 1000
  pool.status()
  out.push({ check: 'controller #5: status() sweeps expired affinity', size: pool.affinity.size, expected: 0, pass: pool.affinity.size === 0 })
}

// --- 控制者 #6：时钟推进下轮询公平（10/10/10/10）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3e-'))
  const store = new AccountStore(dir)
  const accs = []
  for (let i = 0; i < 4; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } })))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  const counts = new Map(accs.map((a) => [a.id, 0]))
  for (let i = 0; i < 40; i++) {
    clock.t += 2000
    const r = pool.pick(null)
    if (r.account) counts.set(r.account.id, counts.get(r.account.id) + 1)
  }
  out.push({ check: 'controller #6: round-robin fairness (clock advancing)', counts: [...counts.values()], pass: new Set(counts.values()).size === 1 && [...counts.values()][0] === 10 })
}
console.log(JSON.stringify(out, null, 2))
