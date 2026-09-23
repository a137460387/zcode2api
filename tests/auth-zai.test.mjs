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
