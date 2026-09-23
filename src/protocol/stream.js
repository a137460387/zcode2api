const uuid = () => globalThis.crypto.randomUUID()

// SSE 帧解析：既支持标准 `data: {...}\n\n` 分帧，也支持块边界直接粘连
// （上游/测试夹具可能不以换行字节分隔 `data:` 行）。返回解析出的事件数组，
// 并把未消费的残留写回 state.buf。
function drainEvents(state, out) {
  let idx
  while ((idx = state.buf.indexOf('\n')) !== -1) {
    const line = state.buf.slice(0, idx).trim()
    state.buf = state.buf.slice(idx + 1)
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { out.push(JSON.parse(data)) } catch {}
  }
  if (state.buf && !state.buf.includes('\n')) {
    const parts = state.buf.split(/(?=data:)/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1) {
      state.buf = ''
      for (const p of parts) {
        if (!p.startsWith('data:')) continue
        const data = p.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try { out.push(JSON.parse(data)) } catch {}
      }
    }
  }
}

function makeDecoderState() {
  return { decoder: new TextDecoder(), buf: '' }
}

async function* sseEvents(res) {
  const reader = res.body.getReader()
  const state = makeDecoderState()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    state.buf += state.decoder.decode(value, { stream: true })
    const out = []
    drainEvents(state, out)
    yield* out
  }
  if (state.buf.trim()) {
    state.buf += '\n'
    const out = []
    drainEvents(state, out)
    yield* out
  }
}

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length' }

export async function pipeAnthropicToOpenAISSE(res, write, model) {
  const id = 'chatcmpl-' + uuid()
  const created = Math.floor(Date.now() / 1000)
  let usage = { inputTokens: 0, outputTokens: 0 }
  const send = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  for await (const ev of sseEvents(res)) {
    if (ev.type === 'message_start') {
      usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }] })
      } else if (ev.delta?.type === 'thinking_delta') {
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: ev.delta.thinking }, finish_reason: null }] })
      }
    } else if (ev.type === 'message_delta') {
      if (ev.usage) usage.outputTokens = ev.usage.output_tokens ?? usage.outputTokens
      const fr = FINISH[ev.delta?.stop_reason] || 'stop'
      send({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: fr }],
        usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
      })
    }
  }
  write('data: [DONE]\n\n')
  return usage
}

export async function pipeRaw(res, write) {
  const reader = res.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    write(value)
  }
}

export async function pipeAnthropicSSEWithUsage(res, write) {
  const reader = res.body.getReader()
  const state = makeDecoderState()
  let usage = { inputTokens: 0, outputTokens: 0 }
  const absorb = (ev) => {
    if (ev.type === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens
    if (ev.type === 'message_delta') usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    write(value)
    state.buf += state.decoder.decode(value, { stream: true })
    const out = []
    drainEvents(state, out)
    for (const ev of out) absorb(ev)
  }
  if (state.buf.trim()) {
    state.buf += '\n'
    const out = []
    drainEvents(state, out)
    for (const ev of out) absorb(ev)
  }
  return usage
}

export async function tapAnthropicSSE(res, onEvent) {
  const usage = { inputTokens: 0, outputTokens: 0 }
  for await (const ev of sseEvents(res)) {
    if (ev.type === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens
    if (ev.type === 'message_delta') usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens
    onEvent(ev)
  }
  return usage
}
