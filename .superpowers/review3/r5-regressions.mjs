// 性质 7：回归
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000
const out = []
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3f-'))

// 7a 轮询公平（时钟推进）—— 控制者 #6 已跑，这里再看桶分布是否严格均匀（多次）
{
  let perfect = 0
  for (let trial = 0; trial < 50; trial++) {
    const store = new AccountStore(mkdir())
    const accs = []
    for (let i = 0; i < 4; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${trial}-${i}` } })))
    const clock = { t: 1_000_000 }
    const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
    const counts = new Map(accs.map((a) => [a.id, 0]))
    for (let i = 0; i < 40; i++) { clock.t += 2000; const r = pool.pick(null); if (r.account) counts.set(r.account.id, counts.get(r.account.id) + 1) }
    if ([...counts.values()].every((v) => v === 10)) perfect++
  }
  out.push({ check: 'P7a round-robin fairness 10/10/10/10 over 50 trials', perfectTrials: perfect, total: 50, pass: perfect === 50 })
}

// 7b recordUsage 并发 50 不丢
{
  const store = new AccountStore(mkdir())
  const a = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'ru' } }))
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => 1_000_000 })
  await Promise.all(Array.from({ length: 50 }, () => pool.recordUsage(a.id, { inputTokens: 1, outputTokens: 1 })))
  const s = store.get(a.id).stats
  out.push({ check: 'P7b recordUsage 50 concurrent', requests: s.requests, in: s.inputTokens, outTok: s.outputTokens, pass: s.requests === 50 && s.inputTokens === 50 && s.outputTokens === 50 })
}

// 7c strikes 累计（3012 五次 → enabled=false，第 3 次起 24h）+ 仅 markSuccess 清零
{
  const store = new AccountStore(mkdir())
  const a = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'st' } }))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  const grades = []
  for (let i = 1; i <= 5; i++) {
    clock.t += 60_000
    await pool.markError(store.get(a.id), { status: 405, code: 3012 })
    const cur = store.get(a.id)
    grades.push({ i, strikes: cur.strikes, cdMin: Math.round((cur.cooldownUntil - clock.t) / 60_000), enabled: cur.enabled })
  }
  // markSuccess 清零
  clock.t += 60_000
  await pool.markSuccess(store.get(a.id))
  const after = store.get(a.id)
  const expectGrades = grades[0]?.cdMin === 30 && grades[1]?.cdMin === 30 && grades[2]?.cdMin === 1440 && grades[3]?.cdMin === 1440 && grades[4]?.enabled === false
  out.push({ check: 'P7c strikes cumulative 3012', grades, afterMarkSuccess: { strikes: after.strikes, cooldownUntil: after.cooldownUntil, lastUsedAt: after.stats.lastUsedAt }, pass: expectGrades && after.strikes === 0 && after.cooldownUntil === 0 })
}

// 7d 429 → 60s；401 → needsRelogin；1113 → noPackage；429 与 3012 共用 strikes
{
  const store = new AccountStore(mkdir())
  const a = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'm1' } }))
  const b = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'm2' } }))
  const c = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'm3' } }))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  await pool.markError(store.get(a.id), { status: 401, code: null })
  await pool.markError(store.get(b.id), { status: 429, code: 1113 })
  await pool.markError(store.get(c.id), { status: 429, code: null })
  const shared = store.get(c.id)
  out.push({
    check: 'P7d marks', a: { needsRelogin: store.get(a.id).needsRelogin }, b: { noPackage: store.get(b.id).noPackage },
    c: { cooldownDelta: store.get(c.id).cooldownUntil - clock.t, strikesShared: shared.strikes },
    pass: store.get(a.id).needsRelogin === true && store.get(b.id).noPackage === true && store.get(c.id).cooldownUntil - clock.t === 60_000 && shared.strikes === 1,
  })
}

// 7e lastPick / affinity 清理
{
  const store = new AccountStore(mkdir())
  const a = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'x1' } }))
  const b = await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: 'x2' } }))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  pool.pick(null); clock.t += 2000; pool.pick(null)
  const sizeBefore = pool.lastPick.size
  const gone = a.id
  store.delete(gone)
  pool.status()
  for (let i = 0; i < 3000; i++) pool.affinity.set(`k${i}`, { accountId: b.id, at: clock.t })
  clock.t += 2 * 60 * 60 * 1000
  pool.status()
  out.push({ check: 'P7e lastPick + affinity sweeps', lastPickBefore: sizeBefore, lastPickHasGone: pool.lastPick.has(gone), affinityAfter: pool.affinity.size, pass: sizeBefore === 2 && pool.lastPick.has(gone) === false && pool.affinity.size === 0 })
}

// 7f 冷池首号立即可发
{
  const store = new AccountStore(mkdir())
  const accs = []
  for (let i = 0; i < 4; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `cold${i}` } })))
  const clock = { t: 1_000_000 }
  const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  const r = pool.pick(null)
  out.push({ check: 'P7f cold pool first pick issues immediately', account: r.account?.id ?? null, waitMs: r.waitMs, pass: r.account !== null })
}
console.log(JSON.stringify(out, null, 2))
console.log('ALL PASS:', out.every((o) => o.pass))
