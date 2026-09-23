import { describe, it, expect } from 'vitest'
import { beginZaiLogin } from '../src/auth/zai.js'

const INIT = {
  code: 0,
  data: {
    flow_id: 'FLOW1',
    poll_token: 'SRVPT',
    authorize_url: 'https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    poll_interval_sec: 0,
  },
}

describe('beginZaiLogin', () => {
  it('inits with client pollToken, returns server authorize_url, polls until ready', async () => {
    const calls = []
    let polls = 0
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/oauth/cli/init')) return { json: async () => INIT }
      polls++
      return {
        json: async () =>
          polls < 2
            ? { code: 0, data: { status: 'pending' } }
            : { code: 0, data: { status: 'ready', token: 'ZJWT', user: { user_id: 'u1', email: 'a@b.c' }, zai: { access_token: 'AT' } } },
      }
    }
    const login = await beginZaiLogin({ fetchImpl })
    expect(calls[0].url).toBe('https://zcode.z.ai/api/v1/oauth/cli/init')
    expect(calls[0].init.headers.authorization).toMatch(/^Bearer [0-9a-f]{64}$/)
    expect(JSON.parse(calls[0].init.body)).toEqual({ provider: 'zai' })
    expect(login.authorizeUrl).toBe(INIT.data.authorize_url)

    const r = await login.result
    expect(r.token).toBe('ZJWT')
    expect(r.accessToken).toBe('AT')
    expect(r.userInfo.email).toBe('a@b.c')
    expect(calls[1].url).toContain('/oauth/cli/poll/FLOW1')
    expect(calls[1].init.headers.authorization).toBe(calls[0].init.headers.authorization)
  })

  it('throws on failed status', async () => {
    const fetchImpl = async (url) =>
      url.endsWith('/oauth/cli/init')
        ? { json: async () => INIT }
        : { json: async () => ({ code: 0, data: { status: 'failed' } }) }
    const login = await beginZaiLogin({ fetchImpl })
    await expect(login.result).rejects.toThrow('failed')
  })
})

describe('beginZaiLogin 的 reject 时序安全', () => {
  // result 在模块内部创建；真实用法是"start 先把 authorizeUrl 返回给客户端，
  // 下一次 HTTP 轮询请求才来读结果"。中间窗口内若 result 已 reject，
  // 未及时认领会成为 unhandled rejection（Node ≥15 默认终止进程）。
  it('reject 时不产生 unhandled rejection（调用方稍后才 attach）', async () => {
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const fetchImpl = async (url) =>
        url.endsWith('/oauth/cli/init')
          ? {
              json: async () => ({
                code: 0,
                data: {
                  flow_id: 'F', poll_token: 'PT', authorize_url: 'https://chat.z.ai/x',
                  expires_at: Math.floor(Date.now() / 1000) + 60, poll_interval_sec: 0,
                },
              }),
            }
          : { json: async () => ({ code: 0, data: { status: 'failed' } }) }

      const login = await beginZaiLogin({ fetchImpl })
      // 模拟调用方稍后才读结果（期间不挂任何 handler）
      await new Promise((r) => setTimeout(r, 1100))
      await expect(login.result).rejects.toThrow('authorization failed')
      // 给 unhandledRejection 的检测留出时间
      await new Promise((r) => setTimeout(r, 100))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
