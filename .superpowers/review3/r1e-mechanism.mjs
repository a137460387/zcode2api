// 精确刻画：门条件用的是 lastUsed()（= max(this.lastPick, acc.stats.lastUsedAt)），
// 但 nextThrottleAt() 返回 Math.max(cooldownUntil, used>0 ? used+MIN : 0)。
//
// 关键：healthy() 要求 cooldownUntil <= now。若某号 cooldownUntil **>** lastUsed+MIN（即冷却晚于节流窗结束），
// 其 nextThrottleAt = cooldownUntil。健康时 cooldownUntil <= t，则 nextThrottleAt <= t → 不算 blocking。
// 这个方向是安全的（不挡门）。
//
// 那么 blocking 的号一定满足 nextThrottleAt > t。挑号时池 = fresh ∪ used，全部 blocking 为空 →
// 每个 used 号都满足 lastUsed + MIN <= t 或 cooldownUntil > t。**但 cooldownUntil > t 的号不健康，
// 进不了 used**。所以挑号候选里，每个历史号的 lastUsed + MIN <= t —— 发号不违反。
//
// 唯一旁路：候选里某号满足 nextThrottleAt <= t 但 lastUsed + MIN > t，即 cooldownUntil > t 且
// cooldownUntil >= ... 不，cooldownUntil > t 就不健康。
// 故：**数学上只要 lastUsed() 与 pick 用的是同一个函数，就不可能违反**。
//
// 让门失明的唯一输入 = 让门读到的 lastUsed 比实际小。本次实证的触发条件：
// 走 pick 之前，先让某号 lastPick 里的值"变小"（外部/持久化状态改变了池内账）。
// 而 lastUsed 取 max(内存, 磁盘)，因此**磁盘上没有**的更新会丢。
//
// 反向（真实且无需任何手工改写）：**磁盘 lastUsedAt 被别的进程/本进程的 markSuccess 写大，
// 内存账不变** → max 取磁盘 → 诚实。所以那条方向安全。
//
// 唯一剩下的真实方向：**磁盘 lastUsedAt 更大，但内存账被下次 stampUsed 覆盖成更小**？
// stampUsed 写的是 at = this.now()（单调不减），不会更小。除非**时钟回拨**（NTP/容器）
// 或**多进程池**：进程 P1 用 t=2000 记账，进程 P2 磁盘写入 t=3000，P1 内存账 2000，
// lastUsed=max(2000,3000)=3000 诚实。
// 亦即：单进程 + 单调时钟下，lastUsed() 不可能被低估 → 门不变量成立。
//
// 验证上面的结论：把时钟做成非单调（回拨），看是否会违反。这是"时钟回拨"这一真实运维场景。
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000

function run(clockMode) {
  let violations = 0, issued = 0, minGap = Infinity
  const samples = []
  for (let trial = 0; trial < 400; trial++) {
    let t = 1_000_000
    const accs = Array.from({ length: 3 }, (_, i) => newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } }))
    const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) },
      { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => t })
    const last = new Map()
    for (let step = 0; step < 60; step++) {
      if (clockMode === 'monotonic') t += Math.floor(Math.random() * 1800)
      else { // 'step': 时钟推进但步长偏小，模拟"每请求 1ms"真实节奏
        t += 1
        if (step % 7 === 0) t += 1500
      }
      const r = pool.pick(['s1', 's2', null][Math.floor(Math.random() * 3)])
      if (r.account) {
        issued++
        const p = last.get(r.account.id)
        if (p !== undefined) { const g = t - p; minGap = Math.min(minGap, g); if (g < MIN) { violations++; if (samples.length < 3) samples.push({ trial, step, id: r.account.id, gap: g }) } }
        last.set(r.account.id, t)
      }
    }
  }
  return { clockMode, issued, violations, minGap: minGap === Infinity ? 'Inf' : minGap, samples }
}
console.log(JSON.stringify([run('monotonic'), run('step')], null, 2))
