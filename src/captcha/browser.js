/** 与 headless 模式下的真实 UA 对齐：默认 UA 含 `HeadlessChrome/<ver>` 字样，阿里验证码 SDK
 *  据此判定为自动化并返回 F001（verifyResult:false），导致农场一个参数都产不出来。
 *  实测（受控实验）：headless + 默认 UA → F001；headless + 本 UA → 正常产出。
 *  注意 SDK **不检查** `navigator.webdriver`（实验中有无该标志都不影响结果）。 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

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
    // headless 下必须覆盖 UA，否则 SDK 见 `HeadlessChrome` 直接判 F001（见 DESKTOP_UA 注释）。
    // 有头模式本身就不含该字样，但统一设置可避免两种模式行为不一致。
    const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } })
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
