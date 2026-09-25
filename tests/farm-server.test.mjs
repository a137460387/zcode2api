import { describe, it, expect, afterAll } from 'vitest'
import http from 'node:http'
import { ParamPool } from '../src/captcha/pool.js'
import { startFarmServer } from '../src/captcha/farm-server.js'

const pool = new ParamPool({})
const farm = startFarmServer({ paramPool: pool, port: 0, host: '127.0.0.1', certDir: './nonexistent-certs' })
// listen() 异步绑定端口，同步读 server.address() 会是 null，需等 'listening'。
const base = await new Promise((resolve) =>
  farm.server.listening
    ? resolve(`http://127.0.0.1:${farm.server.address().port}`)
    : farm.server.once('listening', () => resolve(`http://127.0.0.1:${farm.server.address().port}`)),
)
afterAll(() => farm.close())

const post = (path, body) =>
  new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(base + path, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({ status: res.statusCode, body: buf }))
    })
    req.on('error', reject)
    req.end(data)
  })
const get = (path) =>
  fetch(base + path).then(async (r) => ({ status: r.status, text: await r.text() }))

describe('farm server', () => {
  it('serves the farm page', async () => {
    const r = await get('/farm')
    expect(r.status).toBe(200)
    expect(r.text).toContain('SceneId')
    expect(r.text).toContain('11xygtvd')
    expect(r.text).toContain('AliyunCaptcha.js')
  })
  it('accepts params pushed by the page', async () => {
    const r = await post('/param', { param: 'x'.repeat(60) })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(pool.takeSync()).toBe('x'.repeat(60))
  })
  it('rejects short params', async () => {
    const r = await post('/param', { param: 'short' })
    expect(r.status).toBe(400)
  })
  it('reports status', async () => {
    const r = await get('/param-status')
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toHaveProperty('pool')
  })
})

// 农场页自报状态：无头模式下用户看不到农场页，卡住时必须让面板能说出原因。
// 实测触发过：一次无超时的 fetch 挂死 → verifying 永久为 true → 农场静默停摆 4 分钟。
describe('农场页自报状态（/farm-report）', () => {
  const getJson = async (path) => JSON.parse((await get(path)).text)

  it('上报后 /param-status 带出 farmReport', async () => {
    const r = await post('/farm-report', { total: 3, pushed: 3, fails: 1, backoffMs: 8000, stuck: false, lastLine: '[10:00:00] ok' })
    expect(r.status).toBe(200)
    const st = await getJson('/param-status')
    expect(st.farmReport).toMatchObject({ total: 3, pushed: 3, fails: 1, backoffMs: 8000, stuck: false, lastLine: '[10:00:00] ok' })
    expect(typeof st.farmReport.at).toBe('number')
  })

  it('坏 JSON 不让接口报错，也不污染既有上报', async () => {
    await post('/farm-report', { total: 1, lastLine: 'ok' })
    const bad = await new Promise((resolve, reject) => {
      const req = http.request(base + '/farm-report', { method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end('not json at all')
    })
    expect(bad).toBe(200)
    expect((await getJson('/param-status')).farmReport.total).toBe(1)
  })

  it('字段类型异常时归零，不写入 NaN；超长日志被截断', async () => {
    await post('/farm-report', { total: 'abc', pushed: -5, fails: null, backoffMs: 'x', stuck: 'yes', lastLine: 'y'.repeat(1000) })
    const r = (await getJson('/param-status')).farmReport
    expect(r.total).toBe(0)
    expect(r.pushed).toBe(0)
    expect(r.stuck).toBe(false)
    expect(r.lastLine.length).toBe(300) // 截断，避免面板被超长串撑爆
  })

  it('从未上报时 farmReport 为 null（面板据此显示"农场页未上报"）', async () => {
    // 用独立实例，避免受本文件其他用例已上报的影响
    const solo = startFarmServer({ paramPool: new ParamPool({}), port: 0, host: '127.0.0.1', certDir: './nonexistent-certs' })
    const soloBase = await new Promise((resolve) =>
      solo.server.listening
        ? resolve(`http://127.0.0.1:${solo.server.address().port}`)
        : solo.server.once('listening', () => resolve(`http://127.0.0.1:${solo.server.address().port}`)),
    )
    const st = await fetch(`${soloBase}/param-status`).then((x) => x.json())
    expect(st.farmReport).toBeNull()
    expect(st.pool).toBe(0)
    await solo.close()
  })
})

// 绑 0.0.0.0 时必须回报一个**能打开**的地址。
// 实测：把 HOST 改成 0.0.0.0 后 farm.url 变成 http://0.0.0.0:28631/farm，
// playwright 导航直接失败（net::ERR_HTTP_RESPONSE_CODE_FAILURE），农场浏览器起不来。
describe('farm url 不把通配地址当访问地址', () => {
  it('监听 0.0.0.0 时 url 用 127.0.0.1', async () => {
    const solo = startFarmServer({ paramPool: new ParamPool({}), port: 0, host: '0.0.0.0', certDir: './nonexistent-certs' })
    await new Promise((resolve) => (solo.server.listening ? resolve() : solo.server.once('listening', resolve)))
    expect(solo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/farm$/)
    // 该地址必须真的能打开
    const r = await fetch(solo.url)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('AliyunCaptcha')
    await solo.close()
  })

  it('监听 127.0.0.1 时 url 也用 127.0.0.1', async () => {
    const solo = startFarmServer({ paramPool: new ParamPool({}), port: 0, host: '127.0.0.1', certDir: './nonexistent-certs' })
    await new Promise((resolve) => (solo.server.listening ? resolve() : solo.server.once('listening', resolve)))
    expect(solo.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/farm$/)
    await solo.close()
  })
})
