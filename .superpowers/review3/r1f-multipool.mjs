// 真实运维场景：多池实例（T15 网关 + T18 看板各自持有 pool？或重启后新建池）
// 关键：stampUsed 落盘是异步的（不 await）。重建池后，内存账清空，只剩磁盘值。
// 而落盘"窗内省写"的条件是 prev !== undefined && prev + MIN > at → 只有当 prev 存在才省写。
// 若进程重启，新池 lastPick 为空 → prev undefined → 每次都落盘。所以重启后磁盘是诚实的最新值。
//
// 但**异步未落盘期间**（同一进程内立即新建池，磁盘还是旧值）→ 磁盘 lastUsedAt 落后于实际发号时刻。
// 复现：同一 store 下 pool1.pick() 发号（异步写盘在途），立刻用同一 store 新建 pool2 并 pick。
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const MIN = 2000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3-'))
const store = new AccountStore(dir)
const accs = []
for (let i = 0; i < 2; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } })))
const clock = { t: 1_000_000 }
const pool1 = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })

const r1 = pool1.pick(null)
console.log('pool1.pick ->', r1.account?.id, 't=', clock.t)

// 同一进程、同一 store，新建池（模拟"网关与另一组件各持一池"，或重建池）
const pool2 = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
const r2 = pool2.pick(null)   // 磁盘尚未落盘（stampUsed 未 await）
console.log('pool2.pick ->', r2.account?.id, '(磁盘 lastUsedAt =', store.get(r2.account.id)?.stats.lastUsedAt, ')')
console.log('VIOLATION (same account within 0ms)?', r2.account?.id === r1.account?.id && clock.t === clock.t)

// 再等一个微任务，让落盘完成，再次新建池
await new Promise((r) => setTimeout(r, 20))
console.log('after flush, disk lastUsedAt =', store.get(accs[0].id).stats.lastUsedAt)
const pool3 = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
const r3 = pool3.pick(null)
console.log('pool3.pick ->', r3.account?.id, 'waitMs', r3.waitMs, 'reason', r3.reason)
