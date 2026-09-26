const uuid = () => globalThis.crypto.randomUUID()

// Anthropic 语义的图片媒体类型白名单（png/jpeg/gif/webp）。
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// 单张图片解码后的字节上限（Anthropic 协议按 5MB 计；超限请求发到上游也只会被拒）。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function contentError(message, code = 'unsupported_content') {
  const err = new Error(message)
  err.status = 400
  err.code = code
  throw err
}

/** data URL（dsh 截图等本地内联图片的标准形态）→ Anthropic base64 图片块。 */
function dataUrlToImageBlock(url) {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
  if (!m) contentError('无法解析的图片 data URL（期望 data:<mediatype>;base64,<payload>）')
  const mediaType = m[1].trim().toLowerCase()
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    contentError(`不支持的图片类型 ${mediaType}（支持 png/jpeg/gif/webp）`)
  }
  const data = m[2].replace(/\s+/g, '')
  if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) {
    contentError(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
}

/**
 * 远程图片 → 下载后转 base64。**不透传 url 形态的 source**：上游对它的支持未验证，
 * 而 base64 是官方客户端（截图粘贴）实证可用的形态。类型按 content-type 先行校验，
 * 避免把无关大文件整个拉下来才发现不能要。
 */
async function fetchUrlToImageBlock(url, fetchImpl) {
  let res
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
  } catch (e) {
    contentError(`图片下载失败: ${e.message}`, 'image_fetch_failed')
  }
  if (!res.ok) contentError(`图片下载失败: HTTP ${res.status}`, 'image_fetch_failed')
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    contentError(`远程图片类型不受支持: ${mediaType || '未知'}（支持 png/jpeg/gif/webp）`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    contentError(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } }
}

function mergeConsecutive(messages) {
  const out = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content.push(...m.content)
    else out.push({ ...m, content: [...m.content] })
  }
  return out
}

export async function openaiToAnthropic(oa, mapModel, { fetchImpl = fetch } = {}) {
  const systemParts = []
  const messages = []
  let hasImage = false
  for (const m of oa.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content || []).map((c) => c.text).filter(Boolean).join('\n')
      if (text) systemParts.push(text)
      continue
    }
    const blocks = []
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content })
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text' && c.text) {
          blocks.push({ type: 'text', text: c.text })
        } else if (c.type === 'image_url') {
          // 静默丢弃图片会让模型基于纯文本"自信作答"，客户端拿到貌似成功的错误结果——比直接报错更糟。
          const url = c.image_url?.url ?? c.url
          if (typeof url !== 'string' || !url) contentError('image_url 缺少 url 字段')
          blocks.push(url.startsWith('data:') ? dataUrlToImageBlock(url) : await fetchUrlToImageBlock(url, fetchImpl))
          hasImage = true
        } else if (c.type === 'input_audio' || c.type === 'image') {
          // 音频没有上游支持；裸 `image` 不是 OpenAI 协议形态（标准是 image_url），一并显式拒绝。
          contentError(`unsupported content type: ${c.type}（本网关不支持音频输入；图片请用 image_url）`)
        }
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let input = {}
        try { input = JSON.parse(tc.function?.arguments || '{}') } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input })
      }
    }
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null)
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }] })
      continue
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' })
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks })
  }
  /**
   * 视觉门控：上游目录里只有 GLM-5.3-Flash 带 vision（GLM-5.3 没有）。带图的请求发给
   * 非视觉模型，会在白烧一个 captcha 参数后才吃到上游 400——本地直接拒绝，让客户端立刻换模型。
   * 未知名单之外的模型不拦（可能是未来接入的视觉模型），交给上游判。
   */
  if (hasImage && mapModel(oa.model) === 'GLM-5.3') {
    contentError('模型 glm-5.3 不支持图片输入；带图片的请求请改用 glm-5.3-flash')
  }
  let merged = mergeConsecutive(messages)
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: [{ type: 'text', text: '' }] })
  }
  if (!merged.length) merged = [{ role: 'user', content: [{ type: 'text', text: '' }] }]
  const body = {
    model: mapModel(oa.model),
    max_tokens: oa.max_tokens ?? 4096,
    stream: Boolean(oa.stream),
    messages: merged,
  }
  if (systemParts.length) body.system = [{ type: 'text', text: systemParts.join('\n\n') }]
  if (oa.temperature != null) body.temperature = oa.temperature
  if (oa.top_p != null) body.top_p = oa.top_p
  if (Array.isArray(oa.stop) && oa.stop.length) body.stop_sequences = oa.stop
  if (Array.isArray(oa.tools) && oa.tools.length) {
    body.tools = oa.tools
      .filter((t) => t.function)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }))
  }
  const effort = oa.reasoning_effort ?? oa.think_effort
  if (effort) body.output_config = { effort }
  return body
}

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }

export function anthropicToOpenAI(a, model) {
  const blocks = a.content || []
  const text = blocks.filter((c) => c.type === 'text').map((c) => c.text).join('')
  const thinking = blocks.filter((c) => c.type === 'thinking').map((c) => c.thinking).join('')
  const toolCalls = blocks.filter((c) => c.type === 'tool_use').map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
  }))
  // OpenAI 规范：带工具调用时 content 为 null（而非空串），避免客户端当作空回复
  const message = { role: 'assistant', content: toolCalls.length && !text ? null : text }
  if (thinking) message.reasoning_content = thinking
  if (toolCalls.length) message.tool_calls = toolCalls
  const input = a.usage?.input_tokens ?? 0
  const output = a.usage?.output_tokens ?? 0
  return {
    id: 'chatcmpl-' + (a.id || uuid()),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: FINISH[a.stop_reason] || 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  }
}
