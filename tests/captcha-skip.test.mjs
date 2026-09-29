// 3.14.4 上游默认不再校验验证码（官方 skip_model_request 分支返回空 headers）。
// 本文件锁定降级契约：验证码从"热依赖"降级为"保险丝"——
// - headers：param 缺省时**键不存在**（不是值为 undefined——fetch 会把 undefined
//   序列化成字符串 "undefined" 污染上游风控，toBeUndefined 断言掩盖不了真实 wire 格式）；
// - gateway：农场断供时无参直发，绝不能 503；上游若恢复校验回 3007，
//   由既有的换参重试路径唤起农场（farm 回归热路径）。
import { describe, it, expect } from 'vitest'
import { buildZcodePlanHeaders } from '../src/upstream/headers.js'
import { sendZcodePlan } from '../src/upstream/zcode-plan.js'
import { createGateway } from '../src/gateway.js'

describe('headers：验证码头按需携带（3.14.4 skip_model_request）', () => {
  it('无参时不携带任何验证码头（键不存在，而非值为 undefined）', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', sessionId: 'S' })
    expect('x-aliyun-captcha-verify-param' in h).toBe(false)
    expect('x-aliyun-captcha-verify-region' in h).toBe(false)
  })

  it('有参时照常携带双验证码头', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    expect(h['x-aliyun-captcha-verify-param']).toBe('P')
    expect(h['x-aliyun-captcha-verify-region']).toBe('cn')
  })

  it('默认上报 app 版本 3.14.4', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', sessionId: 'S' })
    expect(h['user-agent']).toContain('ZCode/3.14.4')
    expect(h['x-zcode-app-version']).toBe('3.14.4')
  })

  it('sendZcodePlan 无参直发：上游收到的是无验证码头的 POST', async () => {
    const calls = []
    await sendZcodePlan({
      jwt: 'J',
      body: { model: 'GLM-5.3' },
      sessionId: 'S',
      fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({}) } },
    })
    expect('x-aliyun-captcha-verify-param' in calls[0].init.headers).toBe(false)
    expect('x-aliyun-captcha-verify-region' in calls[0].init.headers).toBe(false)
  })
})

describe('gateway：农场断供降级为保险丝', () => {
  it('paramPool.take 抛错时无参直发并成功，不再 503', async () => {
    const account = { id: 'a1', type: 'oauth', jwt: 'J', apiKey: 'K' }
    let seenParam = 'SENTINEL'
    const g = createGateway({
      pool: {
        pick: () => ({ account, waitMs: 0 }),
        markSuccess: async () => {},
        markError: async () => {},
      },
      paramPool: { take: async () => { throw new Error('farm down') } },
      senders: {
        oauth: async ({ param }) => { seenParam = param; return { status: 200, text: async () => '{"code":0}' } },
        apikey: async () => ({ status: 200, text: async () => '{"code":0}' }),
      },
      config: { maxRetries: 2 },
    })
    const r = await g.complete({ model: 'GLM-5.3' }, {})
    expect(r.response.status).toBe(200)
    expect(seenParam).toBe(null)
  })
})
