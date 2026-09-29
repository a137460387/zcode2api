import fs from 'node:fs'
import path from 'node:path'

// 解析 `.env` 后回填到 `target`。已有的键不覆盖（与既有语义一致）。
// 调用方传入自定义 env 时只合并进该对象，绝不碰 process.env。
function loadDotEnv(rootDir, target) {
  const file = path.join(rootDir, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || target[m[1]] !== undefined) continue
    target[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

// 数值解析：缺省、全空白、非数字、非有限数或超出 [min, max] 一律回退默认值。
function num(v, d, min = -Infinity, max = Infinity) {
  if (v === undefined || String(v).trim() === '') return d
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return d
  return n
}

export function loadConfig({ rootDir = process.cwd(), env = process.env } = {}) {
  loadDotEnv(rootDir, env)
  const bool = (v, d) => (v === undefined || v === '' ? d : v === '1' || v === 'true')
  return {
    rootDir,
    port: num(env.PORT, 28630, 1, 65535),
    host: env.HOST || '127.0.0.1',
    farmPort: num(env.FARM_PORT, 28631, 1, 65535),
    apiKey: env.API_KEY || '',
    // 引导密码：仅在还没在面板里改过密码（没有 panel.json）时生效。
    panelPassword: env.PANEL_PASSWORD || '',
    /**
     * 本机是否免密进管理面板。默认开（本机工具的使用直觉）。
     * 设 0 后本机也要带面板密码/token——面板挂在反向代理后面时，
     * 代理回源地址是本机，开着放行等于任何人都能进管理面。
     */
    panelLocalBypass: bool(env.PANEL_LOCAL_BYPASS, true),
    /**
     * 完全免密（含非本机）。默认关。
     * 管理面板能改 API Key、删账号，默认敞开等于把凭据管理交出去；
     * 只有明确设置才开，且面板里会持续显示红色警示。
     */
    panelDisableAuth: bool(env.PANEL_DISABLE_AUTH, false),
    poolDir: env.POOL_DIR || path.join(rootDir, 'accounts'),
    certDir: env.CERT_DIR || path.join(rootDir, 'certs'),
    /**
     * 默认**有头**（false）。这与最初的默认值相反，是实测后的修正。
     *
     * 早先的结论是"无头 + 覆盖 UA 即可正常产出"，故默认无头。2026-09-27 实测该结论已失效：
     * 同一台机器、同一份配置，无头模式下连续数小时稳定吃 `F011`（`success:true` 但
     * `verifyResult:false`），`param` 产出恒为 0，整个 API 对外只会回 `captcha param pool
     * is empty`；改为有头后 F011 立即消失、参数稳定产出。
     *
     * 排查过程排除了这些假设，别再重复走：整页重载（无效）、清掉同 IP 的重复实例（无效）、
     * 换出口 IP（`14.146.x` → `14.31.x`，无效）。既然换 IP 都不影响，就不是网络层的事，
     * 而是 SDK 已能从 UA/`navigator.webdriver` 之外的指纹特征（Canvas/WebGL/GPU 等）认出无头。
     */
    farmHeadless: bool(env.FARM_HEADLESS, false),
    // 手动模式：关闭自动农场浏览器，改用用户自己的真实 Chrome 打开 farm 页。
    // 必要性：playwright 驱动的浏览器（即便覆盖 UA）仍带自动化特征，产出的 captcha 参数
    // 会被上游判低风险分并返回 3012；真实 Chrome 环境产出的参数才能通过（详见 README）。
    farmAutoBrowser: bool(env.FARM_AUTO_BROWSER, true),
    /**
     * 有头模式下把农场窗口直接最小化到任务栏，屏幕上就看不到它了。
     *
     * 默认关：窗口可见是最"诚实"的状态，出问题时一眼能看见；开着它属于把
     * 一个可见窗口藏起来，收益只是清爽，代价是排查时容易忘了它存在。
     *
     * 只在有头模式下有效（headless=true 时忽略，无头本来就没有窗口）。
     * 这不等于无头——实测最小化状态下农场照常产出。但它依赖"SDK 不检查窗口
     * 可见性"这一尚未被机制性证实的假设，失效时会静默变成 F011 + 产出归零，
     * 所以怀疑农场有问题时先关掉它复现。
     */
    farmMinimized: bool(env.FARM_MINIMIZED, false),
    chromePath: env.CHROME_PATH || '',
    poolSize: num(env.POOL_SIZE, 6, 1),
    paramTtlMs: num(env.PARAM_TTL_MS, 8 * 60_000, 0),
    // 参数被上游**接受**的时效（短于 PARAM_TTL_MS，后者只是内存保留时长）。
    // 实测 48s 的参数已被判 3007，故默认 40s 并留一点余量。
    paramUsableMs: num(env.PARAM_USABLE_MS, 40_000, 0),
    minIntervalMs: num(env.ACCOUNT_MIN_INTERVAL_MS, 2000, 1),
    cooldown3012Ms: num(env.COOLDOWN_3012_MIN, 30, 0) * 60_000,
    /**
     * 1005 连续熔断：同一（账号, 模型）连续 C1005_TRIP 次 1005 → 不看余额直接对该模型
     * 雪藏 C1005_BENCH_MIN 分钟（进程内）。动机：余额接口与模型端点口径打架时（实测某号
     * 余额坚称 300 万、端点必回 1005，21 次连败并诱发 3012 全池级联，2026-09-30 凌晨），
     * 让调度器自动绕开必然失败的组合。详见 accounts.js 的 benched1005。
     */
    c1005Trip: num(env.C1005_TRIP, 3, 1),
    c1005BenchMs: num(env.C1005_BENCH_MIN, 30, 0) * 60_000,
    maxRetries: num(env.MAX_RETRIES, 2, 0),
  }
}
