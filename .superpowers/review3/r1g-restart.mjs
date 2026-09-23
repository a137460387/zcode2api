// 关键问题：单池实例（网关的真实部署形态）下，pick 是否同步可见？
// stampUsed 同步写 this.lastPick，故同一实例的后续 pick 立即可见。
// 但如果 stampUsed 的落盘未完成，而**同一实例**的内存账被 status() 清理？不会：清理只删 live 之外的 id。
//
// 因此需要验证的"真实绕过"是"多个 pool 实例共享一个 store"的窗口。
// 但即使单实例，还有一个真实路径：**账号被删除后重建同 id**？不现实。
//
// 更重要：**重启/进程崩溃后**，内存账丢失 → 磁盘是唯一来源。检查磁盘值是否诚实。
// 单独看 stampUsed 的"窗内省写"：
//   prev !== undefined && prev + MIN > at → return（跳过落盘）
// 这意味着：若上一次的落盘已经把 disk 写成 prev（prev 在磁盘上），本次 at 更晚但仍在窗内，跳过落盘。
// 磁盘上仍是 prev → 比 at 更早 → 重启后 lastUsed = prev，比真实最后使用时刻 at 更早。
// 差距最大 = MIN - 1。即"重启后最多提前一个 MIN 窗放行"。
// 这是**设计上的取舍**（落盘只是"跨进程/重启后的持久记录"），但重启后确实会让严格不变量放宽到一个窗。
//
// 复现（这是真实的运维事件，不是手工改内部状态）：
//   1. 同一 store 建 pool1，clock=t0，pick → 号 A 落盘 lastUsedAt=t0（prev 未定义 → 落盘）
//   2. clock=t0+100，再 pick → A 仍在窗内? A 是唯一号 → 门挡，不发号。需要多号。
//   3. 更真实的形态：3 个号，t0 发 A（落盘 t0），t0+1 发 B（落盘 t0+1），...
//      A 的下一次发号在 t0+2000 → 此时 A 的 prev 落盘时刻 t0，at=t0+2000，
//      prev+MIN = t0+2000 > at? 否（相等不满足严格 >）→ 落盘 at=t0+2000。诚实。
//   4. 要让磁盘落后，需要在"窗内"重复使用同一号——但门本身禁止窗内重复使用！
//      **故在门生效的前提下，落盘省写永远不会触发到"磁盘落后于真实使用"**
//      （省写条件 prev+MIN>at 恰好等价于"距上次落盘不足一个窗"，而门禁止窗内再次发同一号）。
//      → 结论：磁盘值诚实，重启后不变量仍成立（最多差一个 MIN 的边界）。
//
// 验证：上面推理要求"门禁止窗内重复发号"。既然我已证明单实例下门成立，则落盘值也诚实。
// 用真实 AccountStore 做端到端：反复 pick，然后把池"重启"（新建实例、清内存），
// 检查是否违反不变量。
import { AccountStore, newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const MIN = 2000

let violations = 0, issued = 0, minGap = Infinity
const samples = []
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-r3b-'))
const store = new AccountStore(dir)
const accs = []
for (let i = 0; i < 4; i++) accs.push(await store.save(newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } })))
const clock = { t: 1_000_000 }
let pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
const last = new Map()
for (let step = 0; step < 400; step++) {
  clock.t += Math.floor(Math.random() * 1200)
  const r = pool.pick(['s1', 's2', null][Math.floor(Math.random() * 3)])
  if (r.account) {
    issued++
    const p = last.get(r.account.id)
    if (p !== undefined) { const g = clock.t - p; minGap = Math.min(minGap, g); if (g < MIN) { violations++; if (samples.length < 4) samples.push({ step, id: r.account.id, gap: g }) } }
    last.set(r.account.id, clock.t)
  }
  // 每 37 步"重启"池：新实例，内存账=空，只剩磁盘（同时等待落盘完成）
  if (step % 37 === 36) {
    await new Promise((res) => setTimeout(res, 5))
    pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clock.t })
  }
}
console.log(JSON.stringify({ scenario: 'restart every 37 steps (real AccountStore)', issued, violations, minGap: minGap === Infinity ? 'Inf' : minGap, samples }, null, 2))
