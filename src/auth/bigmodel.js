import http from 'node:http'
import crypto from 'node:crypto'

export const BIGMODEL_BROKER_URL = 'https://zcode.z.ai/api/v1/oauth/token'
const CALLBACK_PATH = '/oauth/callback/bigmodel'

export async function beginBigModelLogin({ fetchImpl = fetch, callbackHost = '127.0.0.1' } = {}) {
  const state = crypto.randomBytes(32).toString('hex')
  let resolveResult, rejectResult
  const result = new Promise((res, rej) => { resolveResult = res; rejectResult = rej })
  // 回调处理器会在调用方还来不及对 result 挂 .catch/.then 时同步 reject（例如 state 校验
  // 失败或 error=denied），Node 会把那一小段时间里无人认领的 rejection 记为
  // unhandledRejection（vitest 会直接报 Unhandled Error）。这里空挂一个处理器把 rejection
  // 标记为已处理；result 本身仍是同一个 promise，对调用方的返回值与语义完全不变。
  result.catch(() => {})

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? callbackHost}`)
    const reply = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return reply(404, 'not found')
    if (url.searchParams.get('state') !== state) return reply(400, 'state mismatch')
    const err = url.searchParams.get('error')
    const code = url.searchParams.get('authCode') ?? url.searchParams.get('code') ?? ''
    if (err || !code) {
      reply(400, '授权失败，可关闭此窗口')
      return rejectResult(new Error(err || 'missing authCode'))
    }
    reply(200, '授权成功，请返回 zcode2api 看板。')
    exchange(code, url.origin + CALLBACK_PATH, state).then(resolveResult, rejectResult)
  })

  await new Promise((resolve) => server.listen(0, callbackHost, resolve))
  const port = server.address().port
  const redirectUri = `http://${callbackHost}:${port}${CALLBACK_PATH}`
  const authorizeUrl = `https://bigmodel.cn/login?redirect=${encodeURIComponent(redirectUri)}&appId=zcode&state=${state}`

  async function exchange(code, redirect_uri, st) {
    const res = await fetchImpl(BIGMODEL_BROKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'bigmodel', code, redirect_uri, state: st }),
    })
    const j = await res.json()
    if (j.code !== 0 || !j.data?.token) {
      throw new Error(`broker exchange failed: code=${j.code} ${String(j.msg ?? '').slice(0, 200)}`)
    }
    return {
      token: j.data.token,
      accessToken: j.data.bigmodel?.access_token ?? null,
      refreshToken: j.data.bigmodel?.refresh_token ?? null,
    }
  }

  return { authorizeUrl, result, cancel: () => rejectResult(new Error('cancelled')), close: () => server.close() }
}
