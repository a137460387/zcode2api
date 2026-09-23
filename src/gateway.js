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
  // 选号总尝试上限：pool 长期处于节流/冷却时 `pick` 会一直返回"暂时无号"，
  // 没有上限就会无限等待（brief 要求）。默认给足余量，单次约等于一个节流窗。
  const maxPickAttempts = config.maxPickAttempts ?? 10

  async function sendOnce(account, body, sessionId) {
    if (account.type === 'apikey') {
      return senders.apikey({ account, body, sessionId })
    }
    const param = await paramPool.take()
    return senders.oauth({ account, body, param, sessionId })
  }

  async function complete(anthropicBody, { sessionKey = null } = {}) {
    const sessionId = sessionKey || crypto.randomUUID().replace(/-/g, '')
    let accountSwitches = 0
    let paramRetries = 0
    let pickAttempts = 0
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
           * - `waitMs` 是有限正数：暂时无号（在 `minIntervalMs` 节流窗内或冷却中），
           *   **等它之后重试是正常路径**（冷启动尖峰即如此），不是错误。
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
          if (++pickAttempts > maxPickAttempts) {
            throw new GatewayError({
              status: 503,
              message: `no usable account after ${maxPickAttempts} attempts: ${reason}`,
              hint: '账号池持续无可用账号：确认账号是否被节流/冷却，或稍后重试',
            })
          }
          await new Promise((r) => setTimeout(r, waitMs ?? 0))
          continue
        }
      }
      pickAttempts = 0
      // 注意：`account` 非空时 `waitMs` 是"建议节流间隔"（选中后到它下次可用），
      // 由池自身记账节制后续选号，网关**不等待**它——否则每个请求都白白慢一个节流窗。
      let res
      try {
        res = await sendOnce(account, anthropicBody, sessionId)
      } catch (e) {
        // 网络异常：标记后换号。冷却/停用判定全权交给池（markError 内部实现）。
        await pool.markError(account, { status: 0, code: 'network: ' + e.message })
        if (++accountSwitches > config.maxRetries) {
          throw new GatewayError({ status: 502, message: 'network error: ' + e.message })
        }
        account = null
        continue
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
      if (code === 3007 && paramRetries < config.maxRetries) {
        paramRetries += 1
        continue
      }
      const riskOrServer = code === 3012 || res.status === 429 || res.status >= 500
      const credDead = res.status === 401 || code === 1113
      if (riskOrServer || credDead) {
        const clientStatus = code === 3012 ? 429 : code === 1113 ? 429 : res.status
        const err = new GatewayError({
          status: clientStatus,
          code,
          message: text.slice(0, 300),
          upstreamStatus: res.status,
          hint: code === 3012
            ? '上游行为风控（3012）：已降低节奏并切换账号；若持续请等待风控衰减（分钟~小时级）'
            : code === 1113
              ? '该账号无可用资源包（1113）：付费 GLM Coding Plan key 才能走标准通道'
              : res.status === 401
                ? '账号凭据失效：请在看板重新登录'
                : null,
        })
        if (++accountSwitches > config.maxRetries) throw err
        lastRetryable = err
        account = null
        continue
      }
      // 其余（400 等客户端错误）直接抛给客户端：重试也不会成功。
      throw new GatewayError({
        status: res.status === 200 ? 502 : res.status,
        code,
        message: text.slice(0, 1000),
        upstreamStatus: res.status,
      })
    }
  }

  return { complete }
}
