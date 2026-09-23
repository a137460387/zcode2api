import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { AccountStore, newAccountFields } from './auth/store.js'
import { AccountPool } from './accounts.js'
import { ParamPool, ParamPoolEmpty } from './captcha/pool.js'
import { startFarmServer } from './captcha/farm-server.js'
import { launchFarmBrowser } from './captcha/browser.js'
import { sendZcodePlan } from './upstream/zcode-plan.js'
import { sendBigModel } from './upstream/bigmodel-api.js'
import { createGateway } from './gateway.js'
import { createRequestLog } from './usage.js'
import { mapToZcodePlan, mapToBigModel, publicModelIds } from './models.js'
import { openaiToAnthropic, anthropicToOpenAI } from './protocol/convert.js'
import { pipeAnthropicToOpenAISSE, pipeAnthropicSSEWithUsage } from './protocol/stream.js'
import { fetchBalance } from './billing.js'
import { beginBigModelLogin } from './auth/bigmodel.js'
import { beginZaiLogin } from './auth/zai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp(deps) {
  const { config, store, pool, paramPool, gateway, requestLog, log = () => {} } = deps
  const app = express()
  app.use(express.json({ limit: '32mb' }))
  const logins = new Map()

  const isLocal = (req) => {
    const addr = req.socket.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }
  const panelAuth = (req, res, next) => {
    if (isLocal(req)) return next()
    if (config.panelPassword && req.get('x-panel-password') === config.panelPassword) return next()
    return res.status(401).json({ error: { message: 'panel password required for non-local access' } })
  }
  const v1Auth = (req, res, next) => {
    if (!config.apiKey) return res.status(500).json({ error: { message: 'API_KEY not configured (.env)' } })
    // 三种凭据来源必须**按优先级显式回退**。`??` 只对 null/undefined 生效，而
    // 未带 x-api-key 时 `req.get('x-api-key')` 返回 `undefined`、未带 authorization 时
    // `(req.get('authorization') || '')` 是**空串**——空串不是 nullish，`??` 会在它处短路，
    // 于是 `?key=` 永远读不到（实测三选一里只有 `?key=` 恒 401）。
    // 用 `||` 链：空串与 undefined 都视为"未提供"，继续往后取。
    const key = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key
    if (key !== config.apiKey) return res.status(401).json({ error: { message: 'invalid api key' } })
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
    const payload = fmt === 'anthropic'
      ? { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'api_error', message: err.message + (err.hint ? `（${err.hint}）` : '') } }
      : { error: { message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...(err.code != null ? { upstream_code: err.code } : {}) } }
    return res.status(status).json(payload)
  }

  const recordUsage = (account, usage) => {
    if (usage && account) pool.recordUsage(account.id, usage)
  }
  const logRequest = (entry) => requestLog.add(entry)

  app.post('/v1/chat/completions', v1Auth, async (req, res) => {
    const clientModel = req.body.model || 'glm-5.3'
    const sessionKey = req.get('x-session-id') ?? null
    try {
      const body = openaiToAnthropic(req.body, mapToZcodePlan)
      const { response, account } = await gateway.complete(body, { sessionKey })
      logRequest({ model: clientModel, account: account.id, stream: body.stream, status: 200 })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const usage = await pipeAnthropicToOpenAISSE(response, (s) => res.write(s), clientModel)
        await recordUsage(account, usage)
        return res.end()
      }
      const data = await response.json()
      await recordUsage(account, { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 })
      return res.json(anthropicToOpenAI(data, clientModel))
    } catch (e) {
      logRequest({ model: clientModel, stream: false, status: e.status ?? 502, error: e.message })
      return fail(res, e, 'openai')
    }
  })

  app.post('/v1/messages', v1Auth, async (req, res) => {
    const clientModel = req.body.model || 'glm-5.3'
    const sessionKey = req.get('x-session-id') ?? null
    try {
      const body = { ...req.body, model: mapToZcodePlan(req.body.model) }
      const { response, account } = await gateway.complete(body, { sessionKey })
      logRequest({ model: clientModel, account: account.id, stream: body.stream, status: 200 })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const usage = await pipeAnthropicSSEWithUsage(response, (c) => res.write(c))
        await recordUsage(account, usage)
        return res.end()
      }
      const data = await response.json()
      await recordUsage(account, { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 })
      return res.json(data)
    } catch (e) {
      if (e instanceof ParamPoolEmpty) {
        return res.status(503).json({ type: 'error', error: { type: 'api_error', message: `captcha param pool empty — 打开 ${farmUrl} 检查农场` } })
      }
      logRequest({ model: clientModel, stream: false, status: e.status ?? 502, error: e.message })
      return fail(res, e, 'anthropic')
    }
  })

  app.get('/', panelAuth, (req, res) => {
    // res.sendFile() 对缺失文件**不抛异常**，它异步把 ENOENT 交给 next(err)；故 try/catch 包不住它，
    // 只会在 Task 18 落地 dashboard/index.html 之前回 500。这里先判存在性：文件就绪后读文件，
    // 未就绪时返回占位页（brief 的既定行为）。
    const file = path.join(__dirname, 'dashboard', 'index.html')
    if (!fs.existsSync(file)) return res.status(200).send('<h1>zcode2api</h1>')
    return res.sendFile(file)
  })

  app.get('/pool/status', panelAuth, (req, res) => {
    res.json({ accounts: pool.status(), paramPool: paramPool.status(), farmUrl, requests: requestLog.list(50) })
  })

  app.post('/accounts/set', panelAuth, async (req, res) => {
    const { id, enabled } = req.body
    const updated = await store.update(id, { enabled: Boolean(enabled) })
    if (!updated) return res.status(404).json({ error: { message: 'account not found' } })
    res.json({ ok: true })
  })

  app.post('/accounts/delete', panelAuth, (req, res) => {
    res.json({ ok: store.delete(req.body.id) })
  })

  app.post('/accounts/balance/refresh', panelAuth, async (req, res) => {
    const results = []
    for (const acc of store.list().filter((a) => a.type === 'oauth' && a.jwt)) {
      try {
        const b = await fetchBalance({ jwt: acc.jwt, fetchImpl: deps.fetchImpl })
        await store.update(acc.id, { planCache: b })
        results.push({ id: acc.id, ok: true, balances: b.balances })
      } catch (e) {
        results.push({ id: acc.id, ok: false, error: e.message })
      }
    }
    res.json({ results })
  })

  app.post('/accounts/login/:provider/start', panelAuth, async (req, res) => {
    const { provider } = req.params
    try {
      let login
      if (provider === 'bigmodel') {
        login = await beginBigModelLogin({ fetchImpl: deps.fetchImpl })
      } else if (provider === 'zai') {
        login = await beginZaiLogin({ fetchImpl: deps.fetchImpl })
      } else {
        return res.status(404).json({ error: { message: 'unknown provider' } })
      }
      const loginId = crypto.randomUUID()
      logins.set(loginId, { provider, login, at: Date.now() })
      res.json({ loginId, authorizeUrl: login.authorizeUrl })
    } catch (e) {
      res.status(502).json({ error: { message: e.message } })
    }
  })

  app.post('/accounts/login/:provider/poll', panelAuth, async (req, res) => {
    const { loginId } = req.body
    const entry = logins.get(loginId)
    if (!entry) return res.status(404).json({ error: { message: 'login not found' } })
    const winner = await Promise.race([
      entry.login.result.then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
      new Promise((r) => setTimeout(() => r({ pending: true }), 500)),
    ])
    if (winner.pending) return res.json({ status: 'pending' })
    logins.delete(loginId)
    if (winner.ok) {
      const info = winner.r.userInfo ?? {}
      const account = await store.save(newAccountFields({
        provider: entry.provider,
        type: 'oauth',
        jwt: winner.r.token,
        accessToken: winner.r.accessToken,
        refreshToken: winner.r.refreshToken,
        userInfo: info,
      }))
      log(`[accounts] + ${account.id} via ${entry.provider} OAuth`)
      return res.json({ status: 'ready', account })
    }
    return res.json({ status: 'failed', error: winner.e.message })
  })

  app.post('/accounts/login/:provider/cancel', panelAuth, (req, res) => {
    const entry = logins.get(req.body.loginId)
    if (entry) {
      entry.login.cancel()
      entry.login.close?.()
      logins.delete(req.body.loginId)
    }
    res.json({ ok: true })
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
  const store = new AccountStore(config.poolDir)
  const pool = new AccountPool(store, { minIntervalMs: config.minIntervalMs, cooldown3012Ms: config.cooldown3012Ms })
  const paramPool = new ParamPool({ ttlMs: config.paramTtlMs, maxSize: config.poolSize })
  const requestLog = createRequestLog({})
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
  const app = createApp({ config, store, pool, paramPool, gateway, requestLog, log, farmUrl: farm.url })
  app.listen(config.port, config.host, () => {
    log(`[zcode2api] API      → http://${config.host}:${config.port}/v1`)
    log(`[zcode2api] 看板     → http://${config.host}:${config.port}/`)
    log(`[zcode2api] farm 页  → ${farm.url}（自动浏览器/手动打开均可，保持页面运行）`)
  })
  await launchFarmBrowser({ url: farm.url, headless: config.farmHeadless, chromePath: config.chromePath, log })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
