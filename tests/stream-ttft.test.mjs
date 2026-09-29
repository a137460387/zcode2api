// TTFB 契约：流式响应绝不能被网关整包缓冲。
// 2026-09-29 实测：业务码判定里的 clone().text() 把 tee 的另一支拉到底，complete() 直到
// 上游生成完才返回——客户端 TTFB == 总耗时（用户 216s 的行全是这么来的），而直连探针证明
// 上游 2~8s 就开始逐块吐 SSE。修复：SSE（content-type: text/event-stream）跳过读码直接放行。
// 测试用**永不结束**的上游流：若网关仍整包缓冲，complete() 永不 resolve → race 超时即失败。
import { describe, it, expect } from 'vitest'
import { createGateway } from '../src/gateway.js'

const oauthAccount = () => ({ id: 'a1', type: 'oauth', jwt: 'J', apiKey: 'K' })
const gatewayOf = (response) => createGateway({
  pool: {
    pick: () => ({ account: oauthAccount(), waitMs: 0 }),
    markSuccess: async () => {},
    markError: async () => {},
  },
  paramPool: { take: async () => 'P' },
  senders: { oauth: async () => response, apikey: async () => ({ status: 200, text: async () => '{"code":0}' }) },
  config: { maxRetries: 0 },
})
const race = (p, ms, tag) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${tag}（网关疑似整包缓冲）`)), ms)),
])

describe('gateway：流式响应不得整包缓冲（TTFB 契约）', () => {
  it('SSE（content-type: text/event-stream）立即放行，不等上游生成完', async () => {
    // 上游流永不 close：整包缓冲的话 complete() 永不 resolve，race 3s 必失败
    const body = new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n')) },
    })
    const g = gatewayOf(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } }))
    const r = await race(g.complete({ model: 'glm-5.3' }, {}), 3000, 'complete() 未返回')
    expect(r.response.status).toBe(200)
    await r.response.body.cancel() // 永不结束的流要显式取消，避免悬挂
  })

  it('HTTP 200 包业务码（application/json）仍走整包读码路径', async () => {
    const g = gatewayOf(new Response('{"code":3012,"msg":"blocked"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(g.complete({ model: 'glm-5.3' }, {})).rejects.toMatchObject({ code: 3012 })
  })

  it('无 content-type 的假响应对象回退整包读码（既有测试兼容）', async () => {
    const g = gatewayOf({ status: 200, text: async () => '{"code":3007,"msg":"captcha verify failed"}' })
    await expect(g.complete({ model: 'glm-5.3' }, {})).rejects.toMatchObject({ code: 3007 })
  })
})
