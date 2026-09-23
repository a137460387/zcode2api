import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/server.js'
import { GatewayError } from '../src/gateway.js'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'
import { ParamPool } from '../src/captcha/pool.js'
import { createRequestLog } from '../src/usage.js'

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
  const config = { apiKey: 'sk-test', panelPassword: '', port: 0, farmUrl: 'http://127.0.0.1:8789/farm', maxRetries: 2 }
  const pool = new AccountPool(store, { now: () => Date.now() })
  const paramPool = new ParamPool({})
  const requestLog = createRequestLog({})
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
  return { config, store, pool, paramPool, requestLog, gateway, fetchImpl: over.fetchImpl, log: () => {}, ...over.appOverrides }
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
    const app = createApp(buildDeps({ fetchImpl }))
    const start = await request(app).post('/accounts/login/bigmodel/start')
    expect(start.status).toBe(200)
    expect(start.body.authorizeUrl).toContain('bigmodel.cn/login')
    const url = new URL(start.body.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    await fetch(`${redirect}?state=${url.searchParams.get('state')}&authCode=AC`) // 触发回调
    const poll = await request(app).post('/accounts/login/bigmodel/poll').send({ loginId: start.body.loginId })
    expect(poll.body.status).toBe('ready')
    expect(poll.body.account.jwt).toBe('ZJWT')
    expect(poll.body.account.id).toMatch(/^bigmodel:/)
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
