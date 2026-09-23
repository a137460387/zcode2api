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
