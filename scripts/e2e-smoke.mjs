// 端到端冒烟：真实 server + 真实 gateway + 真实 fetch Response（不经任何桩），
// 走通 双协议 × 流式/非流式 四条路径，并核对看板、账号池与 usage 记账。
//
// 为什么需要它：单元测试把上游桩成普通对象，掩盖了"Response.body 是一次性流"
// 这类只有真实 Response 才暴露的缺陷（曾导致非流式全 502、流式 200+空 body）。
// 上游用本地假 HTTP server 模拟，验证的是**网关自身**的完整链路。
//
// 用法：node scripts/e2e-smoke.mjs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/server.js'
import { AccountStore, newAccountFields } from '../src/auth/store.js'
import { AccountPool } from '../src/accounts.js'
import { ParamPool } from '../src/captcha/pool.js'
import { createRequestLog, UsageStore } from '../src/usage.js'
import { RuntimeSettings } from '../src/panel/settings.js'
import { createGateway } from '../src/gateway.js'

let fails = 0
const ck = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++ }

// ---- 假上游：真实 HTTP server，返回真实 Response ----
let upstreamCalls = 0
let sawCaptcha = null
const upstream = http.createServer((req, res) => {
  upstreamCalls++
  sawCaptcha = req.headers['x-aliyun-captcha-verify-param'] ?? null
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 7 } } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}\n\n`)
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '你好' }],
      usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'end_turn',
    }))
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/api/v1/zcode-plan/anthropic/v1/messages`

// ---- 真实依赖 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'))
const store = new AccountStore(dir)
await store.save(newAccountFields({ provider: 'bigmodel', type: 'oauth', jwt: 'JWT', userInfo: { user_id: '1', email: 'a@b.c' } }))
const pool = new AccountPool(store, { minIntervalMs: 0, cooldown3012Ms: 1800000 })
const paramPool = new ParamPool({})
for (let i = 0; i < 10; i++) paramPool.push('P'.repeat(80) + i)

const senders = {
  // 打真实 HTTP（本地假上游），返回真实 fetch Response
  oauth: async ({ jwt, param, body }) => {
    const r = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aliyun-captcha-verify-param': param, authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    })
    return r
  },
  apikey: async () => new Response('{}', { status: 200 }),
}
const gateway = createGateway({ pool, paramPool, senders, config: { maxRetries: 2, maxPickWaitMs: 5000 }, log: () => {} })
// rootDir 指向临时目录：createApp 会在其下建 panel.json（面板密码），不能落到仓库里。
const e2eConfig = {
  rootDir: dir, apiKey: 'sk-e2e', panelPassword: '', port: 0, poolDir: dir,
  maxRetries: 2, panelLocalBypass: true, minIntervalMs: 0, cooldown3012Ms: 1800000,
  paramTtlMs: 480000, poolSize: 6,
}
const usage = new UsageStore({ dir: path.join(dir, 'usage'), log: () => {} })
const settings = new RuntimeSettings({
  config: e2eConfig, pool, paramPool,
  envFile: path.join(dir, '.env'), panelFile: path.join(dir, 'panel.json'), log: () => {},
})
const app = createApp({
  config: e2eConfig,
  store, pool, paramPool, gateway, requestLog: createRequestLog({}), usage, settings, log: () => {},
  farmUrl: 'http://127.0.0.1:28631/farm',
})
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const H = { authorization: 'Bearer sk-e2e', 'content-type': 'application/json' }

// ---- 1. 非流式 OpenAI ----
{
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }) })
  const j = await r.json()
  ck('非流式 /v1/chat/completions', r.status === 200 && j.choices?.[0]?.message?.content === '你好', `status=${r.status} content=${JSON.stringify(j.choices?.[0]?.message?.content)}`)
  ck('  captcha 参数已送达上游', sawCaptcha && sawCaptcha.length > 50, `len=${sawCaptcha?.length}`)
}

// ---- 2. 流式 OpenAI ----
{
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })
  const t = await r.text()
  ck('流式 /v1/chat/completions 有内容', r.status === 200 && t.includes('你好') && t.includes('[DONE]'), `status=${r.status} len=${t.length}`)
}

// ---- 3. 非流式 Anthropic ----
{
  const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.3', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) })
  const j = await r.json()
  ck('非流式 /v1/messages', r.status === 200 && j.content?.[0]?.text === '你好', `status=${r.status}`)
}

// ---- 4. 流式 Anthropic（应原样透传 SSE）----
{
  const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'glm-5.3', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }) })
  const t = await r.text()
  ck('流式 /v1/messages 原样透传', r.status === 200 && t.includes('message_start') && t.includes('text_delta'), `status=${r.status} len=${t.length}`)
}

// ---- 5. 模型列表 / 健康检查 / 看板 ----
{
  const m = await fetch(`${base}/v1/models`, { headers: H }).then((r) => r.json())
  ck('/v1/models', m.data?.length === 2, m.data?.map((x) => x.id).join(','))
  const h = await fetch(`${base}/health`).then((r) => r.json())
  ck('/health', h.ok === true)
  const d = await fetch(`${base}/`)
  const html = await d.text()
  ck('看板返回 HTML', d.status === 200 && html.includes('zcode2api'))
  const ps = await fetch(`${base}/pool/status`).then((r) => r.json())
  ck('/pool/status 有账号与参数池', ps.accounts?.length === 1 && ps.paramPool?.pool >= 0, `accounts=${ps.accounts?.length}`)
}

// ---- 6. 用量已记账（证明 usage 提取链路通）----
{
  const ps = await fetch(`${base}/pool/status`).then((r) => r.json())
  const st = ps.accounts[0].stats
  ck('usage 已记账', st.requests >= 4 && st.inputTokens > 0, `requests=${st.requests} in=${st.inputTokens} out=${st.outputTokens}`)
  ck('上游被调用 4 次', upstreamCalls === 4, `calls=${upstreamCalls}`)
}

// ---- 7. 管理面板 API（真实 HTTP，非桩）----
{
  const st = await fetch(`${base}/panel/status`).then((r) => r.json())
  ck('/panel/status 免鉴权可读', st.localBypass === true && st.authenticated === true, JSON.stringify(st))

  const acc = await fetch(`${base}/accounts`).then((r) => r.json())
  ck('/accounts 返回脱敏账号', acc.accounts?.length === 1 && acc.accounts[0].hasJwt === true && acc.accounts[0].jwt === undefined,
    `len=${acc.accounts?.length} hasJwt=${acc.accounts?.[0]?.hasJwt}`)
  ck('/accounts 不含凭据原文', !JSON.stringify(acc).includes('"JWT"'), '响应里不得出现账号 jwt')

  const an = await fetch(`${base}/usage/analytics`).then((r) => r.json())
  ck('/usage/analytics 已聚合本次请求', an.summary?.all_time?.requests === 4 && an.summary.all_time.prompt_tokens === 28,
    `requests=${an.summary?.all_time?.requests} prompt=${an.summary?.all_time?.prompt_tokens}`)
  ck('/usage/analytics 统计到流式与非流式', an.summary?.all_time?.stream_requests === 2, `stream=${an.summary?.all_time?.stream_requests}`)
  ck('/usage/analytics 有首字延迟与速度', an.summary?.all_time?.ttft_ms_avg !== null && an.summary?.all_time?.speed_avg !== null,
    `ttft=${an.summary?.all_time?.ttft_ms_avg} speed=${an.summary?.all_time?.speed_avg}`)

  const rec = await fetch(`${base}/usage/recent?limit=10`).then((r) => r.json())
  ck('/usage/recent 有条目', rec.rows?.length === 4 && rec.total === 4, `rows=${rec.rows?.length} total=${rec.total}`)

  const set = await fetch(`${base}/settings`).then((r) => r.json())
  ck('/settings 不回密钥原文', set.apiKeySet === true && !JSON.stringify(set).includes('sk-e2e'), `masked=${set.apiKeyMasked}`)

  const build = await fetch(`${base}/build`).then((r) => r.json())
  ck('/build 返回构建号', typeof build.build === 'string' && build.build.length > 0, build.build)

  const add = await fetch(`${base}/accounts/add-apikey`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'e2e key', apiKey: 'sk-e2e-apikey-123456' }),
  })
  const addBody = await add.json()
  ck('/accounts/add-apikey 建号成功', add.status === 200 && addBody.id?.includes('apikey'), JSON.stringify(addBody))
  const after = await fetch(`${base}/accounts`).then((r) => r.json())
  ck('新账号出现在列表且不含 key 原文', after.accounts.length === 2 && !JSON.stringify(after).includes('sk-e2e-apikey-123456'), `len=${after.accounts.length}`)

  const dup = await fetch(`${base}/accounts/add-apikey`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'e2e key', apiKey: 'sk-e2e-apikey-123456' }),
  })
  ck('重复添加同 id → 409（不覆盖既有账号）', dup.status === 409, `status=${dup.status}`)

  const badKey = await fetch(`${base}/accounts/add-apikey`, { method: 'POST', headers: H, body: JSON.stringify({ apiKey: 'short' }) })
  ck('过短 key → 400', badKey.status === 400, `status=${badKey.status}`)

  const allOff = await fetch(`${base}/accounts/set-all`, { method: 'POST', headers: H, body: JSON.stringify({ enabled: false }) }).then((r) => r.json())
  const offList = await fetch(`${base}/accounts`).then((r) => r.json())
  ck('/accounts/set-all 批量停用', allOff.changed === 2 && offList.accounts.every((a) => !a.enabled), `changed=${allOff.changed}`)

  const del = await fetch(`${base}/accounts/delete`, { method: 'POST', headers: H, body: JSON.stringify({ id: addBody.id }) }).then((r) => r.json())
  ck('/accounts/delete 删除成功', del.ok === true, JSON.stringify(del))
}

server.close()
upstream.close()
console.log(fails === 0 ? '\n端到端冒烟全部通过' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
