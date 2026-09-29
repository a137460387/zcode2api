import crypto from 'node:crypto'

export class GatewayError extends Error {
  /**
   * `accountId` 是**这次失败落在哪个账号上**。管理面板要回答"是哪个号在吃 429/3012"，
   * 而错误是在这里抛出、在 server 层记录的——不带上账号 id，面板就只能把它记成
   * `(unattributed)`，恰恰在最需要定位的时候失明（实测：两次真实失败在面板里都无法归属账号）。
   * 池层错误（无号可用）没有账号，保持 null。
   */
  constructor({ status = 502, code = null, message, hint = null, upstreamStatus = null, accountId = null }) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.hint = hint
    this.upstreamStatus = upstreamStatus
    this.accountId = accountId
  }
}

const parseCode = (text) => {
  try { return JSON.parse(text).code ?? null } catch { return null }
}

export function createGateway({ pool, paramPool, senders, config, log = () => {}, refreshPlanCache = null }) {
  // 默认值与 config.js 的 maxRetries 保持一致：漏传时应取"有重试"而不是"零重试"
  // （`config.maxRetries ?? 0` 会让换号/换参在漏传时静默失效，与 `> undefined` 恒 false 是同一类错误）。
  const maxRetries = config.maxRetries ?? 2
  /**
   * 单次请求内为"等号"允许的总时长上限。池对"节流中"（秒级，正常路径）与"冷却中"
   * （30min~24h，等下去本次请求也不会成功）都返回正数 `waitMs`，网关无法区分二者，
   * 故用累计等待时长兜底：超过此值即失败并提示原因，而不是让 HTTP 请求干睡在冷却窗里。
   *
   * 注意**不要**再加一个"选号次数上限"：节流是池明确背书的合法等待（`reason` 含 throttled），
   * 次数上限会把它误判为失败——并发时 N 个请求各自计数同一节流事件，实测 12 并发只有 6 个成功。
   * 时长上限才是"避免无限等待"的完整解。
   */
  const maxPickWaitMs = config.maxPickWaitMs ?? 15_000

  async function sendOnce(account, body, sessionId) {
    if (account.type === 'apikey') {
      return senders.apikey({ account, body, sessionId })
    }
    // 取参数失败是**本地农场产出不足**，与账号健康完全无关：
    // 必须与"上游请求失败"区分，否则会把健康账号标记为出错、还白耗一次换号额度。
    let param = null
    try {
      param = await paramPool.take()
    } catch (e) {
      // 3.14.4 起上游默认不再校验验证码（官方 skip_model_request 分支返回空 headers，
      // 实测无参直发 200）：农场断供时**无参直发**，把农场从热依赖降级为保险丝。
      // 上游若恢复校验会回 3007 → complete() 既有的换参重试会再次尝试取参，
      // 那时农场仍无货才真正不可用。绝不能在这里返回错误：农场一断供就全站 503。
      log(`[gateway] 农场无参数，无参直发（上游 3.14.4 默认不校验验证码）：${e.message}`)
    }
    return senders.oauth({ account, body, param, sessionId })
  }

  async function complete(anthropicBody, { sessionKey = null } = {}) {
    const sessionId = sessionKey || crypto.randomUUID().replace(/-/g, '')
    let accountSwitches = 0
    let paramRetries = 0
    /**
     * 选号与发送**分离**：`account` 只在"需要（重新）取号"时通过 `pool.pick` 拿到，
     * 并在下面置回 `null` 时触发下一次取号。
     *
     * 关键：3007 是**参数**问题（captcha 校验失败），要"换参重试、不换号、不冷却"。
     * 若每轮循环都无条件 `pick()`（brief 示例的写法），3007 重试会顺手消耗掉一个新号——
     * 单号池里第二次 pick 即"无号可用"→ 变成 503，而实测这是必须成功的路径。
     * 故 `account` 非空时直接复用，只有换号/冷却分支才把它置回 `null`。
     */
    let account = null
    /**
     * 最近一次已分类的可重试错误。当"还想换号重试但池里已无号"时，它比笼统的 503 更有信息量：
     * 客户端应看到"上游风控/凭据失效"（429/401）而非"账号池无号"。
     */
    let lastRetryable = null
    // 用"请求开始时刻"作为唯一基准，而非累加 waitedMs。累加口径在换号失败路径上不守恒
    // （审计 B4）：拿到账号就清零，于是"拿 A 失败 → 等 8s → 拿 B 失败 → 再等 8s"会反复
    // 重置，实际等待远超 maxPickWaitMs 注释承诺的 15s。改成始终从 startedAt 算起，
    // 无论中间换几次号都不重置。
    const startedAt = Date.now()
    while (true) {
      if (!account) {
        // 把请求的 model 透传给池：同账号同模型多套餐时，"紧迫度"应按"该模型下未过期的
        // entitlement 最早过期"算（例：账号同时挂着 GLM-5.3 周末包和 GLM-5.3-Flash 日包，
        // 烧 Flash 的请求不该被 GLM-5.3 的临近过期误导）。
        const picked = pool.pick(sessionKey, { model: anthropicBody?.model })
        const { waitMs, warn, reason } = picked
        account = picked.account
        if (!account) {
          /**
           * T4 账号池契约（三轮修复后的最终形态）：
           * - `warn === 'human action required'`（`waitMs === null`）：账号全停用/需重登/无套餐，
           *   等下去也不会自愈 —— **必须立即失败**。若按 waitMs 重试会无限循环。
           * - `waitMs` 是有限正数：暂时无号。**节流中（秒级）等它重试是正常路径**；
           *   但**冷却中（分钟~小时级）等下去本次请求也不会成功**，池对两者返回同样的形态，
           *   故用累计等待上限区分（见 `maxPickWaitMs`）。
           * - 设总尝试上限，避免池长期无号时无限等待。
           *
           * 例外（本任务实测发现，见下方 `lastRetryable`）：已经因可重试错误换过号、此刻池里
           * 又无号可换时，**立即返回那个真实错误**，绝不按 `waitMs` 睡下去——两号都吃 3012 后
           * `pick` 返回的是 `{account:null, waitMs:60000, reason:'all accounts cooling down...'}`
           * （**正数 waitMs 且无 warn**，池只在 `waitMs===null` 时才给 warn），照契约"等 waitMs
           * 再重试"会让一个 HTTP 请求在 30min~24h 的冷却窗里干睡，客户端早已超时。
           */
          if (lastRetryable) throw lastRetryable
          if (warn) {
            throw new GatewayError({
              status: 503,
              message: `no usable account: ${reason}`,
              hint: '需人工处理：登录/启用账号或购买资源包',
            })
          }
          const wait = waitMs ?? 0
          // 绝对时长判断（修复 B4）：
          // ① 本次 wait 自身就超过 maxPickWaitMs（冷却 30min 这种）→ 立即失败，不干睡。
          // ② 已消耗时长 ≥ maxPickWaitMs → 立即失败，不再等（换号失败路径也守恒）。
          // 与"先判 elapsed + wait 再决定等不等"的区别：setTimeout 实际有毫秒级误差，
          // 先判会让总耗时略低于 maxPickWaitMs（实测 217ms < 250ms 期望）；先等后判更宽松，
          // 与旧"累加 waitedMs"的行为边界一致，同时仍堵住 B4 的换号失败不守恒漏洞。
          if (wait <= 0) {
            throw new GatewayError({
              status: 503,
              code: 3012,
              message: `no usable account: pool reported no wait (${reason})`,
              hint: '账号处于冷却（风控/限流）：单次请求不宜等待，请稍后重试或增补账号',
            })
          }
          if (wait > maxPickWaitMs) {
            throw new GatewayError({
              status: 503,
              code: 3012,
              message: `no usable account: next available in ~${Math.round(wait / 1000)}s (${reason})`,
              hint: '账号处于冷却（风控/限流）：单次请求不宜等待，请稍后重试或增补账号',
            })
          }
          if (Date.now() - startedAt >= maxPickWaitMs) {
            throw new GatewayError({
              status: 503,
              code: 3012,
              message: `no usable account: exceeded max wait budget ~${Math.round(maxPickWaitMs / 1000)}s (${reason})`,
              hint: '账号处于冷却（风控/限流）：单次请求不宜等待，请稍后重试或增补账号',
            })
          }
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
      }
      // 注意：`account` 非空时 `waitMs` 是"建议节流间隔"（选中后到它下次可用），
      // 由池自身记账节制后续选号，网关**不等待**它——否则每个请求都白白慢一个节流窗。
      let res
      try {
        res = await sendOnce(account, anthropicBody, sessionId)
      } catch (e) {
        // 网络异常：标记后换号。冷却/停用判定全权交给池（markError 内部实现）。
        await pool.markError(account, { status: 0, code: 'network: ' + e.message })
        if (++accountSwitches > maxRetries) {
          throw new GatewayError({ status: 502, message: 'network error: ' + e.message, accountId: account.id })
        }
        account = null
        continue
      }
      // 农场断供不再硬失败（3.14.4 起上游默认不校验验证码）：sendOnce 已降级为
      // 无参直发；上游若恢复校验会回 3007，由下方"换参重试"路径唤起农场。
      // 原"__paramError → 503"分支已死代码化并移除——农场只剩保险丝职责。
      /**
       * 上游可能以 HTTP 200 包业务错误码（本项目多处如此：3001/3007/3012/1113 都在 body 的
       * `code` 字段），故**必须解析 body 判定**，不能只看 `res.status`。
       * 只有 200 且 `code === 0`（或无 `code`，即普通成功响应/非 JSON body）才算成功。
       *
       * 关键：`Response.body` 是**一次性流**，直接 `res.text()` 会把它消费掉，之后调用方
       * `response.json()` 会抛 "Body is unusable"，或（流式）`res.body.getReader()` 抛
       * "ReadableStream is locked" 并被 finally 静默吞掉 → 客户端拿到 **200 + 空 body**。
       * 故先 `clone()` 出副本用于判定，原响应体留给调用方消费。
       * （测试用的假响应对象没有 clone，回退为直接读取——那时 body 语义由假对象自己保证。）
       */
      const probe = typeof res.clone === 'function' ? res.clone() : res
      const text = await probe.text().catch(() => '')
      const code = parseCode(text)
      const isOk = res.status === 200 && (code === null || code === 0)
      if (isOk) {
        await pool.markSuccess(account)
        return { response: res, account }
      }
      log(`[gateway] ${account.id} -> HTTP ${res.status} code=${code}`)
      // 只传真实 status/code；3012 冷却梯度、401 needsRelogin、1113 noPackage、
      // 429 冷却与 strikes 累计（5 次停用）全在池的 markError 内部实现，网关不重复判断。
      await pool.markError(account, { status: res.status, code })

      // 3007 = captcha 校验失败的**参数**问题：换参重试，**不换号、不冷却**（同一账号继续发）。
      if (code === 3007 && paramRetries < maxRetries) {
        paramRetries += 1
        continue
      }
      /**
       * 错误摘要不透传上游 body 全文：上游可能回显请求内容（含 jwt / captcha param），
       * 原样交给客户端会凭空扩大凭据泄露面。只保留 status 与业务码，详情走 `log`。
       */
      const brief = `upstream HTTP ${res.status}${code != null ? ` code=${code}` : ''}`
      /**
       * 1005 实测语义是"该号额度在运行中途耗尽"（免费日包烧穿），不是请求本身有错：
       * 同一个请求换一个号就能成功。而 planCache 唯一的常规写入方是面板手动刷新
       * （panel/api.js），缓存跟上前该号在池里始终"健康"、被反复调度
       * （实测 9efaa210 连吃 15 次 1005 后 ecddf87c 接棒）。
       *
       * 故收到 1005 时触发一次（去重后的）套餐缓存刷新，再复检健康度：
       * - 复检不可用 → 换号重试，当前请求自愈，客户端无感；
       * - 复检仍可用（1005 另有成因、刷新失败、或测试假池没有 healthy）→ 落到下方
       *   原有的"客户端错误透传"，不循环、不放大。
       * 刷新器自身承诺不抛错（见 plan-cache.js），这里的 try/catch 是对注入方的防御。
       */
      if (code === 1005 && account.type === 'oauth' && typeof refreshPlanCache === 'function') {
        try {
          await refreshPlanCache(account)
        } catch { /* 刷新失败按旧缓存判断，走透传 */ }
        const usable = typeof pool.healthy === 'function' ? pool.healthy(account, anthropicBody?.model) : true
        if (!usable) {
          const err = new GatewayError({
            status: 502,
            code,
            message: brief,
            upstreamStatus: res.status,
            accountId: account.id,
            hint: '该账号额度已耗尽（1005）：套餐缓存已刷新并换号重试；日额度次日自动恢复',
          })
          if (++accountSwitches > maxRetries) throw err
          lastRetryable = err
          account = null
          continue
        }
      }
      const riskOrServer = code === 3012 || res.status === 429 || res.status >= 500
      const credDead = res.status === 401 || code === 1113
      if (riskOrServer || credDead) {
        const clientStatus = code === 3012 ? 429 : code === 1113 ? 429 : res.status
        const err = new GatewayError({
          status: clientStatus,
          code,
          message: brief,
          upstreamStatus: res.status,
          accountId: account.id,
          hint: code === 3012
            ? '上游行为风控（3012）：已降低节奏并切换账号；若持续请等待风控衰减（分钟~小时级）'
            : code === 1113
              ? '该账号无可用资源包（1113）：付费 GLM Coding Plan key 才能走标准通道'
              : res.status === 401
                ? '账号凭据失效：请在看板重新登录'
                : null,
        })
        if (++accountSwitches > maxRetries) throw err
        lastRetryable = err
        account = null
        continue
      }
      // 其余（400 等客户端错误）直接抛给客户端：重试也不会成功。
      throw new GatewayError({
        status: res.status === 200 ? 502 : res.status,
        code,
        message: brief,
        upstreamStatus: res.status,
        accountId: account.id,
      })
    }
  }

  return { complete }
}
