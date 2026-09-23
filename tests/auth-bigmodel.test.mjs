import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { beginBigModelLogin } from '../src/auth/bigmodel.js'

function get(url) {
  return fetch(url).then(async (r) => ({ status: r.status, text: await r.text() }))
}

describe('beginBigModelLogin', () => {
  it('builds authorize URL, receives callback and exchanges via broker', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return {
        status: 200,
        json: async () => ({ code: 0, data: { token: 'ZJWT', bigmodel: { access_token: 'AT', refresh_token: 'RT' } } }),
      }
    }
    const login = await beginBigModelLogin({ fetchImpl })
    expect(login.authorizeUrl).toMatch(/^https:\/\/bigmodel\.cn\/login\?redirect=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Foauth%2Fcallback%2Fbigmodel&appId=zcode&state=[0-9a-f]{64}$/)

    const url = new URL(login.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    const state = url.searchParams.get('state')
    // 模拟浏览器回调（先错的 state 要被拒）
    const bad = await get(`${redirect.replace('/oauth/callback/bigmodel', '/oauth/callback/bigmodel')}?state=wrong&authCode=X`)
    expect(bad.status).toBe(400)
    const ok = await get(`${redirect}?state=${state}&authCode=AUTHCODE123`)
    expect(ok.status).toBe(200)

    const r = await login.result
    expect(r).toEqual({ token: 'ZJWT', accessToken: 'AT', refreshToken: 'RT' })
    expect(calls[0].url).toBe('https://zcode.z.ai/api/v1/oauth/token')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      provider: 'bigmodel', code: 'AUTHCODE123', redirect_uri: redirect, state,
    })
    login.close()
  })

  it('rejects when callback carries error', async () => {
    const login = await beginBigModelLogin({ fetchImpl: async () => ({ json: async () => ({}) }) })
    const url = new URL(login.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    await get(`${redirect}?state=${url.searchParams.get('state')}&error=denied`)
    await expect(login.result).rejects.toThrow('denied')
    login.close()
  })

  it('回调同步 reject 时不会产生 unhandledRejection（调用方尚未挂处理器）', async () => {
    const login = await beginBigModelLogin({ fetchImpl: async () => ({ json: async () => ({}) }) })
    const url = new URL(login.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    const seen = []
    const onUnhandled = (e) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      await get(`${redirect}?state=wrong&authCode=X`)
      await get(`${redirect}?state=${url.searchParams.get('state')}&error=denied`)
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    await expect(login.result).rejects.toThrow('denied')
    expect(seen).toEqual([])
    login.close()
  })
})

describe('beginBigModelLogin 资源与重放防护', () => {
  it('回调成功后停止监听，且同一 authCode 不会被重复交换', async () => {
    let exchanges = 0
    const fetchImpl = async () => {
      exchanges++
      return { json: async () => ({ code: 0, data: { token: 'J', bigmodel: { access_token: 'A', refresh_token: 'R' } } }) }
    }
    const login = await beginBigModelLogin({ fetchImpl })
    const url = new URL(login.authorizeUrl)
    const redirect = decodeURIComponent(url.searchParams.get('redirect'))
    const state = url.searchParams.get('state')

    const ok = await fetch(`${redirect}?state=${state}&authCode=AC1`)
    expect(ok.status).toBe(200)
    await login.result
    expect(exchanges).toBe(1)

    // 重放同一回调：不应再次交换 token（服务已停止监听或幂等拒绝）
    let replayStatus = null
    try {
      replayStatus = (await fetch(`${redirect}?state=${state}&authCode=AC1`)).status
    } catch {
      replayStatus = 'connection-refused' // 端口已释放，属预期
    }
    expect(exchanges).toBe(1)
    expect(replayStatus === 'connection-refused' || replayStatus === 200).toBe(true)
    login.close()
  })

  it('state 不匹配时不交换 token', async () => {
    let exchanges = 0
    const fetchImpl = async () => { exchanges++; return { json: async () => ({}) } }
    const login = await beginBigModelLogin({ fetchImpl })
    const redirect = decodeURIComponent(new URL(login.authorizeUrl).searchParams.get('redirect'))
    const r = await fetch(`${redirect}?state=WRONG&authCode=AC`)
    expect(r.status).toBe(400)
    expect(exchanges).toBe(0)
    login.close()
  })
})
