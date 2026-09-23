export async function launchFarmBrowser({ url, headless = true, chromePath = '', log = () => {} }) {
  let pw
  try {
    pw = await import('playwright')
  } catch {
    log(`[farm] playwright 未安装，跳过自动农场；请手动打开 ${url} 并保持标签页`)
    return null
  }
  try {
    const browser = await pw.chromium.launch({
      channel: chromePath ? undefined : 'chrome',
      headless,
      executablePath: chromePath || undefined,
    })
    const page = await (await browser.newContext()).newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    log(`[farm] 自动农场浏览器已启动 → ${url}`)
    return browser
  } catch (e) {
    log(`[farm] 自动农场启动失败：${e.message}；可手动打开 ${url}`)
    return null
  }
}
