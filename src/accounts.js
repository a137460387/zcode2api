const AFFINITY_TTL = 2 * 60 * 60 * 1000

export class AccountPool {
  constructor(store, { minIntervalMs = 2000, cooldown3012Ms = 30 * 60_000, now = Date.now } = {}) {
    this.store = store
    this.minIntervalMs = minIntervalMs
    this.cooldown3012Ms = cooldown3012Ms
    this.now = now
    this.affinity = new Map()
    /**
     * 进程内"刚被本池选中"的同步记账（id → 池内时刻）。
     *
     * `pick` 是同步接口，只能同步读 `store.list()` 的快照；而落盘（`store.update`）
     * 要过一个微任务才可见（实测：调用后立即读仍是旧值，`await null` 后才是新值）。
     * 只把 `lastUsedAt` 写到账号上，紧接着的下一次 `pick` 仍会看到"所有号都没用过"，
     * 于是反复选中同一个号、`waitMs` 恒为 0。故在选号当下**同步**记一笔供 `pick` 使用；
     * 落盘的 `lastUsedAt` 只作跨进程/重启后的持久记录。
     */
    this.lastPick = new Map()
  }

  healthy(acc) {
    return acc.enabled !== false
      && acc.needsRelogin !== true
      && acc.noPackage !== true
      && (acc.cooldownUntil ?? 0) <= this.now()
  }

  /** 该账号最近一次被使用的池内时刻：内存记账优先，回落落盘值（别的进程写的历史仍算数）。 */
  lastUsed(acc) {
    return this.lastPick.get(acc.id) ?? acc.stats?.lastUsedAt ?? 0
  }

  readyAt(acc) {
    return Math.max(acc.cooldownUntil ?? 0, this.lastUsed(acc) + this.minIntervalMs)
  }

  pick(sessionKey) {
    const t = this.now()
    const all = this.store.list()
    if (sessionKey) {
      const hit = this.affinity.get(sessionKey)
      if (hit && t - hit.at < AFFINITY_TTL) {
        const acc = all.find((a) => a.id === hit.accountId)
        if (acc && this.healthy(acc)) {
          this.stampUsed(acc.id, t)
          return { account: acc, waitMs: Math.max(0, this.readyAt(acc) - t) }
        }
      }
    }
    const healthy = all.filter((a) => this.healthy(a))
    if (!healthy.length) {
      return { account: null, waitMs: 0, reason: all.length ? 'all accounts cooling down or disabled' : 'no accounts' }
    }
    healthy.sort((a, b) => this.readyAt(a) - this.readyAt(b) || this.lastUsed(a) - this.lastUsed(b))
    const chosen = healthy[0]
    if (sessionKey) this.affinity.set(sessionKey, { accountId: chosen.id, at: t })
    this.stampUsed(chosen.id, t)
    return { account: chosen, waitMs: Math.max(0, this.readyAt(chosen) - t) }
  }

  /**
   * 记录"这个号刚被选中/用过"：先同步写内存（下一次 `pick` 立刻可见），再异步落盘。
   *
   * 不记账就无法轮询、也无法如实给出 `waitMs`——全新池里所有账号的 `readyAt` 恒等，
   * 排序会退化为"永远返回 `list()` 首个"，`minIntervalMs` 这道风控防线形同虚设。
   *
   * 写的是**传入的池内时刻**（而非 `Date.now()`），与 `markSuccess` 及 `readyAt` 的比较
   * 基准共用同一条时间轴；注入假时钟时混用真实纪元会让两者相差数十年。
   *
   * 落盘走 `store.update` 的**函数式 patch**（Task 3：修改已有账号的唯一安全方式），
   * 并发不丢更新。不 `await`：`pick` 是同步接口，只投递一次安全的写入。
   */
  stampUsed(id, at = this.now()) {
    this.lastPick.set(id, at)
    Promise.resolve(this.store.update(id, (cur) => (cur ? { stats: { ...cur.stats, lastUsedAt: at } } : null)))
      .catch(() => {})
  }

  bind(sessionKey, accountId) {
    if (sessionKey) this.affinity.set(sessionKey, { accountId, at: this.now() })
  }

  markSuccess(account) {
    return this.store.update(account.id, (cur) => ({
      cooldownUntil: 0,
      strikes: 0,
      stats: { ...cur.stats, lastUsedAt: this.now() },
    }))
  }

  markError(account, { status, code }) {
    return this.store.update(account.id, (cur) => {
      const a = cur ?? account
      const stats = { ...a.stats, lastError: { status, code, at: this.now() } }
      if (status === 401) return { needsRelogin: true, stats }
      if (code === 1113) return { noPackage: true, stats }
      if (code === 3012 || (status === 429 && code !== 1113)) {
        /**
         * strikes 是**累计**风控次数（不清零、按 24h 窗口回退），不是"当前窗口内的计数"：
         * 第 3 次起冷却 24h，第 5 次停用。故 24h 跳变只会让第 4、5 次继续累加，
         * 不会让计数重置——`markSuccess` 才是唯一的清零入口。
         */
        const strikes = (a.strikes ?? 0) + 1
        const patch = { strikes, stats }
        if (strikes >= 5) patch.enabled = false
        else if (code === 3012) {
          patch.cooldownUntil = this.now() + (strikes >= 3 ? 24 * 60 * 60_000 : this.cooldown3012Ms)
        } else {
          patch.cooldownUntil = this.now() + 60_000
        }
        return patch
      }
      return { stats }
    })
  }

  /** 并发安全：在临界区内读当前 stats 再自增（不可在临界区外算增量）。 */
  recordUsage(accountId, { inputTokens = 0, outputTokens = 0 } = {}) {
    return this.store.update(accountId, (cur) => {
      if (!cur) return null
      return {
        stats: {
          ...cur.stats,
          requests: (cur.stats?.requests ?? 0) + 1,
          inputTokens: (cur.stats?.inputTokens ?? 0) + inputTokens,
          outputTokens: (cur.stats?.outputTokens ?? 0) + outputTokens,
        },
      }
    })
  }

  status() {
    const t = this.now()
    return this.store.list().map((a) => ({
      id: a.id,
      provider: a.provider,
      type: a.type,
      enabled: a.enabled !== false,
      needsRelogin: a.needsRelogin === true,
      noPackage: a.noPackage === true,
      cooldownRemainMs: Math.max(0, (a.cooldownUntil ?? 0) - t),
      email: a.userInfo?.email ?? null,
      name: a.userInfo?.name ?? null,
      planCache: a.planCache ?? null,
      stats: a.stats,
    }))
  }
}
