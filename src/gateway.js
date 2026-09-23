import crypto from 'node:crypto'

export class GatewayError extends Error {
  constructor({ status = 502, code = null, message, hint = null, upstreamStatus = null }) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.hint = hint
    this.upstreamStatus = upstreamStatus
  }
}

const parseCode = (text) => {
  try { return JSON.parse(text).code ?? null } catch { return null }
}

export function createGateway({ pool, paramPool, senders, config, log = () => {} }) {
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
    let param
    try {
      param = await paramPool.take()
    } catch (e) {
      return { __paramError: e }
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
    let waitedMs = 0
    while (true) {
      if (!account) {
        const picked = pool.pick(sessionKey)
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
          // 只按**累计时长**设防（见 maxPickWaitMs 注释）：不用尝试次数，否则并发下
          // N 个请求各自计数同一个节流事件，会把合法等待误判为失败。
          // `wait === 0` 视为错误形态（当前池不会产生：无号时恒有正 waitMs 或 null+warn），
          // 直接失败而不是空转——否则 waitedMs 不推进会变成死循环。
          if (wait <= 0 || waitedMs + wait > maxPickWaitMs) {
            throw new GatewayError({
              status: 503,
              code: 3012,
              message: wait > 0
                ? `no usable account: next available in ~${Math.round(wait / 1000)}s (${reason})`
                : `no usable account: pool reported no wait (${reason})`,
              hint: '账号处于冷却（风控/限流）：单次请求不宜等待，请稍后重试或增补账号',
            })
          }
          waitedMs += wait
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
      }
      waitedMs = 0
      // 注意：`account` 非空时 `waitMs` 是"建议节流间隔"（选中后到它下次可用），
      // 由池自身记账节制后续选号，网关**不等待**它——否则每个请求都白白慢一个节流窗。
      let res
      try {
        res = await sendOnce(account, anthropicBody, sessionId)
      } catch (e) {
        // 网络异常：标记后换号。冷却/停用判定全权交给池（markError 内部实现）。
        await pool.markError(account, { status: 0, code: 'network: ' + e.message })
        if (++accountSwitches > maxRetries) {
          throw new GatewayError({ status: 502, message: 'network error: ' + e.message })
        }
        account = null
        continue
      }
      if (res && res.__paramError) {
        throw new GatewayError({
          status: 503,
          message: `captcha param unavailable: ${res.__paramError.message}`,
          hint: '农场未供给验证码参数：请在浏览器打开 farm 页并保持标签页运行',
        })
      }
      /**
       * 上游可能以 HTTP 200 包业务错误码（本项目多处如此：3001/3007/3012/1113 都在 body 的
       * `code` 字段），故**必须解析 body 判定**，不能只看 `res.status`。
       * 只有 200 且 `code === 0`（或无 `code`，即普通成功响应/非 JSON body）才算成功；
       * body 读取失败也按成功处理（上游已 200，交给客户端解析）。
       */
      const text = await res.text().catch(() => '')
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
      const riskOrServer = code === 3012 || res.status === 429 || res.status >= 500
      const credDead = res.status === 401 || code === 1113
      if (riskOrServer || credDead) {
        const clientStatus = code === 3012 ? 429 : code === 1113 ? 429 : res.status
        const err = new GatewayError({
          status: clientStatus,
          code,
          message: brief,
          upstreamStatus: res.status,
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
      })
    }
  }

  return { complete }
}
