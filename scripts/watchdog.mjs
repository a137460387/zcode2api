// zcode2api 崩溃看门：探活 /health，发现服务死了（连不上 / 非 200）就重启计划任务。
//
// 为什么需要：计划任务 zcode2api-Gateway 触发器只有"登录时"，RestartCount=3 只在**启动瞬时**
// 失败时重试——node 在跑的过程中崩了（OOM / 端口被抢 / 误杀）就再没人拉它，要等下次登录。
// 这个脚本由另一个计划任务（zcode2api-Watchdog）每 5 分钟跑一次，保证服务死掉后 5 分钟内
// 被拉回来。
//
// 用法：
//   node scripts/watchdog.mjs                # 探活一次，死了就重启
//   node scripts/watchdog.mjs --register     # 把自身注册成计划任务（每 5 分钟跑一次）
//   node scripts/watchdog.mjs --unregister   # 移除计划任务
//
// 端口/host：从同目录 .env 读 PORT / HOST；未设时按 config.js 默认值（28630 / 127.0.0.1）。
// 任务名：zcode2api-Watchdog；不冲突；多次注册先 unregister 再 register。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TASK_NAME = 'zcode2api-Watchdog'
const GATEWAY_TASK = 'zcode2api-Gateway'
const LOG_FILE = path.join(ROOT, 'logs', 'watchdog.log')

function readEnv(key, fallback) {
  try {
    const envFile = path.join(ROOT, '.env')
    const txt = fs.readFileSync(envFile, 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const m = new RegExp(`^${key}=(.*)$`).exec(line.trim())
      if (m) return m[1].trim()
    }
  } catch { /* .env 不存在就用默认 */ }
  return fallback
}

const HOST = readEnv('HOST', '127.0.0.1')
const PORT = Number(readEnv('PORT', '28630'))
const HEALTH_URL = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/health`

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch { /* 日志写不进也不阻塞看门 */ }
  process.stdout.write(line)
}

async function isAlive() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    const r = await fetch(HEALTH_URL, { signal: ctl.signal, cache: 'no-store' })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

function restartGateway() {
  // 按端口反查 PID（README 第 100-102 行警告过：绝不能按 `node src/server.js` 命令行匹配，
  // 因为同机的 trae2api 命令行一模一样）。找到就 taskkill，再 Start-ScheduledTask。
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ], { encoding: 'utf8' }).trim()
    const pid = Number(out)
    if (Number.isInteger(pid) && pid > 0) {
      logLine(`killing stale listener on ${PORT}: pid=${pid}`)
      try { execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' }) } catch (e) {
        logLine(`taskkill failed: ${e.message}`)
      }
    }
  } catch (e) {
    logLine(`PID lookup failed (端口可能已释放): ${e.message}`)
  }
  logLine(`Start-ScheduledTask ${GATEWAY_TASK}`)
  execFileSync('powershell', ['-NoProfile', '-Command', `Start-ScheduledTask -TaskName '${GATEWAY_TASK}'`], { stdio: 'ignore' })
}

function registerTask() {
  const nodeExe = process.execPath.replace(/"/g, '""')
  const script = path.join(ROOT, 'scripts', 'watchdog.mjs').replace(/"/g, '""')
  const ps = `
$action = New-ScheduledTaskAction -Execute '"${nodeExe}"' -Argument '"${script}"' -WorkingDirectory '${ROOT}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "OK"
`
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  console.log(`已注册计划任务 ${TASK_NAME}：每 5 分钟探活 ${HEALTH_URL}`)
}

function unregisterTask() {
  execFileSync('powershell', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`], { stdio: 'inherit' })
  console.log(`已移除计划任务 ${TASK_NAME}`)
}

const arg = process.argv[2]
if (arg === '--register') registerTask()
else if (arg === '--unregister') unregisterTask()
else {
  const alive = await isAlive()
  if (alive) {
    logLine('ok')
  } else {
    logLine(`health check failed for ${HEALTH_URL}, restarting gateway`)
    try {
      restartGateway()
      logLine('restart issued')
    } catch (e) {
      logLine(`restart failed: ${e.message}`)
      process.exitCode = 1
    }
  }
}
