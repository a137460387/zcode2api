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
    throw new Error(`zai init failed: ${JSON.stringify(initJson).slice(0, 200)}`)
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
        return {
          token: pj.data.token,
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

  return { authorizeUrl: d.authorize_url, result, cancel: () => { cancelled = true } }
}
