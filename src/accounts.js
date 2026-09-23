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

  /**
   * 该账号最近一次被使用的池内时刻：取**内存账与落盘值的较大者**。
   *
   * 不能用 `??`（内存优先）：内存账只会被本进程的 `stampUsed` 更新，而落盘值还会被
   * `markSuccess` 以及**别的进程**写。若内存里存着 1e6、磁盘上已是 1.01e6（例如本进程刚
   * `markSuccess` 过），`??` 会取到更旧的 1e6，于是 `readyAt` 算出 1002000 而非 1012000——
   * **提前 10s 放行**，方向恰好是放宽风控，不可接受。取 max 只会让节流更保守，不会更松。
   *
   * 返回 0 表示"本池从未见过这个号被使用"（`lastUsedAt` 初值即 0）。
   */
  lastUsed(acc) {
    return Math.max(this.lastPick.get(acc.id) ?? 0, acc.stats?.lastUsedAt ?? 0)
  }

  /**
   * 该账号下次可用时刻（池内时钟）。
   *
   * `used === 0` 表示"本池从未用过这个号"，此时**不能**返回 `0 + minIntervalMs`：
   * 那会把"从未用过"编码成一个恒在过去的绝对时刻（`2000`），对任何真实时钟都像"随时可用"，
   * 于是它永远插队到刚用过的号前面——正是连拍坍缩。故此时返回 `cooldownUntil` 本身，
   * 把"从未用过"与"刚用过在窗内"的区分交给 `pick()` 的两层选择，而不是在这里编造时刻。
   */
  readyAt(acc) {
    const used = this.lastUsed(acc)
    return Math.max(acc.cooldownUntil ?? 0, used > 0 ? used + this.minIntervalMs : 0)
  }

  /**
   * 选号。同步接口（`store.list()` 是同步读盘快照）。
   *
   * 返回形态：
   * - `{ account, waitMs }`：选中该号；`waitMs` 是**选中后**到它下次可用的建议等待，
   *   即 `readyAt(account) - now`。刚 `stampUsed` 过，故正常等于 `minIntervalMs`（节流窗开始）。
   * - `{ account: null, waitMs, reason }`：无号可用。**此时 `waitMs` 明确表示"最早的下一个
   *   可用账号还需等多久"（`min(readyAt) - now`）**——调用方必须按它等待后重试，不能立即再取：
   *   现在等了多久就拿不到号。注意 `waitMs` 在两种形态下语义不同（选中=建议节流间隔；
   *   未选中=真实剩余等待），调用方须先判 `account` 是否非空再解释它。
   *
   * 无号可用的三类 `reason`（互相独立、文案可读）：
   * - `'no accounts'` — 池为空；
   * - `'all accounts cooling down or disabled'` — 有不健康账号，但都被冷却/停用/需重登/无套餐挡住；
   * - `'all accounts within min interval (throttled)'` — **所有健康账号都还在 `minIntervalMs`
   *   节流窗内**（`waitMs` 给出最早剩余）。
   *
   * 第三类是本方法的风控语义核心：**没有"该号是否已过冷却窗"的门槛时，池内时钟不推进
   * （无 sessionKey、调用方不 sleep 或 sleep 不足）会让排序永远选中同一个"最早过期"的号。
   * 实测 4 账号 40 次连拍得 37,1,1,1、600 次得 9997,1,1,1——被压的恰是刚用过的那个号，
   * 正是 `minIntervalMs` 这道防线要防的场景。故全员在节流窗内时**拒绝发号**，把"多久能取到号"
   * 交回调用方（T15 网关据 `waitMs` 等待后重试），而不是让它超频压号。
   */
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
    /**
     * 两层选择，第一层区分"本池见过"与"从未用过"——这是连拍坍缩的根因所在。
     *
     * - **有使用历史的号**（`lastUsed > 0`）：受 `minIntervalMs` 约束，`readyAt = used + minIntervalMs`。
     * - **从未用过的号**（`lastUsed === 0`）：没有可节流的历史，随时可用（冷池必须能发号）。
     *
     * 只看 `readyAt` 排序是错的：历史号在窗内被夹到 `t + minIntervalMs`，而无历史号的 raw
     * `readyAt` 是 `0 + minIntervalMs`（恒在过去），于是无历史号永远"更早可用"、被反复插队，
     * 同一个刚用过的号也会被反复选中——正是实测 37,1,1,1 / 9997,1,1,1 的坍缩形态。
     * 故：**只要有历史号还在窗内，就先不发号**（哪怕还有从未用过的号），把 `waitMs` 交回调用方；
     * 窗内清空后，优先补偿节流窗已过的历史号（least-recently-used），最后才铺新号。
     */
    const used = healthy.filter((a) => this.lastUsed(a) > 0)
    const fresh = healthy.filter((a) => this.lastUsed(a) === 0)
    used.sort((a, b) => this.readyAt(a) - this.readyAt(b) || this.lastUsed(a) - this.lastUsed(b))
    if (used.length) {
      const earliest = used[0]
      const wait = Math.max(0, this.readyAt(earliest) - t)
      // 最早的**有历史**号仍在窗内 → 全员（含从未用过的）都不发号。
      if (wait > 0) return { account: null, waitMs: wait, reason: 'all accounts within min interval (throttled)' }
      /**
       * 窗内已清空，此时才轮到轮询。从未用过的号视为"最久未用"（`lastUsed = 0`），
       * 故与已过窗的历史号合并后按 least-recently-used 取号：既保证连拍后逐个换号，
       * 也保证新号不会被已用过的号长期压住。平秩用 `readyAt`（历史号在窗内早已排除，
       * 这里只可能是都已过窗）。
       */
      const pool2 = fresh.concat(used)
      pool2.sort((a, b) => this.lastUsed(a) - this.lastUsed(b) || this.readyAt(a) - this.readyAt(b))
      const chosen = pool2[0]
      if (sessionKey) this.affinity.set(sessionKey, { accountId: chosen.id, at: t })
      this.stampUsed(chosen.id, t)
      return { account: chosen, waitMs: Math.max(0, this.readyAt(chosen) - t) }
    }
    const chosen = fresh[0]
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
    const prev = this.lastPick.get(id)
    this.lastPick.set(id, at)
    // 热路径省写：若本次仍落在上一笔记账的节流窗内，`readyAt` 由那笔更早的时刻决定，
    // 落盘值不会改变任何 pick 结果（`lastUsed` 取 max，更早/相等都不占优）——直接跳过落盘，
    // 避免连拍/会话亲和下每次 pick 都同步写盘（实测旧实现 1000 次 pick = 335ms）。
    if (prev !== undefined && prev + this.minIntervalMs > at) return
    /**
     * 落盘失败**必须可见**：一条长期失败的写盘会让"别的进程/重启后看到的最后使用时间"
     * 悄悄停在旧值，进而放宽节流。旧实现 `.catch(() => {})` 把它完全吞掉，故障不可发现。
     */
    Promise.resolve(this.store.update(id, (cur) => (cur ? { stats: { ...cur.stats, lastUsedAt: at } } : null)))
      .catch((err) => console.warn(`[accounts] failed to persist lastUsedAt for ${id}: ${err?.message ?? err}`))
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
    const all = this.store.list()
    /**
     * 顺带回收内存账里已不存在的账号 id（账号删除后 `lastPick` 否则会无上限增长，
     * 实测删号后 size 仍为 60）。只清"磁盘上已没有"的键，不影响在场账号的节流状态。
     */
    const live = new Set(all.map((a) => a.id))
    for (const id of this.lastPick.keys()) if (!live.has(id)) this.lastPick.delete(id)
    return all.map((a) => ({
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
      /**
       * 警告：`stats.lastUsedAt` 与 `stats.lastError.at` 存的是**池内时钟值**
       * （与节流/`readyAt` 同轴，注入假时钟时不是真纪元毫秒）。看板层（T18）**不要**直接
       * `new Date(stats.lastUsedAt)` —— 会得到 1970 附近的时刻。需要人类可读时间时，
       * 由管理端用自己的真实时钟换算，或另存一份真实时间戳。
       */
      stats: a.stats,
    }))
  }
}
