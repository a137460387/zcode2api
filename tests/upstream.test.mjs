import { describe, it, expect } from 'vitest'
import { sendZcodePlan, ZCODE_PLAN_MESSAGES_URL } from '../src/upstream/zcode-plan.js'
import { sendBigModel, BIGMODEL_MESSAGES_URL } from '../src/upstream/bigmodel-api.js'

describe('sendZcodePlan', () => {
  it('posts to the zcode-plan endpoint with captcha headers', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return { status: 200, json: async () => ({}) }
    }
    await sendZcodePlan({ jwt: 'J', param: 'P', body: { model: 'GLM-5.3' }, sessionId: 'S', fetchImpl })
    expect(calls[0].url).toBe(ZCODE_PLAN_MESSAGES_URL)
    expect(calls[0].url).toBe('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['x-aliyun-captcha-verify-param']).toBe('P')
    // sessionId 是账号池的会话亲和键（TTL 2h）：若这里漏传，亲和会静默失效。
    // 官方形态不带 x-session-id
    expect(calls[0].init.headers.authorization).toBe('Bearer J')
    expect(calls[0].init.headers['x-api-key']).toBe('J')
    const sent = JSON.parse(calls[0].init.body)
    expect(sent.model).toBe('glm-5.3')          // 官方形态：小写模型名
    expect(sent.system).toHaveLength(3)         // 官方身份块已注入
    expect(sent.system[0].text).toContain('You are ZCode')
  })
})

describe('sendBigModel', () => {
  it('posts to the bigmodel endpoint with x-api-key', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return { status: 200 }
    }
    await sendBigModel({ apiKey: 'K', body: { model: 'glm-5.3' }, fetchImpl })
    expect(calls[0].url).toBe(BIGMODEL_MESSAGES_URL)
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(calls[0].init.headers['x-api-key']).toBe('K')
  })

  // B 通道走标准端点，不带任何 captcha 头（带了会暴露 A 通道特征且无意义）。
  // 该约束此前只在 headers 层验证过，这里补上 send 层的回归防线。
  it('never carries captcha headers (standard endpoint has no captcha gate)', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return { status: 200 }
    }
    await sendBigModel({ apiKey: 'K', body: { model: 'glm-5.3' }, fetchImpl })
    const h = calls[0].init.headers
    expect(h['x-aliyun-captcha-verify-param']).toBeUndefined()
    expect(h['x-aliyun-captcha-verify-region']).toBeUndefined()
    expect(h.authorization).toBeUndefined()
  })
})
