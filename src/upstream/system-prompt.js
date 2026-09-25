import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * ZCode 官方 system prompt 组装。
 *
 * **为什么必须做这件事**：上游网关会对请求做**内容检查**——如果 `system` 字段里
 * 看不到 ZCode 的身份块，直接返回 `3012 "method not allowed"`（表现为
 * "request has been blocked due to unusual activity"）。这解释了本项目此前
 * 无论怎么调整 captcha 参数、请求头、IP 都过不去的现象：**发出去的是"裸请求"，
 * 形态不像官方客户端。**
 *
 * 官方客户端的组装形态（已逐块核对）：
 *   1. `cliPrefix` 单独一块（`"You are ZCode, an interactive coding agent"`）
 *   2. 其余 stable 段以 `\n\n` 连接成一块
 *   3. dynamic 段（含 Environment Info）以 `\n\n` 连接，且块文本以 `\n\n` 开头
 *   每块都带 `cache_control: {type:"ephemeral"}`。
 *   用户首轮消息前另挂一条 `<system-reminder>…# currentDate…</system-reminder>`。
 *
 * 静态文案取自 `zcode-system.json`（从官方 3.11.2 bundle 提取的模块化资产）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'zcode-system.json'), 'utf8'))

const EPHEMERAL = { type: 'ephemeral' }

/** 本地日期（官方用本地时区的 ISO 日期，不用 UTC）。 */
function formatLocalIsoDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function normalizeSystemBlocks(system) {
  if (system == null) return []
  if (typeof system === 'string') {
    const t = system.trim()
    return t ? [{ type: 'text', text: t }] : []
  }
  if (!Array.isArray(system)) return []
  const out = []
  for (const item of system) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ type: 'text', text: item })
    } else if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      out.push({ type: 'text', text: item.text })
    }
  }
  return out
}

/** Environment Info 段：用真实运行环境的 cwd/platform/shell，避免与请求头矛盾。 */
export function buildEnvironmentSection({ cwd = process.cwd(), model, provider = 'bigmodel' } = {}) {
  const e = data.environment
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const shell = process.platform === 'win32' ? 'cmd' : (process.env.SHELL ?? 'sh')
  const lines = [
    e.heading,
    `- ${e.cwdLabel}: ${cwd}`,
    e.invokedLine,
    `- ${e.platformLabel}: ${platform}`,
    `- ${e.shellLabel}: ${shell}`,
    `- ${e.osVersionLabel}: ${os.release()}`,
  ]
  if (model) {
    // 官方格式：`- You are powered by the model named {providerId}/{modelId}.`
    lines.push(e.poweredByLine.replace('{provider}', `${provider}-api`).replace('{model}', model))
  }
  const gitNo = e.gitLabel && e.gitNo ? [`- ${e.gitLabel}: ${e.gitNo}`] : []
  return [...lines, ...gitNo].join('\n')
}

/**
 * 组装官方式的 `system` 块数组（三块 + 调用方原有的 system 块）。
 * `currentModel` 用**小写**模型名（官方发的是小写）。
 */
export function buildZcodePlanSystem({ existingSystem, currentModel, provider = 'bigmodel', cwd } = {}) {
  const stable = data.stableSections.join('\n\n')
  const dynamic = [
    data.dynamicSections.beforeEnvironment,
    buildEnvironmentSection({ cwd, model: currentModel, provider }),
    data.dynamicSections.afterEnvironment,
  ].join('\n\n')
  const official = [
    { type: 'text', text: data.cliPrefix, cache_control: { ...EPHEMERAL } },
    { type: 'text', text: stable, cache_control: { ...EPHEMERAL } },
    { type: 'text', text: `\n\n${dynamic}`, cache_control: { ...EPHEMERAL } },
  ]
  return [...official, ...normalizeSystemBlocks(existingSystem)]
}

/** 官方客户端总会给首轮用户消息挂一条 currentDate 上下文（`<system-reminder>` 包裹）。 */
export function buildContextPrefixBlock(now = new Date()) {
  const cp = data.contextPrefix
  const body = [cp.intro, `${cp.currentDateHeading}\n${cp.currentDateLine.replace('{date}', formatLocalIsoDate(now))}`, '', cp.outro].join('\n')
  return { type: 'text', text: `${data.systemReminder.open}${body}${data.systemReminder.close}` }
}

/** 把上下文前缀块插到首个 user 消息的 content 数组最前面（已存在则不动）。 */
export function attachContextPrefix(messages, now = new Date()) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const first = messages[0]
  if (!first || first.role !== 'user') return messages
  const content = Array.isArray(first.content)
    ? first.content
    : [{ type: 'text', text: String(first.content ?? '') }]
  const marker = data.systemReminder.open
  if (content.some((c) => c?.type === 'text' && typeof c.text === 'string' && c.text.startsWith(marker))) {
    return messages
  }
  return [{ ...first, content: [buildContextPrefixBlock(now), ...content] }, ...messages.slice(1)]
}

/** 供测试/调试：暴露静态资产。 */
export function systemAssets() {
  return data
}
