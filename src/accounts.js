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
      && acc.invalidKey !== true
      && (acc.cooldownUntil ?? 0) <= this.now()
  }

  /**
   * 该账号最近一次被使用的池内时刻：取**内存账与落盘值的较大者**。
   *
   * 不能用 `??`（内存优先）：内存账只会被本进程的 `stampUsed` 更新，而落盘值还会被
   * `markSuccess` 以及**别的进程**写。若内存里存着 1e6、磁盘上已是 1.01e6（例如本进程刚
   * `markSuccess` 过），`??` 会取到更旧的 1e6，于是 `nextThrottleAt` 算出 1002000 而非 1012000——
   * **提前 10s 放行**，方向恰好是放宽风控，不可接受。取 max 只会让节流更保守，不会更松。
   *
   * 返回 0 表示"本池从未见过这个号被使用"（`lastUsedAt` 初值即 0）。
   */
  lastUsed(acc) {
    return Math.max(this.lastPick.get(acc.id) ?? 0, acc.stats?.lastUsedAt ?? 0)
  }

  /**
   * 该账号的下一个节流解禁时刻（池内时钟）。
   *
   * `used === 0` 表示"本池从未用过这个号"，此时**不能**返回 `0 + minIntervalMs`：
   * 那会把"从未用过"编码成一个恒在过去的绝对时刻（`2000`），对任何真实时钟都像"随时可用"，
   * 于是它永远插队到刚用过的号前面——正是连拍坍缩。故此时返回 `cooldownUntil` 本身，
   * 把"从未用过"与"刚用过在窗内"的区分交给 `pick()` 的两层选择，而不是在这里编造时刻。
   *
   * 注意：它**不是**"下次可用时刻"。从未用过的号 `nextThrottleAt` 恒为 0（看起来随时可用），
   * 它是否真的能发号由 `pick()` 的"有历史号仍在窗内则一律不发号"这一层决定。真实剩余等待
   * 请用 `earliestWaitMs()`，不要自己拿这个值减 `now`。
   */
  nextThrottleAt(acc) {
    const used = this.lastUsed(acc)
    return Math.max(acc.cooldownUntil ?? 0, used > 0 ? used + this.minIntervalMs : 0)
  }

  /**
   * 全池"最早多久之后会有账号可用"（池内时钟差）；**没有可自愈的账号时返回 `null`**。
   *
   * 三种返回值，对应调用方三种处置：
   * - `null` — 池为空，或所有账号都不是"等一等就好"：被停用（`enabled=false`，含累计 5 次风控
   *   被动停用）/ `needsRelogin`（401，要人重登）/ `noPackage`（1113，要人开套餐）。这些状态
   *   **不会随时间自愈**，等待是无意义的。调用方必须停止重试并暴露需人工干预的信号
   *   （T15：直接 503 + 告警，不能按 `waitMs` 空转重试）。
   * - `0` — 此刻就有健康账号可用（全员都不受节流/冷却约束）。
   * - `> 0` — 真实剩余等待：**按 `pick()` 实际会走的顺序算**，而不是逐个账号取最小。
   *   - 若存在**窗内的健康历史号** → 取它们中**最晚**的过窗时刻（`max(lastUsed) + minIntervalMs - t`）。
   *     `pick()` 的门要求"任何窗内历史号都清空"才发号，故要等最晚那个，不是最早那个。
   *     此时**不得**与更早的冷却解禁时刻取 min（见下）。
   *   - 否则（健康号里已无窗内历史号）→ 若存在从未用过的健康号则为 0（它们会立刻被放行）；
   *     没有健康号可发时取**可自愈账号**里最早的"既过冷却、又已出节流窗"的时刻。
   *
   * 阈值一律只取"窗内历史号最早过窗"，**不与冷却解禁取 min、也不取 max**：
   * 冷却号既不健康、也就不参与 `pick()` 的 `used`/`fresh` 门（`healthy()` 已把
   * `cooldownUntil > t` 排除），它早解禁既不能提前发号（窗内历史号仍挡门）、也不能推迟发号
   * （窗内历史号一过窗，健康号立刻可发，与冷却号无关）。把它并进来无论 min 还是 max 都是错。
   *
   * **为什么"窗内历史号"优先且不与冷却取 min（修复轮 3 定案）**：`pick()` 的门是"只要存在
   * 任何窗内的历史号就全体不发号"。因此当健康号仍在窗内时，哪怕某个冷却号更早解禁，
   * 那个时刻也**拿不到号**——`pick()` 会被节流门挡住。把 `waitMs` 与冷却解禁取 min 会报出一个
   * 派不上用场的更小值，调用方按它等待后重试仍拿不到号，白白空转一次 round-trip（实测低估
   * 1000ms：健康号窗内剩 2000ms + 另一号冷却剩 1000ms 时旧实现报 1000ms）。
   *
   * 关键：**不能对所有账号取 `nextThrottleAt` 最小值再归零**。从未用过的号 `nextThrottleAt` 恒为 0
   * 却既不是"已过窗的历史号"也不是"随时可发的新号"（历史号还在窗内时它不放行），把它当 0
   * 会把等待谎报成 0；反过来，对已过窗的历史号直接取 `lastUsed + minIntervalMs - t` 又会得到负数，
   * 负数参与 `Math.min` 同样把结果压成 0——两种错法都会让 `waitMs` 变 0，调用方按 0 等待即空转重试。
   */
  earliestWaitMs(all) {
    const t = this.now()
    const selfHealing = all.filter(
      (a) => a.enabled !== false && a.needsRelogin !== true && a.noPackage !== true,
    )
    if (!selfHealing.length) return null
    /**
     * 与 `pick()` 的节流门**用同一个判定**：`blocking` = 健康（`healthy()` 已含冷却窗口）
     * 且 `lastUsed > 0` 且仍在自己窗内的账号。只要它非空，`pick()` 就一律不发号，
     * 故真实等待是**最后一个窗内历史号过窗**的时刻——`pick()` 要求"任何"窗内历史号都清空。
     *
     * 冷却中的账号此刻不在门里（`healthy()` 排除它），但它**解禁后会立刻成为新的 blocking 号**
     * （若其 `lastUsed` 仍在窗内）。故它对"何时真的能发号"的贡献不是 `cooldownUntil`，
     * 而是 `max(cooldownUntil, lastUsed + minIntervalMs)`——两个约束都满足才发得出号。
     * 只按 `cooldownUntil` 报等待会让调用方按一个拿不到号的时刻重试，白白空转一次 round-trip。
     */
    const healthyAccs = all.filter((a) => this.healthy(a))
    let blockingEnd = 0
    for (const a of healthyAccs) {
      const used = this.lastUsed(a)
      if (used > 0) blockingEnd = Math.max(blockingEnd, used + this.minIntervalMs)
    }
    if (blockingEnd > t) return Math.max(0, blockingEnd - t)
    // 健康号里已无窗内历史号：从未用过的号立刻能被放行；否则等最早的可自愈冷却解禁
    if (healthyAccs.some((a) => this.lastUsed(a) === 0)) return 0
    // 已过窗的历史健康号此刻即可发号（`blockingEnd <= t` 且它不在冷却中）→ 不需等待
    const passedWindow = healthyAccs.some((a) => this.lastUsed(a) > 0)
    if (passedWindow) return 0
    // 没有任何可发的健康号：等最早"既过冷却、又出节流窗"的可自愈账号；没有则须人工干预
    let earliestUsable = Infinity
    for (const a of selfHealing) {
      const cd = a.cooldownUntil ?? 0
      if (cd <= t) continue
      const used = this.lastUsed(a)
      const throttledTo = used > 0 ? used + this.minIntervalMs : 0
      earliestUsable = Math.min(earliestUsable, Math.max(cd, throttledTo))
    }
    if (earliestUsable === Infinity) return null
    return Math.max(0, earliestUsable - t)
  }

  /**
   * 选号。同步接口（`store.list()` 是同步读盘快照）。
   *
   * 返回形态：
   * - `{ account, waitMs }`：选中该号；`waitMs` 是**选中后**到它下次可用的建议等待，
   *   即 `nextThrottleAt(account) - now`。刚 `stampUsed` 过，故正常等于 `minIntervalMs`（节流窗开始）。
   * - `{ account: null, waitMs, reason }`：无号可用。**此时 `waitMs` 明确表示"最早的下一个
   *   可用账号还需等多久"（`earliestWaitMs()`）**——调用方必须按它等待后重试，不能立即再取：
   *   现在等了多久就拿不到号。注意 `waitMs` 在两种形态下语义不同（选中=建议节流间隔；
   *   未选中=真实剩余等待），调用方须先判 `account` 是否非空再解释它。
   *   特别地，**`waitMs === null` 表示"没有可自愈的等待"**：账号全被停用/需重登/无套餐
   *   （含池为空），须人工干预。调用方**不得**把它当 `0` 处理（会变成无意义的重试循环，
   *   且旧实现正是硬编码 `0`，实测 3 号各冷却 30min 时每请求都立即失败）。
   *
   * 无号可用的三类 `reason`（互相独立、文案可读）：
   * - `'no accounts'` — 池为空；
   * - `'all accounts cooling down or disabled'` — 有不健康账号，但都被冷却/停用/需重登/无套餐挡住
   *   （可能还叠加节流）。`waitMs` 为 `null` 当且仅当**没有一个**账号是"等一等就好"的。
   *   此时额外带 `warn: 'human action required'` 作为可判别的显式信号（`reason` 文案保持不变，
   *   以免破坏 T15/T17 对 `'cooling'` 的既有断言）。
   * - `'all accounts within min interval (throttled)'` — **所有健康账号都还在 `minIntervalMs`
   *   节流窗内**（`waitMs` 给出最早剩余，恒为 `> 0`，绝不为 `null`：节流会自愈）。
   *
   * 第三类是本方法的风控语义核心：**没有"该号是否已过冷却窗"的门槛时，池内时钟不推进
   * （无 sessionKey、调用方不 sleep 或 sleep 不足）会让排序永远选中同一个"最早过期"的号。
   * 实测 4 账号 40 次连拍得 37,1,1,1、600 次得 9997,1,1,1——被压的恰是刚用过的那个号，
   * 正是 `minIntervalMs` 这道防线要防的场景。故全员在节流窗内时**拒绝发号**，把"多久能取到号"
   * 交回调用方（T15 网关据 `waitMs` 等待后重试），而不是让它超频压号。
   *
   * **会话亲和与节流的关系（修复轮 2 定案）**：`sessionKey` 直接来自客户端可任意设置的
   * `x-session-id` 请求头，因此"带同一个 header + 客户端不节流连发"绝不能绕过 `minIntervalMs`
   * （实测旧实现同一 sessionKey 连拍 200 次得 200/200 全落同一个号）。定案的语义是
   * **"先决定能不能发号，再让亲和决定发给谁"**：
   *
   * 1. **能不能发号**完全由与非亲和路径相同的两层门决定（历史号仍在窗内 → 一律不发号；
   *    窗内清空后才允许在"有历史的号 / 从未用过的号"里挑）。亲和分支**不**自行 `return`，
   *    旧实现正是在那里直接发号，才让 header 成了绕过节流的口子。
   * 2. **发给谁**才轮到亲和：绑定号若落在本次可发候选里就发它（会话粘性）。
   *
   * 由此得出"亲和号被节流时"的行为（本题要求的设计选择）：**既不硬等它，也不换号——而是
   * 全体不发号**，返回 `{account:null, waitMs:真实剩余, reason:'throttled'}`，由调用方等
   * `waitMs` 后重试；重试时绑定号已过窗，**依旧是它**，会话一致性得以保持。
   * 选择理由：`pick` 是同步接口，要在池层"等待亲和号"只能阻塞或返回一个没有语义的号，
   * 前者会把窗内阻塞放大成会话级吞吐瓶颈、后者直接违背风控；而"等 `waitMs` 再重试"本就是
   * 非亲和路径既有的契约（调用方已在做），亲和路径复用它即可，行为统一、无特例。
   * **真正换号回落只发生在绑定号变得不健康（冷却/停用/需重登/无套餐）或亲和绑定过期时**——
   * 那时"等下去也不会是它"，才改写绑定给别的号。两种情形因此不混淆：
   * "稍等一会就好"（throttled，正 `waitMs`）vs "这个号真的不能用了"（改绑回落）。
   * 无论哪种，都**不绕过 `minIntervalMs`**：发出的号一定已过窗、且同样被 `stampUsed` 记账。
   *
   * 调用方契约（T15 网关，修复轮 2 明确）：**`account` 为 null 时，若 `waitMs` 是有限正数
   * 必须 `await` 它之后再重试；若 `waitMs === null` 必须停止重试并返回需人工干预的错误。**
   * 冷启动尖峰同理由调用方吸收：4 号冷池 10 并发时只有 1 个请求拿到号，其余 9 个会拿到
   * `waitMs = minIntervalMs` 并应等待后重试（实测冷池 10 并发为 1 + 9×waitMs=2000，非失败）。
   * 池层**不**为此放开"冷池允许多个新号同时在途"——那会让同一个上游在同一个 `minIntervalMs`
   * 窗口内被两个新号并发打（新号打上游同样是高频），并使节流防线在不同账号间失去统一性。
   */
  pick(sessionKey) {
    const t = this.now()
    const all = this.store.list()
    // 本会话的亲和绑定（若未过期）：只用于"挑谁"，不用于"能不能挑"——见下方注释。
    const boundId = (() => {
      if (!sessionKey) return null
      const hit = this.affinity.get(sessionKey)
      return hit && t - hit.at < AFFINITY_TTL ? hit.accountId : null
    })()
    const healthy = all.filter((a) => this.healthy(a))
    if (!healthy.length) {
      const waitMs = this.earliestWaitMs(all)
      return {
        account: null,
        waitMs,
        reason: all.length ? 'all accounts cooling down or disabled' : 'no accounts',
        // waitMs 为 null = 等不来（停用/需重登/无套餐），显式区别于"等一会儿就好"。
        ...(waitMs === null ? { warn: 'human action required' } : {}),
      }
    }
    /**
     * 会话亲和：**先算"现在到底能不能发号"，再让绑定只决定"发给谁"**。
     *
     * 关键顺序（修复轮 2 踩到的坑）：不能在亲和分支里直接 `return`，哪怕那里也查了节流窗。
     * `nextThrottleAt(acc) <= t` 在"刚到点还没被记账"时成立，于是亲和分支会把**刚用过的那个号**
     * 原样再发一次（实测：同一 sessionKey 在 t 与 t+2000 各 pick 一次，两次都返回同一个号）；
     * 会话亲和必须**先过与非亲和路径完全相同的两层门**（历史号窗内一律不发号；窗内清空后
     * 才允许在"有历史的号 / 从未用过的号"里挑），亲和只影响"挑谁"，不影响"能不能挑"。
     */
    /**
     * 两层选择，第一层区分"本池见过"与"从未用过"——这是连拍坍缩的根因所在。
     *
     * - **有使用历史的号**：受 `minIntervalMs` 约束，`nextThrottleAt = lastUsed + minIntervalMs`。
     * - **从未用过的号**（`lastUsed === 0`）：没有可节流的历史，随时可用（冷池必须能发号）。
     *
     * 只看 `nextThrottleAt` 排序是错的：历史号在窗内被夹到 `t + minIntervalMs`，而无历史号的
     * `nextThrottleAt` 是 0（恒在过去），于是无历史号永远"更早可用"、被反复插队，
     * 同一个刚用过的号也会被反复选中——正是实测 37,1,1,1 / 9997,1,1,1 的坍缩形态。
     * 故：**只要有历史号还在窗内，就先不发号**（哪怕还有从未用过的号），把 `waitMs` 交回调用方；
     * 窗内清空后，优先补偿节流窗已过的历史号（least-recently-used），最后才铺新号。
     *
     * **门必须对全体历史号生效（修复轮 3 定案，Critical）**：修复轮 2 里门只看"按
     * `nextThrottleAt` 排序后的 `used[0]`"，只在它的 `wait > 0` 时才挡全体。但 `nextThrottleAt`
     * 序与挑号用的 `lastUsed` 序**在数学上不同**：池中只要有一个"早已过窗"的号（它必然是
     * `nextThrottleAt` 最小者），`used[0]` 就永远是它、`wait` 永远是 0 → 门被打开；随后挑号按
     * `lastUsed` 升序（或亲和绑定优先）完全可以选中**另一个仍在窗内的号**，于是它在距上次使用
     * 仅 1ms 时又被发出。随机序列实测违反率 43%（最小同号间隔 1ms）——门与挑号基于两套不一致的
     * 排序，正是"常见情况正确"而非不变量的根源。
     *
     * 正解：门与挑号必须基于**同一个条件**——"是否存在仍在自己窗内的历史号"。门改用
     * `blocking = all.filter(a => a.lastUsed(a) > 0 && nextThrottleAt(a) > t)`，只要它非空就
     * 一律不发号，`waitMs` 取 `earliestWaitMs()`（全体窗内健康历史号中**最晚**过窗者的剩余）。
     * 于是排序不再影响"能不能发"——只有当**没有任何历史号在窗内**时才进入挑号，此时 `pool2`
     * 里所有历史号都已过窗，亲和在其中挑谁都不违反 `minIntervalMs`。
     */
    const used = healthy.filter((a) => this.lastUsed(a) > 0)
    const fresh = healthy.filter((a) => this.lastUsed(a) === 0)
    /**
     * 节流门：**全体历史号**中仍有任何一个在窗内 → 全体不发号（含从未用过的号与亲和号）。
     * 这里刻意不按 `used[0]` 判定，也不再按排序结果判定——见上方说明。
     */
    const blocking = used.filter((a) => this.nextThrottleAt(a) > t)
    if (blocking.length) {
      return {
        account: null,
        waitMs: this.earliestWaitMs(all),
        reason: 'all accounts within min interval (throttled)',
      }
    }
    if (used.length) {
      /**
       * 窗内已清空（`blocking` 为空），此时才轮到轮询。从未用过的号视为"最久未用"
       * （`lastUsed = 0`），故与已过窗的历史号合并后按 least-recently-used 取号：既保证连拍后
       * 逐个换号，也保证新号不会被已用过的号长期压住。平秩用 `nextThrottleAt`（历史号在窗内
       * 早已被挡下，这里只可能是都已过窗）。
       */
      const pool2 = fresh.concat(used)
      pool2.sort((a, b) => this.lastUsed(a) - this.lastUsed(b) || this.nextThrottleAt(a) - this.nextThrottleAt(b))
      /**
       * 亲和绑定在**轮到挑谁**时优先：只要绑定号落在本次候选（即它已过窗、或它是从未用过的号），
       * 就发它，保证会话粘性。它若还在节流窗内，根本进不了这里——上面的 `blocking` 门已经
       * 把"还有历史号在窗内"的全体挡下（返回 null + 真实 waitMs），所以本行不可能发出窗内的号。
       *
       * 注意与"回落"的分工：绑定号在窗内时不是"换给它"，而是**全体不发号**（含它自己也拿不到），
       * 于是调用方等 `waitMs` 后重试，下一次它已过窗、依旧是它——会话一致性得以保持；
       * 只有当绑定号变得**不健康**（冷却/停用/需重登/无套餐）或亲和过期时，才会真正换号回落。
       */
      const chosen = (boundId && pool2.find((a) => a.id === boundId)) || pool2[0]
      if (sessionKey) this.affinity.set(sessionKey, { accountId: chosen.id, at: t })
      this.stampUsed(chosen.id, t)
      return { account: chosen, waitMs: Math.max(0, this.nextThrottleAt(chosen) - t) }
    }
    const chosen = (boundId && fresh.find((a) => a.id === boundId)) || fresh[0]
    if (sessionKey) this.affinity.set(sessionKey, { accountId: chosen.id, at: t })
    this.stampUsed(chosen.id, t)
    return { account: chosen, waitMs: Math.max(0, this.nextThrottleAt(chosen) - t) }
  }

  /**
   * 记录"这个号刚被选中/用过"：先同步写内存（下一次 `pick` 立刻可见），再异步落盘。
   *
   * 不记账就无法轮询、也无法如实给出 `waitMs`——全新池里所有账号的 `nextThrottleAt` 恒等，
   * 排序会退化为"永远返回 `list()` 首个"，`minIntervalMs` 这道风控防线形同虚设。
   *
   * 写的是**传入的池内时刻**（而非 `Date.now()`），与 `markSuccess` 及 `nextThrottleAt` 的比较
   * 基准共用同一条时间轴；注入假时钟时混用真实纪元会让两者相差数十年。`nextThrottleAt` /
   * `earliestWaitMs` 里的消息文案与比较也都以这条轴为准。
   *
   * 落盘走 `store.update` 的**函数式 patch**（Task 3：修改已有账号的唯一安全方式），
   * 并发不丢更新。不 `await`：`pick` 是同步接口，只投递一次安全的写入。
   */
  stampUsed(id, at = this.now()) {
    const prev = this.lastPick.get(id)
    // 内存账**每次都推进**，只保留最新的池内时刻。
    // 不能"窗内就不更新"：`lastUsed` 是 LRU 轮询的**唯一**依据，若窗内重复使用不推进内存账，
    // 真实网关节奏（每请求 ~1ms，远小于 2000ms 窗）下刚用过的号会一直顶着旧时刻、被判成"最久未用"，
    // 于是时钟每推进就再压它一次——正是 `minIntervalMs` 要防的超频。实测：亲和号连拍时
    // 每次时钟推进 2000ms 仍反复选中同一个号（`lastPick` 停在 1e6 不动）。
    this.lastPick.set(id, at)
    // 落盘则可以省：落盘值参与 `lastUsed` 的 max，但它**永远不会更大**——它只在 `stampUsed`
    // 写入，而本进程的 `stampUsed` 每次都把内存账推到不小于磁盘的值。故本次仍落在上一笔
    // 落盘的节流窗内时，磁盘值不可能改变任何 pick 结果（`lastUsed` 取 max，更早/相等都不占优），
    // 直接跳过落盘，避免连拍/会话亲和下每次 pick 都同步写盘（实测旧实现 1000 次 pick = 335ms）。
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
      /**
       * 401 的含义取决于账号类型：
       * - oauth：凭据（JWT）失效，用户重新登录就能救回来 → `needsRelogin`
       * - apikey：API Key 被吊销/填错，**没有"重新登录"这回事** → `invalidKey`
       *
       * 早先不分类型统一置 `needsRelogin`，于是从客户端扫描进来的一个失效 Coding Plan key
       * 会在面板上显示"需重登"——那是个点不动的死路，用户会一直找不到该做什么。
       * 实测这台机器上 5 个 Coding Plan 凭据里就有 1 个是 401。
       */
      if (status === 401) return a.type === 'apikey' ? { invalidKey: true, stats } : { needsRelogin: true, stats }
      if (code === 1113) return { noPackage: true, stats }
      /**
       * 冷却**只能延长，不能缩短**：用 `Math.max(现有值, 本次解禁时刻)` 而非赋值。
       *
       * 赋值版实测缺陷：同一账号上并发在途的多个请求（会话亲和/慢请求）会先后 `markError`——
       * 先记 3012（`now+30min`），30s 后另一个请求返回普通 429，`patch.cooldownUntil = now+60s`
       * 就把冷却**改写**成 30s 后解禁，该号提前 29 分钟重新发号，风控防线被直接削弱。
       * 取 max 让"更严的那次"始终占优：短冷却盖不掉长冷却，长冷却可以延长短冷却。
       */
      const later = (deltaMs) => Math.max(a.cooldownUntil ?? 0, this.now() + deltaMs)
      if (code === 3012) {
        /**
         * strikes 是**累计**风控次数（不清零、按 24h 窗口回退），不是"当前窗口内的计数"：
         * 第 3 次起冷却 24h，第 5 次停用。故 24h 跳变只会让第 4、5 次继续累加，
         * 不会让计数重置——`markSuccess` 才是唯一的清零入口。
         *
         * 只有 3012 是"账号级风控级联"信号，才累加 strikes；普通 HTTP 429 见下。
         */
        const strikes = (a.strikes ?? 0) + 1
        const patch = { strikes, stats, cooldownUntil: later(strikes >= 3 ? 24 * 60 * 60_000 : this.cooldown3012Ms) }
        if (strikes >= 5) patch.enabled = false
        return patch
      }
      /**
       * 普通 HTTP 429 只设 60s 冷却，**不计入 strikes**。
       *
       * 旧实现把 `status === 429` 与 `code === 3012` 并入同一 strikes，实测：连续 5 次普通 429
       * （无任何 3012）→ strikes=5 → `enabled=false`，而 `pick` 只选 `enabled !== false` 的号，
       * 该号再也拿不到请求 → `markSuccess` 永不触发 → **24h 后仍不恢复**，只能人工干预。
       * 429 的语义是"上游此刻限流"（秒级~分钟级自愈），30min/24h 级联与停用是 3012 专属语义。
       */
      if (status === 429) return { stats, cooldownUntil: later(60_000) }
      // 其他状态码（5xx/网络错误等）只记录，不冷却不发号惩罚：网关会换号重试。
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
     *
     * 为什么不另起定时器：`status()` 由看板以 ~3s 轮询（T18），真实部署下必然被周期性调用，
     * 故清理挂在它上面足够及时；而起定时器会给 `pick()` 这条同步热路径引入额外的生命周期
     * （句柄泄漏/测试里难以回收）。**依赖声明**：这条清理**依赖 `status()` 被周期性调用**，
     * 若看板停用或轮询下线，`lastPick` 里已删账号的键会滞留到下一次 `status()` 为止——
     * 只为已不存在的 id 多占几条内存，不影响任何发号/节流判定（`lastUsed` 只按在场账号查）。
     */
    const live = new Set(all.map((a) => a.id))
    for (const id of this.lastPick.keys()) if (!live.has(id)) this.lastPick.delete(id)
    /**
     * 顺带回收**过期的亲和绑定**（修复轮 3）：`sessionKey` 直接来自客户端可任意设置的
     * `x-session-id`，一个低成本客户端可刷出无数不同 header，实测 10 万个不同 header →
     * `affinity.size = 100000` 且只增不减（`pick` 只在命中时读、过期绑定既不删也不复用，
     * 却一直占着 Map 条目）。过 TTL 的绑定与"从未绑定"等价（`pick` 里 `t - hit.at < AFFINITY_TTL`
     * 判定），故在此安全删除，与 `lastPick` 的清理同处、同样依赖 `status()` 被周期性调用。
     */
    for (const [key, hit] of this.affinity) if (t - hit.at >= AFFINITY_TTL) this.affinity.delete(key)
    return all.map((a) => ({
      id: a.id,
      provider: a.provider,
      type: a.type,
      enabled: a.enabled !== false,
      needsRelogin: a.needsRelogin === true,
      noPackage: a.noPackage === true,
      invalidKey: a.invalidKey === true,
      cooldownRemainMs: Math.max(0, (a.cooldownUntil ?? 0) - t),
      email: a.userInfo?.email ?? null,
      name: a.userInfo?.name ?? null,
      planCache: a.planCache ?? null,
      /**
       * 警告：`stats.lastUsedAt` 与 `stats.lastError.at` 存的是**池内时钟值**
       * （与节流/`nextThrottleAt` 同轴，注入假时钟时不是真纪元毫秒）。看板层（T18）**不要**直接
       * `new Date(stats.lastUsedAt)` —— 会得到 1970 附近的时刻。需要人类可读时间时，
       * 由管理端用自己的真实时钟换算，或另存一份真实时间戳。
       */
      stats: a.stats,
    }))
  }
}
