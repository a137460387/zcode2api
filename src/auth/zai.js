import crypto from 'node:crypto'

const ZCODE_API = 'https://zcode.z.ai/api/v1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function beginZaiLogin({ fetchImpl = fetch } = {}) {
  const pollToken = crypto.randomBytes(32).toString('hex')
  const initRes = await fetchImpl(`${ZCODE_API}/oauth/cli/init`, {
    method: 'POST',
    headers: { authorization: `Bearer ${pollToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zai' }),
  })
  const initJson = await initRes.json()
  const d = initJson.data
  if (initJson.code !== 0 || !d?.authorize_url || !d?.flow_id) {
    // 只回显 code/msg：init 失败时响应体可能含 token / poll_token 等敏感字段，
    // 整包拼进错误信息会把凭据写进日志与看板。
    throw new Error(`zai init failed: code=${initJson.code} ${String(initJson.msg ?? '').slice(0, 200)}`)
  }

  let cancelled = false
  const result = (async () => {
    const expiresMs = d.expires_at * 1000
    while (!cancelled) {
      await sleep(Math.max(1000, (d.poll_interval_sec || 1) * 1000))
      if (cancelled) throw new Error('cancelled')
      const pr = await fetchImpl(`${ZCODE_API}/oauth/cli/poll/${encodeURIComponent(d.flow_id)}`, {
        headers: { authorization: `Bearer ${pollToken}` },
      })
      const pj = await pr.json()
      const st = pj.data?.status
      if (st === 'ready') {
        // ready 但没有 token 说明响应不完整；静默返回 undefined 会把坏凭据传给网关，
        // 后面每次请求都 401 且难以定位，宁可在这里就失败。
        const token = pj.data?.token
        if (typeof token !== 'string' || !token) {
          throw new Error('authorization returned no token')
        }
        return {
          token,
          accessToken: pj.data.zai?.access_token ?? null,
          refreshToken: null,
          userInfo: pj.data.user ?? {},
        }
      }
      if (st === 'failed') throw new Error('authorization failed')
      if (Date.now() > expiresMs) throw new Error('authorization timed out')
    }
    throw new Error('cancelled')
  })()

  // 立即挂一个空 handler：`result` 在模块内部创建，调用方（先返回 authorizeUrl 给客户端、
  // 下一次 HTTP 轮询请求才来读结果）无法同步挂 .catch，中间窗口内的 reject 会成为
  // unhandled rejection——在 Node ≥15 默认模式下会终止进程。这里先"认领"该 promise，
  // 调用方之后的 .catch 仍能正常拿到错误。
  result.catch(() => {})

  return { authorizeUrl: d.authorize_url, result, cancel: () => { cancelled = true } }
}
