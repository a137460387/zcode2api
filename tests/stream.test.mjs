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
