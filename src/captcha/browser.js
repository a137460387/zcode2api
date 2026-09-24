import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

/**
 * 构造与真实桌面 Chrome 一致的 UA。
 *
 * 两个必要性：
 * 1. **必须覆盖**：headless 下默认 UA 含 `HeadlessChrome/<ver>`，阿里验证码 SDK 据此判自动化
 *    并返回 F001（verifyResult:false），农场一个参数都产不出来。
 *    实测（受控实验）：headless + 默认 UA → F001；headless + 本 UA → 正常产出 3 个。
 *    注：SDK **不检查** `navigator.webdriver`（实验中该标志始终为 true，不影响结果）。
 * 2. **版本号要真实**：写死旧版本号（如 `Chrome/141`）会与实际浏览器不符，
 *    参数可能被判低分（上游返回 3012 行为风控）。故优先探测本机 Chrome 的真实版本。
 */
function detectChromeVersion(chromePath) {
  // 1) 显式路径 → 2) 常见安装位置
  const candidates = [
    chromePath,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean)
  for (const exe of candidates) {
    try {
      if (!fs.existsSync(exe)) continue
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        `(Get-Item '${exe}').VersionInfo.ProductVersion`,
      ], { encoding: 'utf8', timeout: 5000 }).trim()
      const major = out.split('.')[0]
      if (/^\d{2,3}$/.test(major)) return major
    } catch { /* 下一个候选 */ }
  }
  return null
}

let cachedUA = null
function desktopUA(chromePath) {
  if (cachedUA) return cachedUA
  const major = detectChromeVersion(chromePath) ?? '141'
  cachedUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  return cachedUA
}

export async function launchFarmBrowser({ url, headless = true, chromePath = '', log = () => {} }) {
  let pw
  try {
    pw = await import('playwright')
  } catch {
    log(`[farm] playwright 未安装，跳过自动农场；请手动打开 ${url} 并保持标签页`)
    return null
  }
  let browser = null
  try {
    browser = await pw.chromium.launch({
      channel: chromePath ? undefined : 'chrome',
      headless,
      executablePath: chromePath || undefined,
    })
    // 必须覆盖 UA（否则 SDK 见 `HeadlessChrome` 判 F001），且用本机 Chrome 的真实版本号
    // （写死旧版本会与浏览器实际版本不符，参数可能被判低分 → 上游 3012）。见 desktopUA 注释。
    const ua = desktopUA(chromePath)
    log(`[farm] 农场浏览器 UA 主版本 = ${ua.match(/Chrome\/(\d+)/)?.[1] ?? '?'}`)
    const context = await browser.newContext({ userAgent: ua, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    log(`[farm] 自动农场浏览器已启动（headless=${headless}） → ${url}`)
    return browser
  } catch (e) {
    // 启动成功后任何一步失败都要回收浏览器，否则每次失败都留下一组孤儿 Chrome 进程
    // （实测 goto 失败一次泄漏 8 个 chrome.exe 且持续存活）。
    if (browser) {
      try { await browser.close() } catch {}
    }
    log(`[farm] 自动农场启动失败：${e.message}；可手动打开 ${url}`)
    return null
  }
}
