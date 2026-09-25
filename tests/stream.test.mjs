import { describe, it, expect } from 'vitest'
import { pipeAnthropicToOpenAISSE, pipeRaw, pipeAnthropicSSEWithUsage, tapAnthropicSSE } from '../src/protocol/stream.js'

// 真实 Anthropic SSE 形状：每个事件以 `\n\n` 结尾（`event:` 行可选，解析只看 `data:` 行）。
// 用不规则字节切块喂入，避免"整帧一次到达"掩盖分帧缺陷。
function sseResponse(events, { chunkSize = 0 } = {}) {
  const enc = new TextEncoder()
  const raw = events.map((e) => `event: ${typeof e === 'string' ? 'x' : e.type}\ndata: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  const bytes = enc.encode(raw)
  const chunks = []
  if (chunkSize > 0) {
    for (let o = 0; o < bytes.length; o += chunkSize) chunks.push(bytes.slice(o, o + chunkSize))
  } else {
    chunks.push(bytes)
  }
  let i = 0
  return {
    body: {
      getReader() {
        return {
          read() {
            if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] })
            return Promise.resolve({ done: true })
          },
        }
      },
    },
  }
}

describe('pipeAnthropicToOpenAISSE', () => {
  it('converts anthropic SSE into openai chunks and returns usage', async () => {
    const upstream = sseResponse([
      {"type":"message_start","message":{"usage":{"input_tokens":10}}},
      {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"思考"}},
      {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}},
      {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}
    ])
    const written = []
    const usage = await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    expect(objs[0].choices[0].delta.role).toBe('assistant')
    expect(objs.some((o) => o.choices?.[0]?.delta?.reasoning_content === '思考')).toBe(true)
    expect(objs.some((o) => o.choices?.[0]?.delta?.content === '你好')).toBe(true)
    const last = objs[objs.length - 1]
    expect(last.choices[0].finish_reason).toBe('stop')
    expect(last.usage.total_tokens).toBe(15)
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n')
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('emits tool_calls deltas for a single tool call', async () => {
    const upstream = sseResponse([
      {"type":"message_start","message":{"usage":{"input_tokens":10}}},
      {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}},
      {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}},
      {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"北京\"}"}},
      {"type":"content_block_stop","index":0},
      {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    const toolChunks = objs.filter((o) => o.choices?.[0]?.delta?.tool_calls)
    // 首块携带 id/type/function.name 与 index 0
    const first = toolChunks[0].choices[0].delta.tool_calls[0]
    expect(first.index).toBe(0)
    expect(first.id).toBe('tu_1')
    expect(first.type).toBe('function')
    expect(first.function.name).toBe('get_weather')
    // 参数以字符串增量片段出现，拼接后可解析为完整对象
    const args = toolChunks
      .map((o) => o.choices[0].delta.tool_calls[0].function?.arguments)
      .filter((s) => s != null)
      .join('')
    expect(JSON.parse(args)).toEqual({ city: '北京' })
    const last = objs[objs.length - 1]
    expect(last.choices[0].finish_reason).toBe('tool_calls')
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n')
  })

  it('increments tool_call index for multiple tool calls', async () => {
    const upstream = sseResponse([
      {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_a","name":"f"}},
      {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}},
      {"type":"content_block_stop","index":0},
      {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_b","name":"g"}},
      {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"b\":2}"}},
      {"type":"content_block_stop","index":1},
      {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    const starts = objs.filter((o) => o.choices?.[0]?.delta?.tool_calls?.[0]?.id)
    expect(starts.map((o) => o.choices[0].delta.tool_calls[0].index)).toEqual([0, 1])
    expect(starts.map((o) => o.choices[0].delta.tool_calls[0].id)).toEqual(['tu_a', 'tu_b'])
    expect(starts.map((o) => o.choices[0].delta.tool_calls[0].function.name)).toEqual(['f', 'g'])
    expect(objs[objs.length - 1].choices[0].finish_reason).toBe('tool_calls')
  })

  it('emits thinking, text and tool_calls together', async () => {
    const upstream = sseResponse([
      {"type":"message_start","message":{"usage":{"input_tokens":4}}},
      {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}},
      {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"查"}},
      {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}},
      {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"北京\"}"}},
      {"type":"content_block_stop","index":2},
      {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    expect(objs.some((o) => o.choices?.[0]?.delta?.reasoning_content === '想')).toBe(true)
    expect(objs.some((o) => o.choices?.[0]?.delta?.content === '查')).toBe(true)
    const args = objs
      .filter((o) => o.choices?.[0]?.delta?.tool_calls)
      .map((o) => o.choices[0].delta.tool_calls[0].function?.arguments)
      .filter((s) => s != null)
      .join('')
    expect(JSON.parse(args)).toEqual({ city: '北京' })
    const last = objs[objs.length - 1]
    expect(last.choices[0].finish_reason).toBe('tool_calls')
    expect(last.usage.total_tokens).toBe(10)
  })
})

describe('pipeAnthropicToOpenAISSE 收尾健壮性', () => {
  // 上游中途中断（reader reject）时旧实现直接抛出：既不发 finish_reason 帧也不发 [DONE]。
  // OpenAI SDK 会把半截流当作不完整响应（客户端一直等 [DONE] 或报"流意外结束"）。
  // 无论正常还是异常，返回前都必须补上 finish_reason 与 data: [DONE]。
  const rejectingResponse = (prefixEvents, err = new Error('upstream stream reset')) => {
    const enc = new TextEncoder()
    const bytes = enc.encode(prefixEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))
    let sent = false
    return {
      body: {
        getReader: () => ({
          read: async () => {
            if (!sent) { sent = true; return { done: false, value: bytes } }
            throw err
          },
        }),
      },
    }
  }

  it('上游 reader 中途 reject：仍以 finish_reason + [DONE] 收尾', async () => {
    const upstream = rejectingResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } },
    ])
    const written = []
    // 允许抛（调用方 server.js 已有 finally 兜底 end()），但收尾帧必须已在异常前写出
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3').catch(() => {})
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    const last = objs[objs.length - 1]
    expect(last.choices[0].finish_reason).toBe('stop')
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n')
  })

  it('正常结束但没有 message_delta：仍补 finish_reason 与 [DONE]', async () => {
    const upstream = sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const objs = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    expect(objs[objs.length - 1].choices[0].finish_reason).toBe('stop')
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n')
  })

  it('已发过 finish_reason 时不重复补发', async () => {
    const upstream = sseResponse([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3')
    const finishes = written
      .filter((s) => s !== 'data: [DONE]\n\n')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
      .filter((o) => o.choices?.[0]?.finish_reason)
    expect(finishes.length).toBe(1)
    expect(written.filter((s) => s === 'data: [DONE]\n\n').length).toBe(1)
  })

  it('上游 error 事件不能被静默吞掉', async () => {
    const upstream = sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ])
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3').catch(() => {})
    const joined = written.join('')
    expect(joined).toContain('Overloaded') // 错误信息必须可见，不能静默丢弃
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n') // 并且流要正常收尾
  })

  it('读流前就失败（getReader 抛错）也必须保证 [DONE] 收尾', async () => {
    const upstream = { body: { getReader() { throw new Error('no body') } } }
    const written = []
    await pipeAnthropicToOpenAISSE(upstream, (s) => written.push(s), 'glm-5.3').catch(() => {})
    expect(written[written.length - 1]).toBe('data: [DONE]\n\n')
  })
})

describe('pipeRaw', () => {
  it('forwards bytes untouched', async () => {
    const upstream = sseResponse([{ type: 'message_start' }])
    const written = []
    await pipeRaw(upstream, (b) => written.push(Buffer.from(b).toString()))
    expect(written.join('')).toContain('message_start')
  })
})

describe('pipeAnthropicSSEWithUsage', () => {
  it('passes bytes through untouched and extracts usage', async () => {
    const upstream = sseResponse([
      {"type":"message_start","message":{"usage":{"input_tokens":3}}},
      {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}},
      {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}
    ])
    const written = []
    const usage = await pipeAnthropicSSEWithUsage(upstream, (b) => written.push(Buffer.from(b).toString()))
    expect(written.join('')).toContain('text_delta')
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })
})

describe('tapAnthropicSSE', () => {
  it('calls onEvent per parsed event', async () => {
    const upstream = sseResponse([
      {"type":"message_start","message":{"usage":{"input_tokens":3}}},
      {"type":"message_delta","delta":{},"usage":{"output_tokens":4}}
    ])
    const seen = []
    const usage = await tapAnthropicSSE(upstream, (ev) => seen.push(ev))
    expect(seen.length).toBe(2)
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })
})

// 分帧健壮性：真实 Anthropic 报文 + 不规则网络切块。
// 早期夹具是"无换行的粘连行"，那种形状掩盖了真实分帧行为，且诱导实现加入
// 会吞掉半帧的启发式切分。这里用真实形状（每帧 `\n\n` 结尾）覆盖多种切块粒度。
describe('SSE 分帧健壮性（真实报文 × 不规则切块）', () => {
  const EVENTS = [
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考中' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好世界' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"北京"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  ]

  const parse = async (chunkSize) => {
    const written = []
    const usage = await pipeAnthropicToOpenAISSE(sseResponse(EVENTS, { chunkSize }), (s) => written.push(s), 'glm-5.3')
    const objs = written.filter((s) => s !== 'data: [DONE]\n\n').map((s) => JSON.parse(s.replace(/^data: /, '').trim()))
    return { objs, usage }
  }

  // 比较时剔除每次调用都不同的 id（chatcmpl-<uuid>）与 created（时间戳），
  // 只比较与切块相关的结构：delta 序列、finish_reason、usage。
  const normalize = (objs) => objs.map(({ id, created, ...rest }) => rest)

  it('任意切块粒度下产出等价（不被网络边界影响）', async () => {
    const base = await parse(0) // 整块一次到达
    for (const cs of [1, 3, 7, 64]) {
      const { objs, usage } = await parse(cs)
      expect(normalize(objs)).toEqual(normalize(base.objs))
      expect(usage).toEqual(base.usage)
    }
    // 内容正确性（非仅"两次一致"）
    const { objs, usage } = await parse(3)
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 })
    expect(objs.some((o) => o.choices?.[0]?.delta?.reasoning_content === '思考中')).toBe(true)
    expect(objs.some((o) => o.choices?.[0]?.delta?.content === '你好世界')).toBe(true)
    const args = objs.filter((o) => o.choices?.[0]?.delta?.tool_calls)
      .map((o) => o.choices[0].delta.tool_calls[0].function?.arguments).filter((x) => x != null).join('')
    expect(JSON.parse(args)).toEqual({ city: '北京' })
    expect(objs[objs.length - 1].choices[0].finish_reason).toBe('tool_calls')
  })

  it('透传字节与原文完全一致（含跨 chunk 的多字节汉字）', async () => {
    const enc = new TextEncoder()
    const expected = enc.encode(EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
    const raw = []
    await pipeAnthropicSSEWithUsage(sseResponse(EVENTS, { chunkSize: 2 }), (b) => raw.push(b))
    const got = Buffer.concat(raw.map((b) => Buffer.from(b)))
    expect(Buffer.compare(got, Buffer.from(expected))).toBe(0)
  })

  it('事件数不因切块而丢失（每帧都被解析）', async () => {
    const seen = []
    await tapAnthropicSSE(sseResponse(EVENTS, { chunkSize: 1 }), (ev) => seen.push(ev))
    expect(seen.length).toBe(EVENTS.length)
  })
})

/**
 * 真实上游的流式 usage 形状（抓包实测）：
 *   message_start: {"input_tokens":0,"output_tokens":0}
 *   message_delta: {"input_tokens":1703,"output_tokens":3,"cache_read_input_tokens":0,...}
 *
 * **输入 token 只在最后那帧 message_delta 里才有**。旧实现只读 message_start，
 * 于是每个流式请求都被记成 0 输入 token——面板用量少算一大截，且发给 OpenAI 客户端的
 * usage 块里 prompt_tokens 恒为 0（对外可见的错误数据）。本组用例锁住这个契约。
 */
describe('真实上游流式 usage：输入 token 在 message_delta 里', () => {
  const realFrames = () => [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1703,"output_tokens":3,"cache_read_input_tokens":120,"cache_creation_input_tokens":7}}\n\n',
  ]

  it('OpenAI 通道：解析器带回真实的 inputTokens 与缓存字段', async () => {
    const out = []
    const usage = await pipeAnthropicToOpenAISSE(sseResponse(realFrames()), (s) => out.push(s), 'glm-5.3')
    expect(usage).toEqual({ inputTokens: 1703, outputTokens: 3, cacheReadTokens: 120, cacheCreationTokens: 7 })
  })

  it('OpenAI 通道：发给客户端的 usage 块里 prompt_tokens 不再是 0，且带 cached_tokens', async () => {
    const out = []
    await pipeAnthropicToOpenAISSE(sseResponse(realFrames()), (s) => out.push(s), 'glm-5.3')
    const frames = out.join('').split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(5)))
    const withUsage = frames.find((f) => f.usage)
    expect(withUsage.usage.prompt_tokens).toBe(1703)
    expect(withUsage.usage.completion_tokens).toBe(3)
    expect(withUsage.usage.total_tokens).toBe(1706)
    expect(withUsage.usage.prompt_tokens_details.cached_tokens).toBe(120)
  })

  it('Anthropic 通道：透传解析器同样拿到真实 inputTokens', async () => {
    const usage = await pipeAnthropicSSEWithUsage(sseResponse(realFrames()), () => {})
    expect(usage.inputTokens).toBe(1703)
    expect(usage.cacheReadTokens).toBe(120)
  })

  it('message_start 有值、message_delta 也有值时以后者为准（更晚更准）', async () => {
    const usage = await pipeAnthropicSSEWithUsage(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 99, output_tokens: 2 } },
    ]), () => {})
    expect(usage.inputTokens).toBe(99)
  })

  it('message_delta 不带 input_tokens 时保留 message_start 的值', async () => {
    const usage = await pipeAnthropicSSEWithUsage(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 42 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]), () => {})
    expect(usage.inputTokens).toBe(42)
    expect(usage.outputTokens).toBe(2)
  })
})
