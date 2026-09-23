import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

export function startFarmServer({ paramPool, port, host = '127.0.0.1', certDir = '' }) {
  const keyFile = path.join(certDir, 'localhost-key.pem')
  const certFile = path.join(certDir, 'localhost.pem')
  const useHttps = certDir && fs.existsSync(keyFile) && fs.existsSync(certFile)
  const lib = useHttps ? https : http
  const opts = useHttps ? { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) } : {}
  const page = fs.readFileSync(path.join(__dirname, 'farm-page.html'), 'utf8')

  const server = lib.createServer(opts, (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (req.method === 'GET' && url.pathname === '/farm') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(page)
    }
    if (req.method === 'POST' && url.pathname === '/param') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      return req.on('end', () => {
        try {
          const { param } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof param === 'string' && param.length > 50) {
            paramPool.push(param)
            return json(res, 200, { ok: true, pool: paramPool.status().pool })
          }
          return json(res, 400, { ok: false, msg: 'invalid param' })
        } catch {
          return json(res, 400, { ok: false, msg: 'bad json' })
        }
      })
    }
    if (req.method === 'GET' && url.pathname === '/param-status') {
      return json(res, 200, paramPool.status())
    }
    json(res, 404, { msg: 'not found' })
  })
  // farm 实例需要 close() 返回 promise：brief 的测试用 `afterAll(() => farm.close())` 直接
  // 交回，vitest 会 await 它，返回 undefined 会让 socket 未被回收而阻塞进程退出。
  // 只挂 'close' 事件处理器不足以让 server close 回调触发，不用 unref。
  server.listen(port, host)
  return {
    server,
    get url() {
      const addr = server.address()
      if (!addr) return `${useHttps ? 'https' : 'http'}://${host}:${port}/farm`
      return `${useHttps ? 'https' : 'http'}://${addr.address}:${addr.port}/farm`
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
