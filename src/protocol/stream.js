const uuid = () => globalThis.crypto.randomUUID()

// SSE 帧解析：按换行分帧，只消费**完整行**，未收全的残留留在 state.buf 等下一个 chunk。
// 真实上游的 Anthropic SSE 每个事件都以换行结尾（`data: {...}\n\n`），故只需按 `\n` 切。
// 不按 `data:` 边界做启发式切分：那会把"已收到一半的下一个 data: 帧"当成完整帧去解析，
// 失败后静默丢弃，其剩余字节因失去前缀而永远无法重组（丢事件）。
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

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' }

const newUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })

/**
 * 从一帧事件里吸收 usage。
 *
 * **关键（真实上游实测）**：流式响应里 `message_start` 的 `input_tokens` 是 **0**，
 * 真正的输入 token 数在最后那帧 `message_delta` 里才给出
 * （实测 `message_start: {"input_tokens":0,"output_tokens":0}` →
 *  `message_delta: {"input_tokens":1703,"output_tokens":3,"cache_read_input_tokens":0}`）。
 * 只读 `message_start` 会让每个流式请求都记成 0 输入 token：面板用量少算一大截，
 * 且发给 OpenAI 客户端的 usage 块里 `prompt_tokens` 恒为 0——那是**对外可见的错误数据**。
 * 故两处都要读，且以 `message_delta` 的值优先（它更晚、更准）。
 */
function absorbUsage(usage, ev) {
  const u = ev.type === 'message_start' ? ev.message?.usage : ev.type === 'message_delta' ? ev.usage : null
  if (!u) return
  if (u.input_tokens != null) usage.inputTokens = u.input_tokens
  if (u.output_tokens != null) usage.outputTokens = u.output_tokens
  if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
  if (u.cache_creation_input_tokens != null) usage.cacheCreationTokens = u.cache_creation_input_tokens
}

export async function pipeAnthropicToOpenAISSE(res, write, model) {
  const id = 'chatcmpl-' + uuid()
  const created = Math.floor(Date.now() / 1000)
  const usage = newUsage()
  // 工具调用累积器：content_block index → { openaiIndex, started }
  const toolIndexByBlock = new Map()
  let nextToolIndex = 0
  const send = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`)
  send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  /**
   * 收尾必须**恰好一次**：正常、上游中断、上游 error 事件三条路径都汇到这里。
   * 用一个标志位防止"已发过 finish_reason 又补一帧"（客户端会看到两个结束帧）。
   */
  let finished = false
  const finish = (fr = 'stop') => {
    if (finished) return
    finished = true
    send({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: fr }],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        // OpenAI 用 prompt_tokens_details.cached_tokens 表达"命中缓存的输入"。
        // 上游给的是 Anthropic 口径的 cache_read_input_tokens，这里翻译过去，
        // 否则客户端看到的缓存命中永远是 0。
        prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
      },
    })
  }
  try {
    for await (const ev of sseEvents(res)) {
      if (ev.type === 'message_start' || ev.type === 'message_delta') {
        // 先吸收 usage 再收尾：message_delta 里才有真正的 input_tokens，
        // 顺序反了就会把 0 写进发给客户端的 usage 块。
        absorbUsage(usage, ev)
        if (ev.type === 'message_delta') finish(FINISH[ev.delta?.stop_reason] || 'stop')
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block
        if (cb?.type === 'tool_use') {
          const oaIndex = nextToolIndex++
          toolIndexByBlock.set(ev.index, oaIndex)
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: oaIndex, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] },
              finish_reason: null,
            }],
          })
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }] })
        } else if (ev.delta?.type === 'thinking_delta') {
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: ev.delta.thinking }, finish_reason: null }] })
        } else if (ev.delta?.type === 'input_json_delta') {
          // 无对应 content_block_start 的孤儿 delta（异常流）直接丢弃：
          // 归并到 index 0 会与真实的 0 号工具调用拼接参数、静默产出错误的调用，
          // 比丢帧更隐蔽。未知 index 的参数片段本就没有可归属的工具。
          const oaIndex = toolIndexByBlock.get(ev.index)
          if (oaIndex === undefined) continue
          send({
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: oaIndex, function: { arguments: ev.delta.partial_json ?? '' } }] },
              finish_reason: null,
            }],
          })
        }
      } else if (ev.type === 'error') {
        /**
         * 上游以 `error` 事件告错（如 overloaded_error）而不是断流：旧实现整支静默吞掉，
         * 客户端只看到"内容突然没了"，没有任何可定位信号。这里把它作为**可见的**错误
         * 内容发出去（保持 chunk 结构合法，客户端仍能按 OpenAI 语义消费），再由 finally 收尾。
         */
        const message = ev.error?.message ?? ev.error?.type ?? 'upstream stream error'
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: `\n[upstream error] ${message}\n` }, finish_reason: null }] })
        finish('stop')
      }
    }
  } finally {
    /**
     * 无论正常还是异常（reader reject / getReader 抛错）都在返回前补收尾。
     * 旧实现直接抛出：既不发 finish_reason 也不发 `[DONE]`，OpenAI SDK 会把半截流
     * 当作不完整响应（一直等 [DONE]）。`finish()` 内部幂等，故不会重复发送。
     */
    finish()
    write('data: [DONE]\n\n')
  }
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
  const usage = newUsage()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    write(value)
    state.buf += state.decoder.decode(value, { stream: true })
    const out = []
    drainEvents(state, out)
    for (const ev of out) absorbUsage(usage, ev)
  }
  if (state.buf.trim()) {
    state.buf += '\n'
    const out = []
    drainEvents(state, out)
    for (const ev of out) absorbUsage(usage, ev)
  }
  return usage
}

export async function tapAnthropicSSE(res, onEvent) {
  const usage = newUsage()
  for await (const ev of sseEvents(res)) {
    absorbUsage(usage, ev)
    onEvent(ev)
  }
  return usage
}
