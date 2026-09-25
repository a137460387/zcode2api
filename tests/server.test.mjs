import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server.js'
import { GatewayError } from '../src/gateway.js'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'
import { ParamPool } from '../src/captcha/pool.js'
import { createRequestLog, UsageStore } from '../src/usage.js'
import { RuntimeSettings } from '../src/panel/settings.js'

// 把若干 SSE 文本帧包成一个带 body 流的假 fetch Response（网关返回的 200 上游响应形态）
function sseResponse(frames) {
  const encoder = new TextEncoder()
  return {
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    }),
  }
}

function buildDeps(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z2a-srv-'))
  const store = new AccountStore(dir)
  // rootDir 必须指向临时目录：createApp 会在它下面建 panel.json（面板密码），
  // 不给的话会落到 process.cwd()——测试往仓库里写文件是不可接受的副作用。
  const config = {
    rootDir: dir, apiKey: 'sk-test', panelPassword: '', port: 0, poolDir: dir,
    farmUrl: 'http://127.0.0.1:28631/farm', maxRetries: 2, panelLocalBypass: true,
    minIntervalMs: 2000, cooldown3012Ms: 30 * 60_000, paramTtlMs: 480_000, poolSize: 6,
  }
  const pool = new AccountPool(store, { now: () => Date.now() })
  const paramPool = new ParamPool({})
  const requestLog = createRequestLog({})
  const usage = new UsageStore({ dir: path.join(dir, 'usage'), log: () => {} })
  const settings = new RuntimeSettings({
    config, pool, paramPool, envFile: path.join(dir, '.env'), panelFile: path.join(dir, 'panel.json'), log: () => {},
  })
  const defaultResponse = {
    status: 200,
    json: async () => ({
      id: 'm1',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 3, output_tokens: 2 },
      stop_reason: 'end_turn',
    }),
  }
  const gateway = {
    complete: over.complete ?? (async () => ({ response: defaultResponse, account: { id: 'x' } })),
  }
  // 注意：over 里除 complete/fetchImpl 之外的键（loginTtlMs/now/isLocal 等 createApp 的注入点）
  // 必须透传给 createApp —— 早期只展开 over.appOverrides，导致 buildDeps({loginTtlMs}) 被静默丢弃，
  // 回收测试因此用着 10 分钟的真实 TTL，永远看不到回收。
  const { complete, fetchImpl, appOverrides, ...rest } = over
  return { config, store, pool, paramPool, requestLog, usage, settings, gateway, fetchImpl, log: () => {}, ...rest, ...appOverrides }
}

describe('auth & misc routes', () => {
  it('health is open; v1 requires the API key', async () => {
    const app = createApp(buildDeps())
    expect((await request(app).get('/health')).status).toBe(200)
    expect((await request(app).post('/v1/chat/completions').send({})).status).toBe(401)
    expect((await request(app).post('/v1/chat/completions').set('authorization', 'Bearer nope').send({})).status).toBe(401)
  })

  it('serves models list', async () => {
    const app = createApp(buildDeps())
    const r = await request(app).get('/v1/models').set('authorization', 'Bearer sk-test')
    expect(r.status).toBe(200)
    expect(r.body.data.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
  })
})

describe('/v1/chat/completions (OpenAI)', () => {
  it('non-stream returns converted OpenAI response and records usage', async () => {
    const deps = buildDeps()
    const app = createApp(deps)
    const r = await request(app)
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    expect(r.body.object).toBe('chat.completion')
    expect(r.body.choices[0].message.content).toBe('hi')
    expect(deps.requestLog.list(1)[0].model).toBe('glm-5.3')
  })
})

describe('/v1/messages (Anthropic)', () => {
  it('non-stream passes upstream json through', async () => {
    const app = createApp(buildDeps())
    const r = await request(app)
      .post('/v1/messages')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'GLM-5.3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    expect(r.body.content[0].text).toBe('hi')
  })
})

describe('account login & management', () => {
  it('bigmodel login start/poll creates an account', async () => {
    let stage = 0
    const fetchImpl = async (url) => {
      if (url.includes('/oauth/token')) {
        return { json: async () => ({ code: 0, data: { token: 'ZJWT', bigmodel: { access_token: 'AT', refresh_token: 'RT' } } }) }
      }
      return { json: async () => ({}) }
    }
    const deps = buildDeps({ fetchImpl })
    const app = createApp(deps)
    const start = await request(app).post('/accounts/login/bigmodel/start')
    expect(start.status).toBe(200)
    expect(start.body.authorizeUrl).toContain('bigmodel.cn/login')
    const url = new URL(start.body.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    await fetch(`${redirect}?state=${url.searchParams.get('state')}&authCode=AC`) // 触发回调
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: start.body.loginId })
    expect(poll.body.status).toBe('ready')
    expect(poll.body.account.id).toMatch(/^bigmodel:/)
    // 管理面**不回凭据原文**：面板只需要"有没有凭据 + 掩码"。jwt 一旦进过浏览器/日志/截图
    // 就等于多了一处泄露面。凭据本体仍在服务端账号文件里（下面直接读盘核对）。
    expect(poll.body.account.jwt).toBeUndefined()
    expect(poll.body.account.hasJwt).toBe(true)
    expect(poll.body.account.secretMask).toMatch(/…/)
    expect(deps.store.get(poll.body.account.id).jwt).toBe('ZJWT')
  })

  it('set/delete/pool-status work', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: '9' } }))
    const app = createApp(deps)
    expect((await request(app).post('/accounts/set').send({ id: 'bigmodel:9', enabled: false })).status).toBe(200)
    expect((await request(app).get('/pool/status')).body.accounts[0].enabled).toBe(false)
    expect((await request(app).post('/accounts/delete').send({ id: 'bigmodel:9' })).status).toBe(200)
    expect((await request(app).get('/pool/status')).body.accounts.length).toBe(0)
  })

  it('balance refresh stores planCache', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'JW', userInfo: { user_id: '5' } }))
    const fetchImpl = async () => ({
      status: 200,
      json: async () => ({ code: 0, data: { plans: [{ name: 'Start Plan' }], balances: [{ entitlement_id: 'e', show_name: 'GLM-5.3-Flash', total_units: 10, used_units: 1, available_units: 9 }] } }),
    })
    const app = createApp({ ...deps, fetchImpl })
    const r = await request(app).post('/accounts/balance/refresh')
    expect(r.status).toBe(200)
    expect(r.body.results[0].ok).toBe(true)
  })
})

// P1：管理面 async 路由内部 await 抛错（磁盘满/权限错）——Express 4 **不会**自动捕获
// async 处理器抛出的异常，旧实现既不给响应（请求永久挂死到超时）又产生 unhandled
// rejection（Node ≥15 默认模式下可能终止进程）。
// 断言方式：supertest 不设 deadline，若实现仍挂死则整个测试超时失败；正确的实现回 500。
describe('管理面 async 路由的异常处理', () => {
  // 只把"写"方法做成失败：读仍可用（否则测不出"写失败→500"这条路径本身）。
  // 三个写方法都要列上：管理面不同路径分别用 save / update / upsertCredentials，
  // 漏一个就会出现"某个写路径的失败被静默吞掉"的假绿。
  const throwingStore = (base, msg = 'disk full') => Object.assign(Object.create(base), {
    update: () => Promise.reject(new Error(msg)),
    save: () => Promise.reject(new Error(msg)),
    upsertCredentials: () => Promise.reject(new Error(msg)),
    list: () => base.list(),
    get: (id) => base.get(id),
    delete: (id) => base.delete(id),
  })

  it('/accounts/set：store.update 抛错时返回 500，而不是挂死', async () => {
    const base = buildDeps()
    await base.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: '9' } }))
    const app = createApp({ ...base, store: throwingStore(base.store) })
    const r = await request(app).post('/accounts/set').send({ id: 'bigmodel:9', enabled: false })
    expect(r.status).toBe(500)
    expect(r.body.error.message).toBeTruthy()
  })

  it('/accounts/login/:provider/poll：store 写盘抛错时返回 500，而不是挂死', async () => {
    const base = buildDeps({
      fetchImpl: async (url) => (url.includes('/oauth/token')
        ? { json: async () => ({ code: 0, data: { token: 'ZJWT' } }) }
        : { json: async () => ({}) }),
    })
    const app = createApp({ ...base, store: throwingStore(base.store, 'permission denied') })
    const start = await request(app).post('/accounts/login/bigmodel/start')
    const url = new URL(start.body.authorizeUrl)
    await fetch(`${decodeURIComponent(url.searchParams.get('redirect'))}?state=${url.searchParams.get('state')}&authCode=AC`)
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: start.body.loginId })
    expect(poll.status).toBe(500)
    expect(poll.body.error.message).toBeTruthy()
  })

  it('/accounts/balance/refresh：某账号 update 抛错不拖垮整个路由', async () => {
    const base = buildDeps()
    await base.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'JW', userInfo: { user_id: '5' } }))
    const app = createApp({
      ...base,
      store: throwingStore(base.store),
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ code: 0, data: { balances: [{ entitlement_id: 'e', total_units: 10, used_units: 1, available_units: 9 }] } }),
      }),
    })
    const r = await request(app).post('/accounts/balance/refresh')
    expect(r.status).toBe(200)
    expect(r.body.results[0].ok).toBe(false)
  })
})

// 常驻服务不应因单个请求异常退出：main() 必须注册 unhandledRejection/uncaughtException
// 处理器并保持进程存活（Node ≥15 默认模式下 unhandledRejection 会终止进程）。
// 这里不真的启动 main()（会起监听端口/launchFarmBrowser），改为断言其源码级行为：
// 两个处理器在 main() 内注册且**不**调用 process.exit。
describe('main() 的进程级健壮性', () => {
  it('注册 unhandledRejection 与 uncaughtException，且不因之退出进程', async () => {
    const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
    const mainBody = src.slice(src.indexOf('export async function main()'))
    expect(mainBody).toMatch(/process\.on\(\s*['"]unhandledRejection['"]/)
    expect(mainBody).toMatch(/process\.on\(\s*['"]uncaughtException['"]/)
    // 处理器内部不得调用 process.exit（那等于"忽略了却仍然退出"）。
    // 只看两个 process.on(...) 到 "const store = new AccountStore" 之间的处理器体，
    // 避开 main() 开头"缺 API_KEY 即 exit(1)"这条合法的启动期失败路径。
    const start = mainBody.indexOf("process.on('unhandledRejection'")
    const handlers = mainBody.slice(start, mainBody.indexOf('const store = new AccountStore'))
    expect(start).toBeGreaterThan(-1)
    expect(handlers).not.toMatch(/process\.exit/)
  })
})

// 废弃登录回收：`/accounts/login/:provider/start` 后既不 poll 也不 cancel（用户关标签页、
// 网络断）的登录，其回调 server 持续监听、logins 条目永久滞留。
// 实测旧实现 30 次废弃 start → 30/30 端口仍监听，长期运行必然耗尽资源。
describe('废弃登录的回收', () => {
  // 回调 server 的真实端口可从 authorizeUrl 的 redirect 参数解析出来 —— 这是黑盒可观测的
  // "端口仍在监听"证据，无需暴露内部 Map。
  const callbackPort = (authorizeUrl) => {
    const redirect = decodeURIComponent(new URL(authorizeUrl).searchParams.get('redirect'))
    return new URL(redirect).port
  }
  // 向回调端口发一次请求：监听中 → resolve(true)，已关闭 → resolve(false)
  // agent:false 禁用 keep-alive 连接复用：否则首次探测建立的 socket 会被后续探测复用，
  // 即使 server 已 close 也会 "连得上"，导致断言永远看到端口存活。
  const portAlive = (port) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/oauth/callback/bigmodel', method: 'GET', agent: false, headers: { connection: 'close' } }, () => resolve(true))
    req.on('error', () => resolve(false))
    req.end()
  })

  // server.close() 与 closeAllConnections() 都是异步的：回收后端口释放需要若干轮事件循环。
  // 固定 sleep 在某些机器上不够稳，改为轮询等待端口真正关闭（上限 2s）。
  const waitPortClosed = async (port) => {
    for (let i = 0; i < 40; i++) {
      if (!(await portAlive(port))) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  const start = async (app) => {
    const r = await request(app).post('/accounts/login/bigmodel/start')
    expect(r.status).toBe(200)
    return r.body
  }

  it('超时未 poll/cancel 的登录会被回收：回调端口关闭且 poll 回 404', async () => {
    let t = 1_000_000
    const app = createApp(buildDeps({ loginTtlMs: 1000, now: () => t }))
    const abandoned = await start(app)
    const port = callbackPort(abandoned.authorizeUrl)
    expect(await portAlive(port)).toBe(true) // 回调 server 初始确实在监听

    t += 2000 // 超过 TTL，登录被废弃（既不 poll 也不 cancel）

    // 任意一次 start 触发惰性回收
    await start(app)
    // 双证据：条目已移除（poll 404）且回调端口已释放（close() 生效）。
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: abandoned.loginId })
    expect(poll.status).toBe(404)
    expect(await waitPortClosed(port)).toBe(true) // 端口已释放
  })

  it('TTL 内未超时的登录不受影响（回收不误伤进行中的登录）', async () => {
    let t = 1_000_000
    const app = createApp(buildDeps({ loginTtlMs: 1000, now: () => t }))
    const live = await start(app)
    const port = callbackPort(live.authorizeUrl)

    t += 500 // 未超时
    await start(app) // 触发回收检查
    await new Promise((r) => setTimeout(r, 100))

    expect(await portAlive(port)).toBe(true) // 仍在监听
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: live.loginId })
    expect(poll.status).toBe(200)
    expect(poll.body.status).toBe('pending')
  })

  it('poll 也会触发回收（不依赖新的 start）', async () => {
    let t = 1_000_000
    const app = createApp(buildDeps({ loginTtlMs: 1000, now: () => t }))
    const abandoned = await start(app)
    const port = callbackPort(abandoned.authorizeUrl)
    t += 2000

    // 只有 poll，没有新的 start
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: abandoned.loginId })
    expect(poll.status).toBe(404)
  })
})

describe('v1 auth: 三种凭据方式与错误格式', () => {
  it('accepts x-api-key and ?key=, and formats protocol errors', async () => {
    const app = createApp(buildDeps())
    expect((await request(app).get('/v1/models').set('x-api-key', 'sk-test')).status).toBe(200)
    expect((await request(app).get('/v1/models').query({ key: 'sk-test' })).status).toBe(200)
    expect((await request(app).post('/v1/messages').send({})).body.error.message).toBe('invalid api key')
    expect((await request(app).post('/v1/chat/completions').send({})).body.error.message).toBeTruthy()
  })
})

describe('两种协议的流式透传', () => {
  it('streams OpenAI SSE from upstream and records usage', async () => {
    const usage = { inputTokens: 5, outputTokens: 7 }
    const deps = buildDeps({
      complete: async () => ({
        account: { id: 'x' },
        response: sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        ]),
      }),
    })
    const app = createApp(deps)
    const r = await request(app)
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    expect(r.text).toContain('chat.completion.chunk')
    expect(r.text).toContain('[DONE]')
    expect(deps.requestLog.list(1)[0].stream).toBe(true)
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 7 })
  })

  it('streams Anthropic SSE through verbatim', async () => {
    const frame = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
    const deps = buildDeps({
      complete: async () => ({ account: { id: 'x' }, response: sseResponse([frame]) }),
    })
    const app = createApp(deps)
    const r = await request(app)
      .post('/v1/messages')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'GLM-5.3', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(200)
    expect(r.text).toContain('message_start')
  })
})

describe('上游失败映射', () => {
  it('maps a GatewayError to the protocol-specific error body', async () => {
    const complete = async () => { throw new GatewayError({ status: 429, code: 3012, message: 'upstream HTTP 200 code=3012', hint: '风控' }) }
    const app = createApp(buildDeps({ complete }))
    const oa = await request(app)
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
    expect(oa.status).toBe(429)
    expect(oa.body.error.upstream_code).toBe(3012)
    const an = await request(app)
      .post('/v1/messages')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] })
    expect(an.status).toBe(429)
    expect(an.body.type).toBe('error')
    expect(an.body.error.type).toBe('rate_limit_error')
  })
})

describe('看板管理面鉴权', () => {
  it('serves the dashboard on loopback without a password', async () => {
    const app = createApp(buildDeps())
    const r = await request(app).get('/')
    expect(r.status).toBe(200)
    expect(r.text).toContain('zcode2api')
  })

})

// 非本机访问的安全边界：看板/管理面必须校验面板密码。
// Socket.remoteAddress 是只读 getter，无法用 supertest 伪造远端来源，故通过注入
// deps.isLocal 覆盖这条边界（否则"非本机需密码"完全无测试保护）。
describe('看板非本机鉴权', () => {
  const remoteDeps = (over = {}) => {
    const base = buildDeps()
    return { ...base, isLocal: () => false, config: { ...base.config, panelPassword: 'pw' }, ...over }
  }

  it('非本机无密码 → 401', async () => {
    const app = createApp(remoteDeps())
    expect((await request(app).get('/')).status).toBe(401)
    expect((await request(app).get('/pool/status')).status).toBe(401)
    expect((await request(app).post('/accounts/delete').send({ id: 'x' })).status).toBe(401)
  })

  it('非本机带正确密码 → 通过', async () => {
    const app = createApp(remoteDeps())
    const r = await request(app).get('/pool/status').set('x-panel-password', 'pw')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.accounts)).toBe(true)
  })

  it('非本机密码错误 → 401', async () => {
    const app = createApp(remoteDeps())
    expect((await request(app).get('/pool/status').set('x-panel-password', 'wrong')).status).toBe(401)
  })

  it('未配置面板密码时，非本机一律拒绝（不能默认放行）', async () => {
    const base = buildDeps()
    const app = createApp({ ...base, isLocal: () => false, config: { ...base.config, panelPassword: '' } })
    expect((await request(app).get('/pool/status')).status).toBe(401)
    expect((await request(app).get('/pool/status').set('x-panel-password', '')).status).toBe(401)
  })
})

// P1：流式响应头发出后上游中断 —— 必须结束响应且不产生 unhandled rejection。
// 修复前：客户端挂死到超时，同时 res.json() 抛 "Cannot set headers after they are sent"
// （unhandled rejection，Node ≥15 可能终止进程）。上游流中断是高频路径（3012/网络重置）。
describe('流式中途失败', () => {
  const brokenStream = () => ({
    status: 200,
    body: {
      getReader: () => ({
        read: async () => { throw new Error('upstream stream reset') },
      }),
    },
    text: async () => '{}',
    json: async () => ({}),
  })

  for (const [name, path, payload] of [
    ['OpenAI', '/v1/chat/completions', { model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] }],
    ['Anthropic', '/v1/messages', { model: 'glm-5.3', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }],
  ]) {
    it(`${name} 协议：上游流中断时结束响应且不抛未捕获拒绝`, async () => {
      const unhandled = []
      const onUnhandled = (e) => unhandled.push(e)
      process.on('unhandledRejection', onUnhandled)
      try {
        const deps = buildDeps({
          complete: async () => ({ response: brokenStream(), account: { id: 'acct1' } }),
        })
        const app = createApp(deps)
        // 有 timeout 即为"挂死到超时"的失败信号
        const r = await request(app).post(path).set('authorization', 'Bearer sk-test').send(payload).timeout({ deadline: 3000 })
        // 已发出 200 头，故状态码是 200；关键是不能挂死（能返回即通过）
        expect(r.status).toBe(200)
        await new Promise((res) => setTimeout(res, 100))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  }
})

describe('v1 auth 边界补充', () => {
  it('?key 传数组时取第一个（正确的 key 在列即可通过）', async () => {
    const app = createApp(buildDeps())
    const body = { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }
    const ok = await request(app).post('/v1/chat/completions').query('key=sk-test&key=other').send(body)
    expect(ok.status).toBe(200)
    const bad = await request(app).post('/v1/chat/completions').query('key=wrong&key=alsoWrong').send(body)
    expect(bad.status).toBe(401)
  })
})

describe('导入本机 ZCode 登录态', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiOTkifQ.sig'

  it('成功导入并入库、顺带拉取余额', async () => {
    let balanceCalls = 0
    const fetchImpl = async () => {
      balanceCalls++
      return { status: 200, json: async () => ({ code: 0, data: { plans: [{ name: 'Start Plan' }], balances: [{ entitlement_id: 'e', show_name: 'GLM-5.3', total_units: 3000000, used_units: 0, available_units: 3000000 }] } }) }
    }
    const deps = buildDeps({
      fetchImpl,
      // 注入 reader：凭据文件的解析逻辑由 local-import 自己的单测覆盖，这里只测路由行为
      readLocalCredentials: () => ({
        ok: true, source: '/fake/credentials.json',
        accounts: [{ provider: 'bigmodel', jwt, accessToken: 'AT', refreshToken: 'RT', userInfo: { user_id: '99', email: 'x@y.z' } }],
      }),
    })
    const app = createApp(deps)
    const r = await request(app).post('/accounts/import/local')
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.accounts).toEqual(['bigmodel:99'])
    expect(balanceCalls).toBe(1)
    const saved = deps.store.get('bigmodel:99')
    expect(saved.jwt).toBe(jwt)
    expect(saved.planCache.balances[0].remaining).toBe(3000000)
  })

  it('导入失败时返回 400 与可读原因', async () => {
    // 不注入 localCredOptions → 走真实 readLocalZcodeCredentials，指向不存在的文件
    const app = createApp(buildDeps({ localCredOptions: { file: path.join(os.tmpdir(), 'definitely-missing-z2a.json') } }))
    const r = await request(app).post('/accounts/import/local')
    expect(r.status).toBe(400)
    expect(r.body.error.reason).toBe('not_found')
    expect(typeof r.body.error.message).toBe('string')
  })
})

// 失败请求的用量记录：面板要能回答"哪个账号在失败""失败的这次是不是流式"。
// 真实上游实测踩到过两个缺陷：失败全记成 (unattributed)、流式失败被记成非流式。
describe('失败请求的用量归属', () => {
  it('上游拒绝时按 accountId 归属账号，并记录真实的 stream 模式', async () => {
    const deps = buildDeps()
    await deps.store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'j', userInfo: { user_id: '7' } }))
    const gateway = {
      complete: async () => {
        const err = new GatewayError({ status: 429, code: 3009, message: 'upstream HTTP 429 code=3009', accountId: 'bigmodel:7' })
        throw err
      },
    }
    const app = createApp({ ...deps, gateway })
    const r = await request(app)
      .post('/v1/messages')
      .set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    expect(r.status).toBe(429)
    await deps.usage.flush()
    const rec = deps.usage.recent(1)[0]
    expect(rec.account).toBe('bigmodel:7')
    expect(rec.stream).toBe(true)          // 流式请求失败仍是流式，不能记成非流式
    expect(rec.status).toBe(429)
    expect(rec.error).toContain('3009')
  })

  it('非流式失败记为非流式', async () => {
    const deps = buildDeps()
    const gateway = { complete: async () => { throw new GatewayError({ status: 502, message: 'boom' }) } }
    const app = createApp({ ...deps, gateway })
    await request(app).post('/v1/chat/completions').set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
    await deps.usage.flush()
    const rec = deps.usage.recent(1)[0]
    expect(rec.stream).toBe(false)
    expect(rec.account).toBeNull() // 池层错误没有账号可归属
  })

  it('失败也计入聚合的 errors，成功率为 0', async () => {
    const deps = buildDeps()
    const gateway = { complete: async () => { throw new GatewayError({ status: 502, message: 'boom' }) } }
    const app = createApp({ ...deps, gateway })
    await request(app).post('/v1/messages').set('authorization', 'Bearer sk-test')
      .send({ model: 'glm-5.3', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    await deps.usage.flush()
    const a = deps.usage.analytics().summary.all_time
    expect(a.requests).toBe(1)
    expect(a.errors).toBe(1)
    expect(a.success_rate_pct).toBe(0)
  })
})
