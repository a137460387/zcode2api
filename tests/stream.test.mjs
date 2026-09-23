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
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 })
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
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4 })
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
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4 })
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
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 7 })
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
