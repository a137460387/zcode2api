const uuid = () => globalThis.crypto.randomUUID()

function mergeConsecutive(messages) {
  const out = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content.push(...m.content)
    else out.push({ ...m, content: [...m.content] })
  }
  return out
}

export function openaiToAnthropic(oa, mapModel) {
  const systemParts = []
  const messages = []
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
        if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
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
