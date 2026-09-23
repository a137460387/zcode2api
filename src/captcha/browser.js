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
    const page = await (await browser.newContext()).newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    log(`[farm] 自动农场浏览器已启动 → ${url}`)
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
