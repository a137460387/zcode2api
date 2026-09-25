import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { AccountStore } from './auth/store.js'
import { AccountPool } from './accounts.js'
import { ParamPool, ParamPoolEmpty } from './captcha/pool.js'
import { startFarmServer } from './captcha/farm-server.js'
import { launchFarmBrowser } from './captcha/browser.js'
import { sendZcodePlan } from './upstream/zcode-plan.js'
import { sendBigModel } from './upstream/bigmodel-api.js'
import { createGateway } from './gateway.js'
import { UsageStore, createRequestLog } from './usage.js'
import { mapToZcodePlan, publicModelIds } from './models.js'
import { openaiToAnthropic, anthropicToOpenAI } from './protocol/convert.js'
import { pipeAnthropicToOpenAISSE, pipeAnthropicSSEWithUsage } from './protocol/stream.js'
import { PanelAuth } from './panel/auth.js'
import { RuntimeSettings } from './panel/settings.js'
import { registerPanelRoutes } from './panel/api.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 上游 usage → 用量记录字段。
 *
 * 两个来源形状不同，故统一在这里归一：
 * - 非流式：`data.usage`（Anthropic 响应体）
 * - 流式：解析器累积出的 `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens}`
 *
 * **`total_tokens` 必须把缓存命中的输入算进去**（实测教训）：Anthropic 口径下
 * `input_tokens` **不含**缓存部分，缓存命中单独记在 `cache_read_input_tokens`。
 * 实测一次流式请求：`input_tokens=40, cache_read_input_tokens=1664, output_tokens=8`，
 * 上游计费 +1712 单位 = 40+1664+8。若按 `input+output` 记总账，面板会显示 48——
 * 比实际少 35 倍。而 agent 类客户端（Claude Code / dsh）每轮都重发一大段系统提示，
 * 命中缓存是常态，所以这个偏差在实际使用中是**系统性**的，不是边角情况。
 *
 * `prompt_tokens` 保持"未命中缓存的输入"这一原始语义（与上游字段一一对应），
 * 缓存量另列，面板据此展示"输入 / 缓存 / 输出"。
 */
function usageToRecord(data, model, accountId, timing, stream, streamUsage = null) {
  const u = streamUsage ?? data?.usage ?? {}
  const prompt = u.inputTokens ?? u.input_tokens ?? 0
  const completion = u.outputTokens ?? u.output_tokens ?? 0
  const cacheRead = u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0
  const cacheCreation = u.cacheCreationTokens ?? u.cache_creation_input_tokens ?? 0
  return {
    model,
    account: accountId ?? null,
    stream,
    status: 200,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    total_tokens: prompt + cacheRead + cacheCreation + completion,
    ...timing,
  }
}

/**
 * 计时器：`elapsed_ms` 从调用上游前开始计（含等参数/等节流，这才是用户真正感知的延迟）；
 * `ttft_ms` 只在**流式**路径上有意义——非流式没有"首字节"信号，用 `null` 表示"未测"，
 * 而不是塞一个等于 elapsed 的值冒充（那会把两条路径的均值混成无法解释的数）。
 */
function makeTimer(clock = Date.now) {
  const started = clock()
  let firstAt = 0
  return {
    markFirstByte() { if (!firstAt) firstAt = clock() },
    finish({ stream, outputTokens = 0 } = {}) {
      const ended = clock()
      const elapsed = ended - started
      const ttft = stream && firstAt ? firstAt - started : null
      const genMs = stream && firstAt ? ended - firstAt : null
      // 生成速度按"首字节之后的耗时"算：把首字等待算进去会系统性低估速度。
      const tps = genMs && genMs > 0 && outputTokens > 0 ? outputTokens / (genMs / 1000) : null
      return { elapsed_ms: elapsed, ttft_ms: ttft, tokens_per_sec: tps }
    },
  }
}

export function createApp(deps) {
  const { config, store, pool, paramPool, gateway, requestLog, usage, panelAuth, settings, log = () => {} } = deps
  const app = express()
  app.use(express.json({ limit: '32mb' }))
  const now = deps.now ?? Date.now
  const clock = deps.clock ?? Date.now

  // `isLocal` 可注入（deps.isLocal）：Socket.remoteAddress 是只读的 getter，
  // 测试无法伪造成非本机来源，导致"非本机必须校验面板密码"这条安全边界无从覆盖。
  // 面板鉴权统一走 PanelAuth（见 src/panel/auth.js）：本机放行 + token 会话 + 旧请求头兼容。
  const isLocal = deps.isLocal ?? ((req) => {
    const addr = req.socket.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  })
  const auth = panelAuth ?? new PanelAuth({
    file: path.join(config.rootDir ?? process.cwd(), 'panel.json'),
    bootstrapPassword: config.panelPassword,
    localBypass: config.panelLocalBypass,
    now: deps.panelNow ?? Date.now,
    log,
  })
  if (deps.isLocal) {
    // 注入的 isLocal 优先（测试需要伪造来源），否则用 PanelAuth 自己的判定。
    auth.isLocal = isLocal
  }
  const v1Auth = (req, res, next) => {
    // 未配置 apiKey 是服务端配置缺失：用 503（服务不可用）而非 500，
    // 对外接口回 500 会被客户端当作上游故障并反复重试。
    if (!config.apiKey) return res.status(503).json({ error: { message: 'API_KEY not configured (.env)' } })
    // 三种凭据来源必须**按优先级显式回退**。`??` 只对 null/undefined 生效，而
    // 未带 x-api-key 时 `req.get('x-api-key')` 返回 `undefined`、未带 authorization 时
    // `(req.get('authorization') || '')` 是**空串**——空串不是 nullish，`??` 会在它处短路，
    // 于是 `?key=` 永远读不到（实测三选一里只有 `?key=` 恒 401）。
    // 用 `||` 链：空串与 undefined 都视为"未提供"，继续往后取。
    const key = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key
    // `?key=a&key=b` 会让 req.query.key 变成数组，`数组 !== 字符串` 恒真 → 即使正确的 key 在列也 401。
    // 取第一个（Express 的默认 query 解析保证顺序与出现顺序一致）。
    const normalized = Array.isArray(key) ? key[0] : key
    if (normalized !== config.apiKey) return res.status(401).json({ error: { message: 'invalid api key' } })
    return next()
  }

  const farmUrl = deps.farmUrl ?? ''
  app.get('/health', (req, res) => {
    res.json({ ok: true, accounts: pool.status().length, paramPool: paramPool.status(), farmUrl })
  })
  app.get('/v1/models', v1Auth, (req, res) => {
    res.json({ object: 'list', data: publicModelIds().map((id) => ({ id, object: 'model', owned_by: 'zcode2api' })) })
  })

  const fail = (res, err, fmt) => {
    const status = err.status ?? 502
    // 流式响应头一旦发出就不能再改状态码/写 JSON：此时只能结束响应，
    // 否则 res.status().json() 会抛 "Cannot set headers after they are sent"，
    // 既是 unhandled rejection 又让客户端永远等不到流结束（挂死到超时）。
    if (res.headersSent) {
      log(`[server] stream aborted mid-flight: ${err?.message ?? err}`)
      return res.end()
    }
    const payload = fmt === 'anthropic'
      ? { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: err.message + (err.hint ? `（${err.hint}）` : '') } }
      : { error: { message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.code != null ? { upstream_code: err.code } : {}) } }
    return res.status(status).json(payload)
  }

  const recordUsage = (account, usage_) => {
    if (usage_ && account) pool.recordUsage(account.id, usage_)
  }
  const logRequest = (entry) => requestLog.add(entry)
  /**
   * 用量落盘（面板「用量分析」的数据源）。**不 await**：它在响应已经发给客户端之后才写，
   * 让一个慢盘拖住请求的收尾毫无意义；`UsageStore` 自己保证写入串行且失败不抛。
   */
  const recordAnalytics = (entry) => { usage?.record(entry) }

  /**
   * 失败请求的用量记录。
   *
   * 两个"看起来无关紧要、实际会让面板失明"的点（真实上游实测踩到）：
   * - `stream` 必须取**客户端请求的模式**，不能硬编码 false。流式请求在收到首字节前失败时
   *   一次 `data:` 都没发，但那仍然是"流式请求失败了"，记成非流式会让面板的流式统计失真。
   * - `account` 取 `err.accountId`（网关在抛错时带上）。否则失败记录全是 `(unattributed)`，
   *   而"是哪个号在吃 429/3012"正是面板最该回答的问题。
   */
  const recordFailure = (model, err, timer, stream) => {
    const status = err.status ?? 502
    logRequest({ model, account: err.accountId ?? undefined, stream, status, error: err.message })
    recordAnalytics({
      model,
      account: err.accountId ?? null,
      stream: Boolean(stream),
      status,
      error: err.message,
      ...timer.finish({ stream: Boolean(stream) }),
    })
  }

  app.post('/v1/chat/completions', v1Auth, async (req, res) => {
    const clientModel = req.body.model || 'glm-5.3'
    const sessionKey = req.get('x-session-id') ?? null
    const timer = makeTimer(clock)
    try {
      const body = openaiToAnthropic(req.body, mapToZcodePlan)
      const { response, account } = await gateway.complete(body, { sessionKey })
      logRequest({ model: clientModel, account: account.id, stream: body.stream, status: 200 })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const write = (chunk) => { timer.markFirstByte(); return res.write(chunk) }
        // 流中途失败（上游中断/客户端断开）时 headers 已发出，只能结束响应。
        try {
          const u = await pipeAnthropicToOpenAISSE(response, write, clientModel)
          await recordUsage(account, u)
          recordAnalytics({ ...usageToRecord(u, clientModel, account.id, timer.finish({ stream: true, outputTokens: u.outputTokens }), true, u) })
        } finally {
          if (!res.writableEnded) res.end()
        }
        return
      }
      const data = await response.json()
      await recordUsage(account, { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 })
      recordAnalytics(usageToRecord(data, clientModel, account.id, timer.finish({ stream: false }), false))
      return res.json(anthropicToOpenAI(data, clientModel))
    } catch (e) {
      recordFailure(clientModel, e, timer, req.body?.stream)
      return fail(res, e, 'openai')
    }
  })

  app.post('/v1/messages', v1Auth, async (req, res) => {
    const clientModel = req.body.model || 'glm-5.3'
    const sessionKey = req.get('x-session-id') ?? null
    const timer = makeTimer(clock)
    try {
      const body = { ...req.body, model: mapToZcodePlan(req.body.model) }
      const { response, account } = await gateway.complete(body, { sessionKey })
      logRequest({ model: clientModel, account: account.id, stream: body.stream, status: 200 })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const write = (chunk) => { timer.markFirstByte(); return res.write(chunk) }
        try {
          const u = await pipeAnthropicSSEWithUsage(response, write)
          await recordUsage(account, u)
          recordAnalytics({ ...usageToRecord(u, clientModel, account.id, timer.finish({ stream: true, outputTokens: u.outputTokens }), true, u) })
        } finally {
          if (!res.writableEnded) res.end()
        }
        return
      }
      const data = await response.json()
      await recordUsage(account, { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 })
      recordAnalytics(usageToRecord(data, clientModel, account.id, timer.finish({ stream: false }), false))
      return res.json(data)
    } catch (e) {
      if (e instanceof ParamPoolEmpty) {
        if (res.headersSent) return res.end()
        recordFailure(clientModel, e, timer, req.body?.stream)
        return res.status(503).json({ type: 'error', error: { type: 'api_error', message: `captcha param pool empty — 打开 ${farmUrl} 检查农场` } })
      }
      recordFailure(clientModel, e, timer, req.body?.stream)
      return fail(res, e, 'anthropic')
    }
  })

  app.get('/', auth.middleware(), (req, res) => {
    // res.sendFile() 对缺失文件**不抛异常**，它异步把 ENOENT 交给 next(err)；故 try/catch 包不住它，
    // 只会在 dashboard/index.html 缺失时回 500。这里先判存在性：文件就绪后读文件，
    // 未就绪时返回占位页（既定行为）。
    const file = path.join(__dirname, 'dashboard', 'index.html')
    if (!fs.existsSync(file)) return res.status(200).send('<h1>zcode2api</h1>')
    return res.sendFile(file)
  })

  registerPanelRoutes(app, {
    config, store, pool, paramPool, requestLog, usage, auth, settings,
    farmUrl, log, now,
    // 农场页自报状态由 farm server 持有，面板要显示它就得显式接进来
    farmReport: deps.farmReport ?? (() => null),
    realNow: deps.realNow ?? Date.now,
    fetchImpl: deps.fetchImpl,
    loginTtlMs: deps.loginTtlMs,
    readLocalCredentials: deps.readLocalCredentials,
    localCredOptions: deps.localCredOptions,
    dashboardFile: path.join(__dirname, 'dashboard', 'index.html'),
  })

  return app
}

export async function main() {
  const config = loadConfig()
  if (!config.apiKey) {
    console.error('[zcode2api] 缺少 API_KEY（复制 .env.example 为 .env 配置）')
    process.exit(1)
  }
  const log = (msg) => console.log(msg)
  /**
   * 常驻服务不应因单个请求的异常而退出。Node ≥15 默认模式下 unhandledRejection 会终止进程，
   * 而网关/管理面里任何一处遗漏的 await 都可能触发它——一次磁盘满就能让整个代理下线。
   * 这里记录日志并**保持存活**；真正的致命错误（如端口占用）会在启动阶段直接抛出。
   */
  process.on('unhandledRejection', (reason) => {
    log(`[zcode2api] unhandledRejection（已忽略，服务继续运行）: ${reason?.stack ?? reason}`)
  })
  process.on('uncaughtException', (err) => {
    log(`[zcode2api] uncaughtException（已忽略，服务继续运行）: ${err?.stack ?? err}`)
  })
  const store = new AccountStore(config.poolDir)
  const pool = new AccountPool(store, { minIntervalMs: config.minIntervalMs, cooldown3012Ms: config.cooldown3012Ms })
  const paramPool = new ParamPool({ ttlMs: config.paramTtlMs, maxSize: config.poolSize })
  const requestLog = createRequestLog({})
  const usage = new UsageStore({ dir: path.join(config.rootDir, 'usage'), log })
  const panelAuth = new PanelAuth({
    file: path.join(config.rootDir, 'panel.json'),
    bootstrapPassword: config.panelPassword,
    localBypass: config.panelLocalBypass,
    log,
  })
  const settings = new RuntimeSettings({
    config, pool, paramPool,
    envFile: path.join(config.rootDir, '.env'),
    panelFile: path.join(config.rootDir, 'panel.json'),
    log,
  })
  const farm = startFarmServer({ paramPool, port: config.farmPort, host: config.host, certDir: config.certDir })
  const gateway = createGateway({
    pool,
    paramPool,
    config,
    log,
    senders: {
      oauth: ({ account, body, param, sessionId }) =>
        sendZcodePlan({ jwt: account.jwt, param, body, sessionId }),
      apikey: ({ account, body }) => sendBigModel({ apiKey: account.apiKey, body }),
    },
  })
  const app = createApp({ config, store, pool, paramPool, gateway, requestLog, usage, panelAuth, settings, log, farmUrl: farm.url, farmReport: () => farm.report })
  app.listen(config.port, config.host, () => {
    log(`[zcode2api] API      → http://${config.host}:${config.port}/v1`)
    log(`[zcode2api] 管理面板 → http://${config.host}:${config.port}/`)
    log(`[zcode2api] farm 页  → ${farm.url}`)
    if (panelAuth.passwordSource() === 'none') {
      log('[panel] 未设置面板密码：仅本机可访问管理面板。如需从其他机器访问，请在本机面板「设置」页设置密码。')
    }
  })
  if (!config.farmAutoBrowser) {
    log('[farm] 手动模式（FARM_AUTO_BROWSER=0）：未启动自动浏览器。')
    log(`[farm] 请用你自己的 Chrome 打开 ${farm.url} 并保持标签页。`)
  } else {
    const browser = await launchFarmBrowser({ url: farm.url, headless: config.farmHeadless, chromePath: config.chromePath, log })
    if (!browser) {
      log(`[farm] 自动浏览器未启动：请手动打开 ${farm.url} 并保持标签页`)
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}

