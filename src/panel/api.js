import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { newAccountFields } from '../auth/store.js'
import { fetchBalance } from '../billing.js'
import { beginBigModelLogin } from '../auth/bigmodel.js'
import { beginZaiLogin } from '../auth/zai.js'
import { readLocalZcodeCredentials } from '../auth/local-import.js'
import { maskSecret } from './settings.js'

/**
 * 管理面路由（看板用的全部接口）。
 *
 * 集中在一处的理由：这些接口共享同一套前置条件（面板鉴权、账号脱敏、池内时钟换算），
 * 拆散后每处都要重新记得"别把 jwt 回给前端""lastUsedAt 是池内时钟"，漏一处就是泄露或误导。
 */

/**
 * 账号脱敏投影。**绝不含 jwt / apiKey / accessToken / refreshToken**——面板只需要知道
 * "有没有凭据""是不是这一条"，原文一旦进过浏览器就等于多了一处泄露面。
 *
 * 时间换算：`stats.lastUsedAt` / `stats.lastError.at` 存的是**池内时钟值**（与节流同轴，
 * 注入假时钟时不是真纪元）。面板直接 `new Date()` 会得到 1970 附近的时刻，故这里用
 * "池内已流逝多久" 反推真实时刻：`realNow - (poolNow - t)`。
 */
export function enrichAccount(acc, { poolNow, realNow, healthy = null } = {}) {
  const balances = acc.planCache?.balances ?? []
  const total = balances.reduce((s, b) => s + (Number(b.total) || 0), 0)
  const remaining = balances.reduce((s, b) => s + (Number(b.remaining) || 0), 0)
  const cooldownRemainMs = Math.max(0, (acc.cooldownUntil ?? 0) - poolNow)
  const toRealIso = (poolTime) => {
    if (!poolTime) return null
    const elapsed = poolNow - poolTime
    return new Date(realNow - elapsed).toISOString()
  }
  const lastError = acc.stats?.lastError ?? null
  return {
    id: acc.id,
    provider: acc.provider,
    type: acc.type,
    enabled: acc.enabled !== false,
    needsRelogin: acc.needsRelogin === true,
    noPackage: acc.noPackage === true,
    strikes: acc.strikes ?? 0,
    cooldownRemainMs,
    cooldownUntilIso: cooldownRemainMs > 0 ? new Date(realNow + cooldownRemainMs).toISOString() : null,
    name: acc.userInfo?.name ?? null,
    email: acc.userInfo?.email ?? null,
    userId: acc.userInfo?.user_id ?? acc.userInfo?.id ?? null,
    planCache: acc.planCache ?? null,
    quota: balances.length ? { total, remaining, used: Math.max(0, total - remaining), pct: total > 0 ? (remaining / total) * 100 : 0 } : null,
    stats: {
      requests: acc.stats?.requests ?? 0,
      inputTokens: acc.stats?.inputTokens ?? 0,
      outputTokens: acc.stats?.outputTokens ?? 0,
      lastUsedAt: acc.stats?.lastUsedAt ?? 0,
      lastUsedAtIso: toRealIso(acc.stats?.lastUsedAt ?? 0),
      lastError: lastError ? { status: lastError.status ?? null, code: lastError.code ?? null, atIso: toRealIso(lastError.at ?? 0) } : null,
    },
    createdAt: acc.createdAt ?? null,
    createdAtIso: acc.createdAt ? new Date(acc.createdAt).toISOString() : null,
    hasJwt: Boolean(acc.jwt),
    hasApiKey: Boolean(acc.apiKey),
    secretMask: maskSecret(acc.jwt || acc.apiKey || ''),
    healthy: healthy === null ? null : healthy,
  }
}

/**
 * 账号 id 的 slug：**只允许 ASCII 字母数字与 `_`/`-`**，其余一律折叠成 `-`。
 *
 * 为什么不用 Unicode 白名单（让中文名字原样进 id）：账号文件名由 `store.safe()` 生成，
 * 它把非 ASCII 字符逐个替换成 `_`，于是"我的付费"和"甲乙丙丁"会映射到**同一个文件名**
 * ——两个账号互相覆盖。id 保持 ASCII 是避免这类静默冲突的前提。
 * 人类可读的名字放在 `userInfo.name` 里显示，不受此限制。
 *
 * 全非 ASCII 的输入（slug 为空）回落到随机十六进制：宁可 id 不好看，也不能出现空 slug
 * 让 `provider:apikey:` 这种 id 互相撞车。
 */
const safeSlug = (s) => {
  const cleaned = String(s).trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return cleaned.length >= 3 ? cleaned : crypto.randomBytes(4).toString('hex')
}

export function registerPanelRoutes(app, deps) {
  const {
    config, store, pool, paramPool, requestLog, usage, settings, auth,
    farmUrl = '', log = () => {}, dashboardFile,
    now = Date.now, fetchImpl,
    /**
     * 农场页自报的健康状态取值函数（`() => farm.report`）。
     * 它由 farm server 持有，而面板的池数据来自 `poolStatus()`——两者本不相通，
     * 不显式接进来的话面板永远显示"农场页未上报"（实测踩到）。
     */
    farmReport = () => null,
    // 以下三个可注入，便于测试覆盖各种凭据形态（生产走真实实现）
    readLocalCredentials = readLocalZcodeCredentials,
    localCredOptions = {},
    loginTtlMs = 10 * 60_000,
  } = deps

  /** 池状态 + 农场页自报状态：面板一处取全，避免两个数据源各说各话。 */
  const poolStatus = () => ({ ...paramPool.status(), farmReport: farmReport() })

  const panelAuth = auth.middleware()
  /** 登录会话：与面板 token 无关，是"正在进行的 OAuth 授权流程"。 */
  const logins = new Map()
  /** 管理面用自己的真实时钟换算展示时间（池内时钟可能被测试注入成假值）。 */
  const realNow = deps.realNow ?? Date.now

  const reapExpiredLogins = () => {
    const t = now()
    for (const [id, entry] of logins) {
      if (t - entry.at < loginTtlMs) continue
      try { entry.login.cancel?.() } catch (e) { log(`[accounts] login cancel failed: ${e?.message ?? e}`) }
      try { entry.login.close?.() } catch (e) { log(`[accounts] login close failed: ${e?.message ?? e}`) }
      logins.delete(id)
      log(`[accounts] reaped abandoned login ${id} (${entry.provider})`)
    }
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    log(`[panel] ${req.method} ${req.originalUrl} failed: ${err?.message ?? err}`)
    if (res.headersSent) return res.end()
    return res.status(500).json({ error: { message: err?.message ?? 'internal error' } })
  })

  const accountsView = () => {
    const poolNow = now()
    const rn = realNow()
    const raw = store.list()
    return raw.map((a) => enrichAccount(a, { poolNow, realNow: rn, healthy: pool.healthy(a) }))
  }

  // ─────────────────────────── 面板自身 ───────────────────────────

  /**
   * 免鉴权：前端必须先知道"要不要显示登录页"才能发别的请求。
   * 只回布尔与来源，不回任何凭据。
   */
  app.get('/panel/status', (req, res) => res.json(auth.status(req)))

  app.post('/panel/login', (req, res) => {
    const password = String(req.body?.password ?? '')
    if (!auth.hasPassword()) {
      return res.status(409).json({
        error: { message: '面板密码未设置', hint: '请在本机打开看板，在「设置」页设置面板密码' },
      })
    }
    if (!auth.verify(password)) {
      log(`[panel] 面板登录失败（来自 ${req.socket?.remoteAddress ?? 'unknown'}）`)
      return res.status(401).json({ error: { message: '密码错误' } })
    }
    res.json({ ok: true, token: auth.create(), ...auth.status(req) })
  })

  app.post('/panel/logout', (req, res) => {
    auth.revoke(auth.tokenFrom(req))
    res.json({ ok: true })
  })

  app.post('/panel/password', panelAuth, (req, res) => {
    const { current, next } = req.body ?? {}
    const r = auth.setPassword(String(current ?? ''), String(next ?? ''))
    if (!r.ok) return res.status(r.code ?? 400).json({ error: { message: r.error } })
    res.json({ ok: true, token: r.token })
  })

  // ─────────────────────────── 账号管理 ───────────────────────────

  app.get('/accounts', panelAuth, (req, res) => {
    const accounts = accountsView()
    const usable = accounts.filter((a) => a.healthy).length
    res.json({ accounts, total: accounts.length, usable, pool: poolStatus() })
  })

  app.post('/accounts/set', panelAuth, wrap(async (req, res) => {
    const { id, enabled } = req.body ?? {}
    if (!id) return res.status(400).json({ error: { message: 'id required' } })
    const updated = await store.update(id, { enabled: Boolean(enabled) })
    if (!updated) return res.status(404).json({ error: { message: 'account not found' } })
    log(`[accounts] ${id} ${enabled ? '启用' : '停用'}`)
    res.json({ ok: true })
  }))

  app.post('/accounts/set-all', panelAuth, wrap(async (req, res) => {
    const enabled = Boolean(req.body?.enabled)
    const ids = store.list().map((a) => a.id)
    // 逐个 update（而不是 save 整份快照）：update 走 per-id 锁的读-改-写，
    // 并发下的 lastUsedAt / stats 增量不会被整体覆盖回旧值。
    for (const id of ids) await store.update(id, { enabled })
    log(`[accounts] 批量${enabled ? '启用' : '停用'} ${ids.length} 个账号`)
    res.json({ ok: true, changed: ids.length })
  }))

  app.post('/accounts/delete', panelAuth, (req, res) => {
    const { id } = req.body ?? {}
    if (!id) return res.status(400).json({ error: { message: 'id required' } })
    const ok = store.delete(id)
    if (ok) log(`[accounts] 删除账号 ${id}`)
    res.json({ ok })
  })

  /**
   * 面板新增 API Key 账号（补上"手工往 accounts/ 丢一个 json"的体验缺口）。
   * 不校验 key 是否能打通上游：那要花一次真实请求，且失败原因可能与被拒的 key 无关；
   * 加进来之后面板会立刻显示它的健康状态，比一个可能误报的预检更有用。
   */
  app.post('/accounts/add-apikey', panelAuth, wrap(async (req, res) => {
    const provider = String(req.body?.provider ?? 'bigmodel').trim() || 'bigmodel'
    const apiKey = String(req.body?.apiKey ?? '').trim()
    const name = String(req.body?.name ?? '').trim()
    if (apiKey.length < 8) return res.status(400).json({ error: { message: 'API key 看起来不完整（至少 8 个字符）' } })
    if (!/^[\x20-\x7e]+$/.test(apiKey)) return res.status(400).json({ error: { message: 'API key 含非 ASCII 字符，请检查是否复制到了多余内容' } })
    const slug = safeSlug(name)
    // `newAccountFields` 会拼成 `${provider}:${userInfo.id ?? userInfo.user_id}`，
    // 故这里只给 `apikey:<slug>` 这一段，让最终 id 形如 `bigmodel:apikey:<slug>`
    // （把完整 id 传进去会得到 `bigmodel:bigmodel:apikey:...` 的双前缀）。
    const uid = `apikey:${slug}`
    const id = `${provider}:${uid}`
    if (store.get(id)) return res.status(409).json({ error: { message: `账号 ${id} 已存在，请换一个名字` } })
    const account = await store.save(newAccountFields({
      provider,
      type: 'apikey',
      apiKey,
      userInfo: { id: uid, name: name || `API Key ${slug}` },
    }))
    log(`[accounts] + ${account.id}（面板新增 API Key 账号）`)
    res.json({ ok: true, id: account.id })
  }))

  app.post('/accounts/balance/refresh', panelAuth, wrap(async (req, res) => {
    const { id } = req.body ?? {}
    const targets = (id ? store.list().filter((a) => a.id === id) : store.list())
      .filter((a) => a.type === 'oauth' && a.jwt)
    const results = []
    for (const acc of targets) {
      try {
        const b = await fetchBalance({ jwt: acc.jwt, fetchImpl })
        await store.update(acc.id, { planCache: b })
        results.push({ id: acc.id, ok: true, balances: b.balances })
      } catch (e) {
        results.push({ id: acc.id, ok: false, error: e.message })
      }
    }
    res.json({ results })
  }))

  app.post('/accounts/import/local', panelAuth, wrap(async (req, res) => {
    const r = readLocalCredentials(localCredOptions)
    if (!r.ok) return res.status(400).json({ error: { message: r.message, reason: r.reason } })
    const imported = []
    for (const a of r.accounts) {
      const account = await store.save(newAccountFields({
        provider: a.provider, type: 'oauth', jwt: a.jwt,
        accessToken: a.accessToken, refreshToken: a.refreshToken, userInfo: a.userInfo,
      }))
      log(`[accounts] imported local ZCode login ${account.id} (${a.provider})`)
      imported.push(account)
    }
    // 顺带把余额取回来，看板导入后立刻能看到套餐余量（失败不影响导入结果）
    for (const acc of imported) {
      try {
        const b = await fetchBalance({ jwt: acc.jwt, fetchImpl })
        await store.update(acc.id, { planCache: b })
      } catch { /* 余额查询失败不阻断导入 */ }
    }
    res.json({ ok: true, source: r.source, accounts: imported.map((a) => a.id) })
  }))

  // ─────────────────────────── OAuth 登录 ───────────────────────────

  app.post('/accounts/login/:provider/start', panelAuth, wrap(async (req, res) => {
    const { provider } = req.params
    reapExpiredLogins()
    try {
      let login
      if (provider === 'bigmodel') login = await beginBigModelLogin({ fetchImpl })
      else if (provider === 'zai') login = await beginZaiLogin({ fetchImpl })
      else return res.status(404).json({ error: { message: 'unknown provider' } })
      const loginId = crypto.randomUUID()
      logins.set(loginId, { provider, login, at: now() })
      res.json({ loginId, authorizeUrl: login.authorizeUrl })
    } catch (e) {
      res.status(502).json({ error: { message: e.message } })
    }
  }))

  app.post('/accounts/login/:provider/poll', panelAuth, wrap(async (req, res) => {
    reapExpiredLogins()
    const { loginId } = req.body ?? {}
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
        provider: entry.provider, type: 'oauth', jwt: winner.r.token,
        accessToken: winner.r.accessToken, refreshToken: winner.r.refreshToken, userInfo: info,
      }))
      log(`[accounts] + ${account.id} via ${entry.provider} OAuth`)
      return res.json({ status: 'ready', account: enrichAccount(account, { poolNow: now(), realNow: realNow() }) })
    }
    return res.json({ status: 'failed', error: winner.e.message })
  }))

  app.post('/accounts/login/:provider/cancel', panelAuth, (req, res) => {
    const entry = logins.get(req.body?.loginId)
    if (entry) {
      entry.login.cancel()
      entry.login.close?.()
      logins.delete(req.body.loginId)
    }
    res.json({ ok: true })
  })

  // ─────────────────────────── 用量 ───────────────────────────

  app.get('/usage/recent', panelAuth, (req, res) => {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit) || 60)))
    // total 取聚合里的总记录数（走缓存），而不是内存缓冲的长度——后者被 recentMax 截断，
    // 拿它当"总条数"会显示成一个永远不超过 200 的假值。
    res.json({ rows: usage.recent(limit), total: usage.analytics().total_records })
  })

  app.get('/usage/analytics', panelAuth, (req, res) => res.json(usage.analytics()))

  app.get('/usage/by-account', panelAuth, (req, res) => res.json({ accounts: usage.byAccount() }))

  // ─────────────────────────── 设置 ───────────────────────────

  app.get('/settings', panelAuth, (req, res) => {
    res.json(settings.view({
      farmUrl,
      usageDir: path.dirname(usage.logFile),
      paramPoolStatus: poolStatus(),
    }))
  })

  app.post('/settings/save', panelAuth, (req, res) => {
    const r = settings.save(req.body ?? {})
    const ok = Object.keys(r.errors).length === 0
    if (!ok) log(`[panel] 设置部分未生效：${JSON.stringify(r.errors)}`)
    res.json({ ok, ...r, settings: settings.view({ farmUrl, usageDir: path.dirname(usage.logFile), paramPoolStatus: poolStatus() }) })
  })

  // ─────────────────────────── 兼容与运维 ───────────────────────────

  /** 旧看板/脚本仍在用；保留字段形状不变，另加账号明细。 */
  app.get('/pool/status', panelAuth, (req, res) => {
    res.json({ accounts: pool.status(), paramPool: poolStatus(), farmUrl, requests: requestLog.list(50) })
  })

  /**
   * 构建号：面板轮询它，发现变化就整页重载。
   * 没有它，服务重启/换端口后旧标签页会继续跑旧 JS，报出"改完没生效"这类假故障。
   */
  const buildId = () => {
    try {
      const st = fs.statSync(dashboardFile)
      return crypto.createHash('sha256').update(`${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 12)
    } catch {
      return 'dev'
    }
  }
  app.get('/build', (req, res) => res.json({ build: buildId() }))

  return { accountsView, reapExpiredLogins }
}
