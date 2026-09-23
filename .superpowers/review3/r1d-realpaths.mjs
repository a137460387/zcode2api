// 寻找真实触发路径（不做任何 lastPick 直接改写）：
// 1) markSuccess 把磁盘 lastUsedAt 设成"现在"，但内存账 lastPick 停留在更旧值？
//    lastUsed 取 max → 磁盘更新，诚实。反向：markSuccess 写磁盘为 now，而内存账更新（某号在 t 用过），
//    之后 clock 回退？时钟不会回退。
// 2) **AFFINITY_TTL 过期导致门条件与挑号条件分离**：不用动 lastPick。
// 3) **markSuccess 把 lastUsedAt 写到"当前 t"，而内存账 lastPick 已是未来**？
import { newAccountFields } from '../../src/auth/store.js'
import { AccountPool } from '../../src/accounts.js'
const MIN = 2000

// --- 2) 亲和 TTL 过期：绑定过期后 boundId=null，仍是同一门条件，应无违反。验证。
function ttlExpiry() {
  let violations = 0, issued = 0, minGap = Infinity
  for (let trial = 0; trial < 300; trial++) {
    const clk = { t: 1_000_000 + trial * 7777 }
    const accs = Array.from({ length: 3 }, (_, i) => newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } }))
    const pool = new AccountPool({ list: () => accs, update: () => Promise.resolve(null) },
      { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
    const last = new Map()
    for (let step = 0; step < 40; step++) {
      // 大量时间推进，越过 AFFINITY_TTL（2h）
      clk.t += Math.floor(Math.random() * 3_000_000)
      const r = pool.pick('s1')
      if (r.account) {
        issued++
        const p = last.get(r.account.id)
        if (p !== undefined) { const g = clk.t - p; minGap = Math.min(minGap, g); if (g < MIN) violations++ }
        last.set(r.account.id, clk.t)
      }
    }
  }
  return { name: 'affinityTTL-expiry', issued, violations, minGap: minGap === Infinity ? 'Inf' : minGap }
}

// --- 4) markSuccess 在"窗内"被调用（真实网关会这样做：请求成功即 markSuccess）
// markSuccess 用 this.now() 写 lastUsedAt，同时清 cooldown/strikes。
// 关注：markSuccess 只写磁盘，内存账 lastPick 里该号更旧 → lastUsed 取 max（磁盘的新）→ 诚实。
// 但若 markSuccess 发生在**另一个号**上且该号从未被 pick 过：磁盘 lastUsedAt=now，内存无 →
// 门会看到它是"历史号在窗内" → 挡全体。这是保守的，不违反。
async function markSuccessFlow() {
  let violations = 0, issued = 0, minGap = Infinity
  const samples = []
  for (let trial = 0; trial < 300; trial++) {
    const clk = { t: 1_000_000 + trial * 5555 }
    const accs = Array.from({ length: 3 }, (_, i) => newAccountFields({ provider: 'p', type: 'oauth', userInfo: { user_id: `u${i}` } }))
    let disk = new Map(accs.map((a) => [a.id, { ...a }]))
    const store = {
      list: () => [...disk.values()],
      update: (id, patch) => {
        const cur = disk.get(id)
        if (!cur) return Promise.resolve(null)
        const d = typeof patch === 'function' ? patch(cur) : patch
        const next = { ...cur, ...d }
        disk.set(id, next)
        return Promise.resolve(next)
      },
    }
    const pool = new AccountPool(store, { minIntervalMs: MIN, cooldown3012Ms: 30 * 60_000, now: () => clk.t })
    const last = new Map()
    for (let step = 0; step < 40; step++) {
      clk.t += Math.floor(Math.random() * 1800)
      const r = pool.pick(['s1', 's2', null][Math.floor(Math.random() * 3)])
      if (r.account) {
        issued++
        const p = last.get(r.account.id)
        if (p !== undefined) { const g = clk.t - p; minGap = Math.min(minGap, g); if (g < MIN) { violations++; if (samples.length < 3) samples.push({ trial, step, id: r.account.id, gap: g }) } }
        last.set(r.account.id, clk.t)
      }
      // 随机的真实网关行为：成功 / 失败
      if (Math.random() < 0.5) {
        const target = accs[Math.floor(Math.random() * accs.length)]
        await pool.markSuccess(disk.get(target.id))
      } else if (Math.random() < 0.3) {
        const target = accs[Math.floor(Math.random() * accs.length)]
        await pool.markError(disk.get(target.id), { status: 429, code: null })
      }
    }
  }
  return { name: 'markSuccess/markError flow', issued, violations, minGap: minGap === Infinity ? 'Inf' : minGap, samples }
}

const out = [ttlExpiry(), await markSuccessFlow()]
console.log(JSON.stringify(out, null, 2))
