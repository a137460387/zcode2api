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

  /**
   * 农场页自报的健康状态（最近一条日志、连续失败次数、退避时长）。
   *
   * 为什么需要它：`FARM_AUTO_BROWSER=1`（默认）时农场页跑在**无头浏览器**里，
   * 用户看不到那个页面的日志。农场一旦卡住（实测：一次 fetch 挂死让 `verifying`
   * 永久为 true，页面每 2s 空转、一个参数都不再产出），面板只能看到"池是空的"，
   * 却看不到原因，用户只能去猜。让页面把自身状态推给服务端，面板就能直接说清。
   */
  let farmReport = null

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
    if (req.method === 'POST' && url.pathname === '/farm-report') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      return req.on('end', () => {
        try {
          const r = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          // 计数一律钳到非负整数：上报来自页面，字段类型/符号都可能异常，
          // 而面板会直接把它显示出来（负数或 NaN 会渲染成看不懂的怪值）。
          const count = (v) => Math.max(0, Math.floor(Number(v)) || 0)
          farmReport = {
            at: Date.now(),
            total: count(r.total),
            pushed: count(r.pushed),
            fails: count(r.fails),
            backoffMs: count(r.backoffMs),
            stuck: r.stuck === true,
            lastLine: typeof r.lastLine === 'string' ? r.lastLine.slice(0, 300) : '',
          }
        } catch { /* 坏上报忽略：它只是诊断信息，不该影响产出路径 */ }
        return json(res, 200, { ok: true })
      })
    }
    if (req.method === 'GET' && url.pathname === '/param-status') {
      return json(res, 200, { ...paramPool.status(), farmReport })
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
      const scheme = useHttps ? 'https' : 'http'
      if (!addr) return `${scheme}://127.0.0.1:${port}/farm`
      /**
       * 绑定 `0.0.0.0`/`::` 时**不能**把通配地址当访问地址回给浏览器：
       * playwright 导航到 `http://0.0.0.0:28631/farm` 会直接失败
       * （实测 `net::ERR_HTTP_RESPONSE_CODE_FAILURE`），农场浏览器因此根本起不来。
       * 本机访问始终用 127.0.0.1。
       */
      const ip = addr.address === '0.0.0.0' || addr.address === '::' ? '127.0.0.1' : addr.address
      return `${scheme}://${ip}:${addr.port}/farm`
    },
    get report() {
      return farmReport
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
