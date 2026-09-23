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
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: 'GLM-5.3' })
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
})
