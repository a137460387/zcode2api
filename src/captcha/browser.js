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
 *
 *    ⚠️ 上面这条"headless + 本 UA 即可正常产出"的结论 **2026-09-27 已被推翻**。
 *    现在无头模式（即便 UA 正确）会稳定吃 `F011`，产出恒为 0；改为有头立即恢复。
 *    说明 SDK 已能从 UA 与 `navigator.webdriver` 之外的指纹特征识别无头环境，
 *    覆盖 UA 不再够用。故默认值已改为有头（见 config.js 的 farmHeadless）。
 *    本函数保留 UA 覆盖仍有用——防的是"写死旧版本号被判低分 → 上游 3012"（第 2 点）。
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

export async function launchFarmBrowser({ url, headless = false, chromePath = '', minimized = false, log = () => {} }) {
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
      /**
       * `--start-minimized` 让有头窗口直接缩进任务栏，屏幕上看不到它。
       *
       * 这不等于回到无头：无头会被上游判 F011（见 config.js 的 farmHeadless），
       * 而这里仍是**有头**浏览器，只是窗口最小化。实测该状态下农场照常产出
       * （280 字符参数、fails 恒为 0）。
       *
       * 注意这是"当前实测可用"而非"机制上保证可用"：我们只知道 SDK 会认无头，
       * 并不确切知道它查哪些特征。若哪天它开始检查窗口可见性，最小化会像无头
       * 一样静默失效（表现为 F011、产出归零）。所以排查农场时先把它关掉，
       * 用可见窗口复现，再判定问题。
       */
      args: minimized && !headless ? ['--start-minimized'] : [],
    })
    // 必须覆盖 UA（否则 SDK 见 `HeadlessChrome` 判 F001），且用本机 Chrome 的真实版本号
    // （写死旧版本会与本机浏览器不符，参数可能被判低分 → 上游 3012）。见 desktopUA 注释。
    const ua = desktopUA(chromePath)
    log(`[farm] 农场浏览器 UA 主版本 = ${ua.match(/Chrome\/(\d+)/)?.[1] ?? '?'}`)
    const context = await browser.newContext({ userAgent: ua, viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // 把"窗口现在是什么状态"讲清楚：最小化后屏幕上没有窗口，用户看到这行才知道
    // 该去哪儿找回它（任务栏），也才知道它并没有变成无头。
    const windowMode = headless ? '无头' : minimized ? '有头（窗口已最小化到任务栏）' : '有头（窗口可见）'
    log(`[farm] 自动农场浏览器已启动（${windowMode}） → ${url}`)
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
