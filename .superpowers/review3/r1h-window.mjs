// 精确刻画"多池实例共享 store"的绕过窗口大小（不手工改内部状态，纯用 async 落盘时序）。
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const MIN = 2000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3c-'))
const store = new AccountStore(dir)
const accs = []
for (let i = 0; i < 3; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } })))
const clock = { t: 1_000_000 }
const mk = () => new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })

// 网关形态 A：单实例（本轮实现的假设）
const pSingle = mk()
// 网关形态 B：每次请求新建池（若有代码这么写）或两个组件各持一池
let hits = 0
const N = 10
// 模拟"10 个并发请求同时刻到达，每个 handler 用一个共享 pool" —— 单实例
{
  const p = pSingle
  const got = []
  for (let i = 0; i < N; i++) got.push(p.pick(null).account?.id ?? null)
  console.log('single pool, 10 concurrent at same instant ->', got)
  const nonNull = got.filter(Boolean)
  hits = nonNull.length
}
// 双实例共享 store：实例 2 的内存账在实例 1 落盘完成前是空的
{
  const pA = mk()
  const pB = mk()
  const got = []
  for (let i = 0; i < N; i++) {
    const p = i % 2 === 0 ? pA : pB
    got.push(p.pick(null).account?.id ?? null)
  }
  console.log('two pools sharing store, 10 concurrent at same instant ->', got)
  console.log('  ->', got.filter(Boolean).length, 'issued (single-pool-expected 1)')
}
