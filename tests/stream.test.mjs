import { describe, it, expect } from 'vitest'
import { pipeAnthropicToOpenAISSE, pipeRaw, pipeAnthropicSSEWithUsage, tapAnthropicSSE } from '../src/protocol/stream.js'

function sseResponse(lines) {
  const enc = new TextEncoder()
  let i = 0
  return {
    body: {
      getReader() {
        return {
          read() {
            if (i < lines.length) return Promise.resolve({ done: false, value: enc.encode(lines[i++]) })
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
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"思考"}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      '',
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
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"北京\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '',
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
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_a","name":"f"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_b","name":"g"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"b\\":2}"}}',
      '',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '',
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
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"查"}}',
      '',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}',
      '',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北京\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":2}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}',
      '',
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
    const upstream = sseResponse(['data: {"type":"message_start"}', ''])
    const written = []
    await pipeRaw(upstream, (b) => written.push(Buffer.from(b).toString()))
    expect(written.join('')).toContain('message_start')
  })
})

describe('pipeAnthropicSSEWithUsage', () => {
  it('passes bytes through untouched and extracts usage', async () => {
    const upstream = sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
      '',
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
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      '',
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":4}}',
      '',
    ])
    const seen = []
    const usage = await tapAnthropicSSE(upstream, (ev) => seen.push(ev))
    expect(seen.length).toBe(2)
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4 })
  })
})
