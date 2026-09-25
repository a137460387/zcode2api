import { describe, it, expect } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/server.js'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'
import { ParamPool } from '../src/captcha/pool.js'
import { createRequestLog, UsageStore } from '../src/usage.js'
import { RuntimeSettings } from '../src/panel/settings.js'
import { enrichAccount } from '../src/panel/api.js'

const SECRET_JWT = 'eyJhbGciOi.SECRET-JWT-PAYLOAD-DO-NOT-LEAK.signature'
const SECRET_APIKEY = 'sk-SECRET-APIKEY-DO-NOT-LEAK-1234'

function buildDeps(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-papi-'))
  const store = new AccountStore(dir)
  const config = {
    rootDir: dir, apiKey: 'sk-panel', panelPassword: 'panel-pw', port: 0, poolDir: dir,
    maxRetries: 2, panelLocalBypass: true, minIntervalMs: 2000, cooldown3012Ms: 30 * 60_000,
    paramTtlMs: 480_000, poolSize: 6, farmUrl: 'http://127.0.0.1:28631/farm',
  }
  const pool = new AccountPool(store, { minIntervalMs: 2000, cooldown3012Ms: 30 * 60_000 })
  const paramPool = new ParamPool({})
  const usage = new UsageStore({ dir: path.join(dir, 'usage'), log: () => {} })
  const settings = new RuntimeSettings({
    config, pool, paramPool, envFile: path.join(dir, '.env'), panelFile: path.join(dir, 'panel.json'), log: () => {},
  })
  const gateway = { complete: async () => ({ response: { status: 200, json: async () => ({}) }, account: { id: 'x' } }) }
  return {
    config, store, pool, paramPool, usage, settings, gateway, dir,
    requestLog: createRequestLog({}), log: () => {}, farmUrl: config.farmUrl,
    ...over,
  }
}

const withAccount = async (deps, over = {}) => {
  await deps.store.save(newAccountFields({
    provider: 'bigmodel', type: 'oauth', jwt: SECRET_JWT,
    userInfo: { user_id: '42', email: 'a@b.c', name: '张三' },
    ...over,
  }))
  return deps
}

describe('GET /accounts：脱敏是硬约束', () => {
  it('账号列表不含 jwt / accessToken / refreshToken 原文', async () => {
    const deps = await withAccount(buildDeps())
    const r = await request(createApp(deps)).get('/accounts')
    expect(r.status).toBe(200)
    const raw = JSON.stringify(r.body)
    expect(raw).not.toContain(SECRET_JWT)
    expect(raw).not.toContain('SECRET-JWT-PAYLOAD')
    expect(r.body.accounts[0].hasJwt).toBe(true)
    expect(r.body.accounts[0].jwt).toBeUndefined()
    expect(r.body.accounts[0].accessToken).toBeUndefined()
    expect(r.body.accounts[0].refreshToken).toBeUndefined()
    expect(r.body.accounts[0].secretMask).toContain('…')
  })

  it('apikey 账号同样只回掩码', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: SECRET_APIKEY, userInfo: { id: 'k1', name: '付费' } }))
    const r = await request(createApp(deps)).get('/accounts')
    expect(JSON.stringify(r.body)).not.toContain(SECRET_APIKEY)
    expect(r.body.accounts[0].hasApiKey).toBe(true)
    expect(r.body.accounts[0].hasJwt).toBe(false)
  })

  it('返回账号状态、套餐余量与健康标记', async () => {
    const deps = await withAccount(buildDeps())
    await deps.store.update('bigmodel:42', {
      planCache: { plans: [], balances: [{ entitlementId: 'e', modelName: 'GLM-5.3', total: 100, used: 30, remaining: 70 }] },
      strikes: 2,
      stats: { requests: 5, inputTokens: 100, outputTokens: 20, lastUsedAt: Date.now() - 5000, lastError: { status: 429, code: 3012, at: Date.now() - 60_000 } },
    })
    const r = await request(createApp(deps)).get('/accounts')
    const a = r.body.accounts[0]
    expect(a.strikes).toBe(2)
    expect(a.quota).toEqual({ total: 100, remaining: 70, used: 30, pct: 70 })
    expect(a.stats.requests).toBe(5)
    expect(a.healthy).toBe(true)
    expect(r.body.total).toBe(1)
    expect(r.body.usable).toBe(1)
    // 时间必须是真实纪元（可被 new Date 解析出合理年份），而不是池内时钟的 1970
    expect(new Date(a.stats.lastUsedAtIso).getFullYear()).toBeGreaterThan(2020)
    expect(new Date(a.stats.lastError.atIso).getFullYear()).toBeGreaterThan(2020)
  })

  it('停用/冷却/需重登/无套餐的账号 healthy 为 false', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'a' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'b' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'c' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'd' } }))
    await deps.store.update('bigmodel:a', { enabled: false })
    await deps.store.update('bigmodel:b', { cooldownUntil: Date.now() + 600_000 })
    await deps.store.update('bigmodel:c', { needsRelogin: true })
    await deps.store.update('bigmodel:d', { noPackage: true })
    const r = await request(createApp(deps)).get('/accounts')
    expect(r.body.usable).toBe(0)
    const byId = Object.fromEntries(r.body.accounts.map((a) => [a.id, a]))
    expect(byId['bigmodel:b'].cooldownRemainMs).toBeGreaterThan(500_000)
    expect(byId['bigmodel:b'].cooldownUntilIso).toBeTruthy()
  })
})

describe('enrichAccount：池内时钟 → 真实时刻', () => {
  it('注入假池内时钟时，展示时间仍落在真实纪元上', () => {
    const realNow = 1_800_000_000_000
    const poolNow = 5_000_000 // 假时钟
    const acc = { id: 'x', provider: 'p', type: 'oauth', stats: { lastUsedAt: poolNow - 3000, lastError: { status: 429, at: poolNow - 10_000 } } }
    const e = enrichAccount(acc, { poolNow, realNow })
    // 池内"3 秒前"应换算成真实的 3 秒前
    expect(new Date(e.stats.lastUsedAtIso).getTime()).toBe(realNow - 3000)
    expect(new Date(e.stats.lastError.atIso).getTime()).toBe(realNow - 10_000)
  })

  it('从未使用时 lastUsedAtIso 为 null（不显示 1970）', () => {
    const e = enrichAccount({ id: 'x', stats: { lastUsedAt: 0 } }, { poolNow: 1000, realNow: 2_000_000 })
    expect(e.stats.lastUsedAtIso).toBeNull()
  })

  it('缺少 stats 字段时不抛异常', () => {
    const e = enrichAccount({ id: 'x', provider: 'p', type: 'oauth' }, { poolNow: 0, realNow: 0 })
    expect(e.stats.requests).toBe(0)
    expect(e.quota).toBeNull()
  })
})

describe('账号操作', () => {
  it('set 启用停用；不存在的 id → 404', async () => {
    const deps = await withAccount(buildDeps())
    const app = createApp(deps)
    expect((await request(app).post('/accounts/set').send({ id: 'bigmodel:42', enabled: false })).status).toBe(200)
    expect((await request(app).get('/accounts')).body.accounts[0].enabled).toBe(false)
    expect((await request(app).post('/accounts/set').send({ id: 'nope', enabled: true })).status).toBe(404)
    expect((await request(app).post('/accounts/set').send({ enabled: true })).status).toBe(400)
  })

  it('set-all 批量操作', async () => {
    const deps = buildDeps()
    for (const uid of ['1', '2', '3']) await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: uid } }))
    const app = createApp(deps)
    const r = await request(app).post('/accounts/set-all').send({ enabled: false })
    expect(r.body.changed).toBe(3)
    expect((await request(app).get('/accounts')).body.accounts.every((a) => !a.enabled)).toBe(true)
    await request(app).post('/accounts/set-all').send({ enabled: true })
    expect((await request(app).get('/accounts')).body.accounts.every((a) => a.enabled)).toBe(true)
  })

  it('set-all 不会覆盖并发写入的 stats（用 update 而非 save 整份快照）', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: '1' } }))
    const app = createApp(deps)
    // 批量停用与 usage 记账并发：统计不该被旧快照回滚
    await Promise.all([
      request(app).post('/accounts/set-all').send({ enabled: false }),
      deps.pool.recordUsage('bigmodel:1', { inputTokens: 10, outputTokens: 5 }),
    ])
    const a = deps.store.get('bigmodel:1')
    expect(a.stats.inputTokens).toBe(10)
    expect(a.enabled).toBe(false)
  })

  it('delete 删除账号', async () => {
    const deps = await withAccount(buildDeps())
    const app = createApp(deps)
    expect((await request(app).post('/accounts/delete').send({ id: 'bigmodel:42' })).body.ok).toBe(true)
    expect((await request(app).get('/accounts')).body.accounts).toEqual([])
    expect((await request(app).post('/accounts/delete').send({ id: 'bigmodel:42' })).body.ok).toBe(false)
    expect((await request(app).post('/accounts/delete').send({})).status).toBe(400)
  })

  it('add-apikey：建号、回显 id、列表可见', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    const r = await request(app).post('/accounts/add-apikey').send({ name: '我的付费 key', apiKey: 'sk-abcdefgh12345678' })
    expect(r.status).toBe(200)
    // id 的 slug 只取 ASCII 部分（中文名字会让 store 的文件名发生碰撞，见 safeSlug 注释），
    // 完整中文名字保存在 userInfo.name 里用于展示。
    expect(r.body.id).toBe('bigmodel:apikey:key')
    const a = deps.store.get(r.body.id)
    expect(a.type).toBe('apikey')
    expect(a.apiKey).toBe('sk-abcdefgh12345678')
    expect(a.userInfo.name).toBe('我的付费 key')
    expect(a.enabled).toBe(true)
    expect(a.stats.requests).toBe(0)
  })

  it('add-apikey：全中文名字回落到随机 slug（不产生空 id、不与别人撞车）', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    const a = await request(app).post('/accounts/add-apikey').send({ name: '我的付费', apiKey: 'sk-abcdefgh12345678' })
    const b = await request(app).post('/accounts/add-apikey').send({ name: '甲乙丙丁', apiKey: 'sk-abcdefgh87654321' })
    expect(a.body.id).toMatch(/^bigmodel:apikey:[0-9a-f]{8}$/)
    expect(b.body.id).not.toBe(a.body.id)
    expect(deps.store.get(a.body.id).userInfo.name).toBe('我的付费')
  })

  it('add-apikey：过短、非 ASCII、重复 id 分别被拒', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    expect((await request(app).post('/accounts/add-apikey').send({ apiKey: 'short' })).status).toBe(400)
    expect((await request(app).post('/accounts/add-apikey').send({ apiKey: 'sk-中文密钥-1234567' })).status).toBe(400)
    await request(app).post('/accounts/add-apikey').send({ name: 'dup', apiKey: 'sk-abcdefgh12345678' })
    const again = await request(app).post('/accounts/add-apikey').send({ name: 'dup', apiKey: 'sk-other-key-12345678' })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/已存在/)
  })

  it('add-apikey：不带名字时也能建（用随机后缀，且不覆盖别人）', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    const a = await request(app).post('/accounts/add-apikey').send({ apiKey: 'sk-abcdefgh12345678' })
    const b = await request(app).post('/accounts/add-apikey').send({ apiKey: 'sk-abcdefgh87654321' })
    expect(a.body.id).not.toBe(b.body.id)
    expect((await request(app).get('/accounts')).body.accounts.length).toBe(2)
  })

  it('add-apikey 的 id 不会逃出账号目录（../ 与分隔符被清洗）', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    const r = await request(app).post('/accounts/add-apikey').send({ name: '../../evil', apiKey: 'sk-abcdefgh12345678' })
    expect(r.body.id).not.toContain('..')
    expect(r.body.id).not.toContain('/')
    expect(r.body.id).not.toContain('\\')
    expect(fs.readdirSync(deps.dir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
    // 落盘文件必须在账号目录内（不是被写到上级去）
    expect(fs.readdirSync(deps.dir).some((f) => f.includes('evil'))).toBe(true)
  })

  it('balance/refresh 只刷 oauth 账号，并把失败原因逐账号回报', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J1', userInfo: { user_id: '1' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k', userInfo: { id: '2' } }))
    const fetchImpl = async () => ({
      status: 200,
      json: async () => ({ code: 0, data: { plans: [], balances: [{ entitlement_id: 'e', show_name: 'GLM-5.3', total_units: 10, used_units: 1, available_units: 9 }] } }),
    })
    const r = await request(createApp({ ...deps, fetchImpl })).post('/accounts/balance/refresh').send({})
    expect(r.body.results).toHaveLength(1) // apikey 账号不参与
    expect(r.body.results[0].ok).toBe(true)
    expect(deps.store.get('bigmodel:1').planCache.balances[0].remaining).toBe(9)
  })

  it('balance/refresh 可只刷指定 id', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J1', userInfo: { user_id: '1' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'J2', userInfo: { user_id: '2' } }))
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push(opts?.headers?.authorization ?? url)
      return { status: 200, json: async () => ({ code: 0, data: { balances: [] } }) }
    }
    const r = await request(createApp({ ...deps, fetchImpl })).post('/accounts/balance/refresh').send({ id: 'bigmodel:2' })
    expect(r.body.results).toHaveLength(1)
    expect(r.body.results[0].id).toBe('bigmodel:2')
    expect(calls).toHaveLength(1)
  })
})

describe('用量接口', () => {
  it('recent / analytics / by-account 形状正确', async () => {
    const deps = buildDeps()
    const now = Date.now()
    await deps.usage.record({ at: now, model: 'glm-5.3', account: 'bigmodel:1', stream: true, status: 200, prompt_tokens: 10, completion_tokens: 4, ttft_ms: 50, tokens_per_sec: 20 })
    await deps.usage.record({ at: now, model: 'glm-5.3-flash', account: 'bigmodel:2', stream: false, status: 502, error: 'boom' })
    const app = createApp(deps)
    const recent = await request(app).get('/usage/recent?limit=5')
    expect(recent.body.rows).toHaveLength(2)
    expect(recent.body.total).toBe(2)
    const an = await request(app).get('/usage/analytics')
    expect(an.body.summary.all_time.requests).toBe(2)
    expect(an.body.summary.all_time.errors).toBe(1)
    expect(an.body.models.map((m) => m.id).sort()).toEqual(['glm-5.3', 'glm-5.3-flash'])
    const byAcct = await request(app).get('/usage/by-account')
    expect(byAcct.body.accounts).toHaveLength(2)
  })

  it('limit 被钳制在 1..500', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    expect((await request(app).get('/usage/recent?limit=99999')).status).toBe(200)
    expect((await request(app).get('/usage/recent?limit=-3')).status).toBe(200)
    expect((await request(app).get('/usage/recent?limit=abc')).status).toBe(200)
  })
})

describe('设置接口', () => {
  it('GET /settings 回运行信息与掩码，不含密钥原文', async () => {
    const deps = buildDeps()
    const r = await request(createApp(deps)).get('/settings')
    expect(r.body.apiKeySet).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain('sk-panel')
    expect(r.body.runtime.minIntervalMs).toBe(2000)
    expect(r.body.accountsDir).toBe(deps.dir)
  })

  it('POST /settings/save 热更新并写回 .env', async () => {
    const deps = buildDeps()
    const r = await request(createApp(deps)).post('/settings/save').send({ minIntervalMs: 3500, poolSize: 4 })
    expect(r.body.ok).toBe(true)
    expect(deps.pool.minIntervalMs).toBe(3500)
    expect(deps.paramPool.maxSize).toBe(4)
    expect(fs.readFileSync(path.join(deps.dir, '.env'), 'utf8')).toContain('ACCOUNT_MIN_INTERVAL_MS=3500')
    expect(r.body.settings.runtime.minIntervalMs).toBe(3500)
  })

  it('非法值：ok=false、errors 逐字段、合法字段仍生效', async () => {
    const deps = buildDeps()
    const r = await request(createApp(deps)).post('/settings/save').send({ minIntervalMs: 'abc', maxRetries: 5 })
    expect(r.body.ok).toBe(false)
    expect(r.body.errors.minIntervalMs).toBeTruthy()
    expect(deps.config.maxRetries).toBe(5)
  })

  it('改 API Key 后 /v1 立即认新 key、旧 key 失效', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    expect((await request(app).post('/v1/chat/completions').set('authorization', 'Bearer sk-panel').send({})).status).not.toBe(401)
    await request(app).post('/settings/save').send({ apiKey: 'sk-new-key-987654321' })
    expect((await request(app).post('/v1/chat/completions').set('authorization', 'Bearer sk-panel').send({})).status).toBe(401)
    expect((await request(app).post('/v1/chat/completions').set('authorization', 'Bearer sk-new-key-987654321').send({})).status).not.toBe(401)
  })
})

describe('面板登录流程（HTTP 层）', () => {
  const remoteDeps = () => ({ ...buildDeps(), isLocal: () => false })

  it('/panel/status 免鉴权，且如实报告来源与是否已认证', async () => {
    const deps = remoteDeps()
    const r = await request(createApp(deps)).get('/panel/status')
    expect(r.status).toBe(200)
    expect(r.body.passwordRequired).toBe(true)
    expect(r.body.authenticated).toBe(false)
    expect(r.body.passwordSource).toBe('env')
    expect(r.body.usingBootstrapPassword).toBe(true)
  })

  it('登录 → token 可用 → 登出后失效', async () => {
    const app = createApp(remoteDeps())
    const bad = await request(app).post('/panel/login').send({ password: 'wrong' })
    expect(bad.status).toBe(401)
    const login = await request(app).post('/panel/login').send({ password: 'panel-pw' })
    expect(login.status).toBe(200)
    const token = login.body.token
    expect(token).toBeTruthy()
    expect((await request(app).get('/accounts').set('x-panel-token', token)).status).toBe(200)
    expect((await request(app).get('/accounts')).status).toBe(401)
    await request(app).post('/panel/logout').set('x-panel-token', token).send({})
    expect((await request(app).get('/accounts').set('x-panel-token', token)).status).toBe(401)
  })

  it('改密：旧密码错 → 401；成功后旧 token 失效、返回的新 token 可用', async () => {
    const app = createApp(remoteDeps())
    const token = (await request(app).post('/panel/login').send({ password: 'panel-pw' })).body.token
    expect((await request(app).post('/panel/password').set('x-panel-token', token).send({ current: 'nope', next: 'brand-new-pw' })).status).toBe(401)
    const r = await request(app).post('/panel/password').set('x-panel-token', token).send({ current: 'panel-pw', next: 'brand-new-pw' })
    expect(r.status).toBe(200)
    expect((await request(app).get('/accounts').set('x-panel-token', token)).status).toBe(401)
    expect((await request(app).get('/accounts').set('x-panel-token', r.body.token)).status).toBe(200)
    // 新密码可用于再次登录，旧密码不行
    expect((await request(app).post('/panel/login').send({ password: 'panel-pw' })).status).toBe(401)
    expect((await request(app).post('/panel/login').send({ password: 'brand-new-pw' })).status).toBe(200)
  })

  it('未设置面板密码时登录回 409 并给出可操作提示（不是 401 死胡同）', async () => {
    const base = buildDeps()
    const deps = { ...base, isLocal: () => false, config: { ...base.config, panelPassword: '' } }
    const r = await request(createApp(deps)).post('/panel/login').send({ password: 'anything' })
    expect(r.status).toBe(409)
    expect(r.body.error.hint).toMatch(/设置/)
  })

  it('改密写入的 panel.json 落在 rootDir 下且不含明文', async () => {
    const deps = remoteDeps()
    const app = createApp(deps)
    const token = (await request(app).post('/panel/login').send({ password: 'panel-pw' })).body.token
    await request(app).post('/panel/password').set('x-panel-token', token).send({ current: 'panel-pw', next: 'super-secret-pw' })
    const file = path.join(deps.dir, 'panel.json')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('super-secret-pw')
  })
})

describe('管理面鉴权覆盖所有新端点', () => {
  const paths = [
    ['get', '/accounts'], ['post', '/accounts/set'], ['post', '/accounts/set-all'],
    ['post', '/accounts/delete'], ['post', '/accounts/add-apikey'],
    ['post', '/accounts/balance/refresh'], ['post', '/accounts/import/local'],
    ['get', '/usage/recent'], ['get', '/usage/analytics'], ['get', '/usage/by-account'],
    ['get', '/settings'], ['post', '/settings/save'], ['get', '/pool/status'],
    ['post', '/accounts/login/bigmodel/start'],
  ]
  it.each(paths)('非本机无凭据 → %s %s 回 401', async (method, p) => {
    const deps = { ...buildDeps(), isLocal: () => false }
    const r = await request(createApp(deps))[method](p).send({})
    expect(r.status).toBe(401)
  })

  it('/build 免鉴权（面板要能自检构建号）', async () => {
    const deps = { ...buildDeps(), isLocal: () => false }
    expect((await request(createApp(deps)).get('/build')).status).toBe(200)
  })

  it('/health 免鉴权（启动器用它探测服务是否在跑）', async () => {
    const deps = { ...buildDeps(), isLocal: () => false }
    expect((await request(createApp(deps)).get('/health')).status).toBe(200)
  })
})

// 农场页自报状态必须出现在面板读取的池数据里。
// 实测踩到：farmReport 只挂在 farm server 的 /param-status 上，而面板的池数据来自
// paramPool.status()——两者不通，面板永远显示"农场页未上报"，卡住时用户看不到原因。
describe('农场页状态接入面板', () => {
  it('/accounts 的 pool 里带出 farmReport', async () => {
    const deps = buildDeps()
    const report = { at: 1_800_000_000_000, total: 5, pushed: 5, fails: 0, backoffMs: 0, stuck: false, lastLine: '[10:00] ok' }
    const r = await request(createApp({ ...deps, farmReport: () => report })).get('/accounts')
    expect(r.body.pool.farmReport).toEqual(report)
    expect(r.body.pool.pool).toBe(0)
  })

  it('农场页从未上报时为 null（面板显示"未上报"而不是报错）', async () => {
    const deps = buildDeps()
    const r = await request(createApp(deps)).get('/accounts')
    expect(r.body.pool.farmReport).toBeNull()
  })

  it('/settings 也带出同一个 farmReport', async () => {
    const deps = buildDeps()
    const report = { at: Date.now(), total: 2, pushed: 2, fails: 1, backoffMs: 8000, stuck: true, lastLine: '卡住' }
    const r = await request(createApp({ ...deps, farmReport: () => report })).get('/settings')
    expect(r.body.paramPool.farmReport).toEqual(report)
  })
})

// 面板的模型清单从服务端取：前端硬编码那次把别名当模型列出来，2 个模型看起来像 3 个。
describe('/models 模型目录', () => {
  it('返回 2 个模型，别名另列', async () => {
    const r = await request(createApp(buildDeps())).get('/models')
    expect(r.status).toBe(200)
    expect(r.body.models).toHaveLength(2)
    expect(r.body.models.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(r.body.aliases.length).toBeGreaterThan(0)
    const ids = r.body.models.map((m) => m.id)
    for (const a of r.body.aliases) expect(ids).not.toContain(a.pattern)
  })

  it('非本机无凭据 → 401（与其它管理面接口一致）', async () => {
    const deps = { ...buildDeps(), isLocal: () => false }
    expect((await request(createApp(deps)).get('/models')).status).toBe(401)
  })
})

// 重新导入本机登录不该抹掉历史统计。实测：用户点了「扫描本机 ZCode 登录」后
// 面板上请求数变 0、token 归零，看着像账丢了。
describe('重新导入保留历史统计', () => {
  it('同一账号再次导入：凭据更新、统计保留', async () => {
    const deps = buildDeps()
    const read = () => ({
      ok: true,
      source: 'test',
      accounts: [{ provider: 'bigmodel', type: 'oauth', jwt: 'NEWJWT', accessToken: 'AT', refreshToken: 'RT', userInfo: { user_id: '42', email: 'a@b.c' } }],
    })
    const app = createApp({ ...deps, readLocalCredentials: read })
    await request(app).post('/accounts/import/local').send({})
    expect(deps.store.get('bigmodel:42').jwt).toBe('NEWJWT')
    // 模拟已有使用历史
    await deps.store.update('bigmodel:42', {
      stats: { requests: 99, inputTokens: 5000, outputTokens: 900, lastUsedAt: 1, lastError: null },
      strikes: 1,
    })
    await request(app).post('/accounts/import/local').send({})
    const a = deps.store.get('bigmodel:42')
    expect(a.jwt).toBe('NEWJWT')
    expect(a.stats.requests).toBe(99)
    expect(a.stats.inputTokens).toBe(5000)
    expect(a.strikes).toBe(1)
  })
})

// 账号行的用量必须与「用量分析」同源，否则会出现"账号行 请求 0 / 用量分析有记录"这种
// 自相矛盾（实测：重新导入把账号自带的计数器清零后，两处数字对不上）。
describe('/accounts 的用量取自落盘日志', () => {
  it('账号行用量来自 usage.jsonl，而不是账号自带的 stats 计数器', async () => {
    const deps = await withAccount(buildDeps())
    // 账号计数器留空（模拟被覆盖后的状态），日志里有真实记录
    await deps.usage.record({ at: Date.now(), model: 'glm-5.3', account: 'bigmodel:42', prompt_tokens: 100, cache_read_tokens: 20, completion_tokens: 7, status: 200 })
    await deps.usage.record({ at: Date.now(), model: 'glm-5.3', account: 'bigmodel:42', prompt_tokens: 5, completion_tokens: 1, status: 200 })
    const r = await request(createApp(deps)).get('/accounts')
    const a = r.body.accounts[0]
    expect(deps.store.get('bigmodel:42').stats.requests).toBe(0) // 自带计数器确实是空的
    expect(a.usage.requests).toBe(2)                            // 面板显示的是日志里的真数
    expect(a.usage.promptTokens).toBe(105)
    expect(a.usage.cacheReadTokens).toBe(20)
    expect(a.usage.completionTokens).toBe(8)
    expect(a.usage.totalTokens).toBe(133)
  })

  it('日志里没有该账号时用量为 0（不报错、不显示 null）', async () => {
    const deps = await withAccount(buildDeps())
    const a = (await request(createApp(deps)).get('/accounts')).body.accounts[0]
    expect(a.usage).toEqual({ requests: 0, promptTokens: 0, cacheReadTokens: 0, completionTokens: 0, totalTokens: 0 })
  })
})

// 扫描导入要能带出逐实例诊断：多开用户最需要知道"我另一个客户端的号到底进来了没"。
describe('扫描本机登录：多实例与 Coding Plan', () => {
  it('逐实例诊断随响应返回（含未登录的实例）', async () => {
    const deps = buildDeps()
    const read = () => ({
      ok: true,
      accounts: [
        { type: 'oauth', provider: 'bigmodel', jwt: 'J1', userInfo: { user_id: '1' }, source: { label: '默认实例', file: 'a' } },
        { type: 'apikey', provider: 'bigmodel', apiKey: 'aaaa.bbbb', userInfo: { id: 'coding-plan:9', name: 'plan 9' }, source: { label: '多开实例 1', file: 'b' } },
      ],
      sources: [
        { label: '默认实例', ok: true, oauth: true },
        { label: '多开实例 1', ok: true, apiKeys: 1 },
        { label: '多开实例 2', ok: false, reason: 'no_jwt' },
      ],
    })
    const r = await request(createApp({ ...deps, readLocalCredentials: read })).post('/accounts/import/local').send({})
    expect(r.status).toBe(200)
    expect(r.body.accounts).toHaveLength(2)
    expect(r.body.byType).toEqual({ oauth: 1, apikey: 1 })
    expect(r.body.sources).toHaveLength(3)
    expect(r.body.sources[2]).toMatchObject({ label: '多开实例 2', ok: false, reason: 'no_jwt' })
  })

  it('两类账号按各自的类型入库（apikey 不写 jwt，oauth 不写 apiKey）', async () => {
    const deps = buildDeps()
    const read = () => ({
      ok: true,
      accounts: [
        { type: 'oauth', provider: 'bigmodel', jwt: 'J1', accessToken: 'AT', userInfo: { user_id: '1' }, source: { label: '默认实例' } },
        { type: 'apikey', provider: 'bigmodel', apiKey: 'k'.repeat(40) + '.x', userInfo: { id: 'coding-plan:9' }, source: { label: '多开实例 1' } },
      ],
      sources: [],
    })
    await request(createApp({ ...deps, readLocalCredentials: read })).post('/accounts/import/local').send({})
    const oauth = deps.store.get('bigmodel:1')
    expect(oauth.type).toBe('oauth')
    expect(oauth.jwt).toBe('J1')
    expect(oauth.apiKey).toBeNull()
    const key = deps.store.get('bigmodel:coding-plan:9')
    expect(key.type).toBe('apikey')
    expect(key.apiKey).toBe('k'.repeat(40) + '.x')
    expect(key.jwt).toBeNull()
  })

  it('apikey 账号不调余额接口，改走一次实测探测', async () => {
    const deps = buildDeps()
    const read = () => ({
      ok: true,
      accounts: [{ type: 'apikey', provider: 'bigmodel', apiKey: 'k'.repeat(40) + '.x', userInfo: { id: 'coding-plan:9' }, source: { label: '默认实例' } }],
      sources: [],
    })
    // 只数**余额接口**的调用：导入 apikey 账号本来就会发一次探测请求（那是另一件事），
    // 这里要钉的是"余额接口认 JWT，不会为 apikey 账号调用"。
    const balanceCalls = []
    const probeCalls = []
    const fetchImpl = async (url) => {
      if (String(url).includes('/billing/balance')) balanceCalls.push(url)
      else probeCalls.push(url)
      return { status: 200, clone() { return { text: async () => JSON.stringify({ code: 0 }) } }, json: async () => ({ code: 0, data: { balances: [] } }) }
    }
    await request(createApp({ ...deps, readLocalCredentials: read, fetchImpl })).post('/accounts/import/local').send({})
    expect(deps.store.get('bigmodel:coding-plan:9').apiKey).toBeTruthy()
    expect(balanceCalls).toEqual([])
    expect(probeCalls).toHaveLength(1)   // 探测走 messages 接口
  })

  it('完全扫不到时 400 且带上已查找的实例清单', async () => {
    const deps = buildDeps()
    const read = () => ({ ok: false, reason: 'not_found', message: '未找到任何 ZCode 凭据文件', sources: [{ label: '默认实例', ok: false, reason: 'not_found' }] })
    const r = await request(createApp({ ...deps, readLocalCredentials: read })).post('/accounts/import/local').send({})
    expect(r.status).toBe(400)
    expect(r.body.error.reason).toBe('not_found')
    expect(r.body.error.sources).toHaveLength(1)
  })
})

// apikey 账号收到 401 时不能显示"需重登"——API Key 没有"重新登录"这回事，
// 那会变成一个点不动的死路（实测从客户端扫进来的 5 个 Coding Plan key 里有 1 个就是 401）。
describe('apikey 账号的 401 语义', () => {
  it('apikey 401 → invalidKey（不是 needsRelogin），且被判为不健康', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k', userInfo: { id: 'ak1' } }))
    await deps.pool.markError(deps.store.get('bigmodel:ak1'), { status: 401, code: 1000 })
    const a = deps.store.get('bigmodel:ak1')
    expect(a.invalidKey).toBe(true)
    expect(a.needsRelogin).toBe(false)
    expect(deps.pool.healthy(a)).toBe(false)
    const view = (await request(createApp(deps)).get('/accounts')).body.accounts[0]
    expect(view.invalidKey).toBe(true)
    expect(view.needsRelogin).toBe(false)
    expect(view.healthy).toBe(false)
  })

  it('oauth 401 仍是 needsRelogin（重新登录能救回来）', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'o1' } }))
    await deps.pool.markError(deps.store.get('bigmodel:o1'), { status: 401, code: 1000 })
    const a = deps.store.get('bigmodel:o1')
    expect(a.needsRelogin).toBe(true)
    expect(a.invalidKey).toBe(false)
  })

  it('失效的 apikey 不会阻止其他账号被选用', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k', userInfo: { id: 'bad' } }))
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: 'good' } }))
    await deps.store.update('bigmodel:bad', { invalidKey: true })
    const picked = deps.pool.pick(null)
    expect(picked.account.id).toBe('bigmodel:good')
  })
})

// apikey 账号在导入时实测一次。不探的话，从客户端扫进来的死 key 会以"可用"的样子
// 留在池里，直到某个真实请求撞上去才暴露（实测 6 个 Coding Plan key 里 5 个是死的）。
describe('apikey 导入时探测', () => {
  const importDeps = (resp, extra = {}) => {
    const deps = buildDeps()
    return {
      ...deps,
      readLocalCredentials: () => ({
        ok: true,
        accounts: [{ type: 'apikey', provider: 'bigmodel', apiKey: 'k'.repeat(40) + '.x', userInfo: { id: 'coding-plan:9' }, source: { label: '默认实例' } }],
        sources: [],
      }),
      fetchImpl: async () => resp,
      ...extra,
    }
  }
  const okResp = { status: 200, clone() { return { text: async () => JSON.stringify({ code: 0 }) } } }
  const r1113 = { status: 429, clone() { return { text: async () => JSON.stringify({ code: 1113 }) } } }
  const r401 = { status: 401, clone() { return { text: async () => JSON.stringify({ error: { type: '1000' } }) } } }

  it('密钥可用 → 无标记，账号健康', async () => {
    const deps = importDeps(okResp)
    const r = await request(createApp(deps)).post('/accounts/import/local').send({})
    expect(r.body.probes[0].ok).toBe(true)
    const a = deps.store.get('bigmodel:coding-plan:9')
    expect(a.invalidKey).toBe(false)
    expect(a.noPackage).toBe(false)
    expect(deps.pool.healthy(a)).toBe(true)
  })

  it('1113（无资源包）→ 标记 noPackage，池子不再选它', async () => {
    const deps = importDeps(r1113)
    const r = await request(createApp(deps)).post('/accounts/import/local').send({})
    expect(r.body.probes[0].noPackage).toBe(true)
    const a = deps.store.get('bigmodel:coding-plan:9')
    expect(a.noPackage).toBe(true)
    expect(deps.pool.healthy(a)).toBe(false)
  })

  it('401 → 标记 invalidKey（而不是 needsRelogin）', async () => {
    const deps = importDeps(r401)
    const r = await request(createApp(deps)).post('/accounts/import/local').send({})
    expect(r.body.probes[0].invalidKey).toBe(true)
    const a = deps.store.get('bigmodel:coding-plan:9')
    expect(a.invalidKey).toBe(true)
    expect(a.needsRelogin).toBe(false)
    expect(deps.pool.healthy(a)).toBe(false)
  })

  it('探测网络失败：不误标为失效，只记一条说明', async () => {
    const deps = importDeps(null, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
    const r = await request(createApp(deps)).post('/accounts/import/local').send({})
    expect(r.body.probes[0].ok).toBeUndefined()
    expect(r.body.probes[0].note).toContain('ECONNRESET')
    const a = deps.store.get('bigmodel:coding-plan:9')
    expect(a.invalidKey).toBe(false)
    expect(a.noPackage).toBe(false)
  })

  it('探测通过会清掉旧的失效标记（key 可能已充值恢复）', async () => {
    const deps = importDeps(okResp)
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'apikey', apiKey: 'k'.repeat(40) + '.x', userInfo: { id: 'coding-plan:9' } }))
    await deps.store.update('bigmodel:coding-plan:9', { invalidKey: true, noPackage: true })
    await request(createApp(deps)).post('/accounts/import/local').send({})
    const a = deps.store.get('bigmodel:coding-plan:9')
    expect(a.invalidKey).toBe(false)
    expect(a.noPackage).toBe(false)
  })

  it('oauth 账号不做 apikey 探测（走的是余额接口）', async () => {
    const deps = buildDeps()
    deps.readLocalCredentials = () => ({
      ok: true,
      accounts: [{ type: 'oauth', provider: 'bigmodel', jwt: 'J1', userInfo: { user_id: '1' }, source: { label: '默认实例' } }],
      sources: [],
    })
    let anthropicCalls = 0
    deps.fetchImpl = async (url) => {
      if (String(url).includes('open.bigmodel.cn')) anthropicCalls += 1
      return { status: 200, json: async () => ({ code: 0, data: { balances: [] } }) }
    }
    const r = await request(createApp(deps)).post('/accounts/import/local').send({})
    expect(r.body.probes).toEqual([])
    expect(anthropicCalls).toBe(0)
  })
})
