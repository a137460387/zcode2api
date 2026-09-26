import { describe, it, expect } from 'vitest'
import { openaiToAnthropic, anthropicToOpenAI } from '../src/protocol/convert.js'

describe('openaiToAnthropic', () => {
  it('maps system/developer to system blocks and alternates roles', async () => {
    const out = await openaiToAnthropic({
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
      max_tokens: 100,
    }, (m) => 'GLM-5.3')
    expect(out.system).toEqual([{ type: 'text', text: 'sys' }])
    expect(out.messages).toHaveLength(3)
    expect(out.model).toBe('GLM-5.3')
    expect(out.max_tokens).toBe(100)
    expect(out.stream).toBe(false)
  })

  it('merges consecutive same-role messages and keeps user first', async () => {
    const out = await openaiToAnthropic({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    }, (m) => m)
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0].content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
    expect(out.messages[0].role).toBe('user')
  })

  it('converts tool definitions and tool messages', async () => {
    const out = await openaiToAnthropic({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } }],
    }, (m) => m)
    expect(out.tools).toEqual([{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: {} } }])
    const asst = out.messages[1]
    expect(asst.role).toBe('assistant')
    expect(asst.content).toEqual([{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '北京' } }])
    const toolMsg = out.messages[2]
    expect(toolMsg.content[0].type).toBe('tool_result')
    expect(toolMsg.content[0].tool_use_id).toBe('t1')
  })

  it('maps reasoning_effort to output_config.effort', async () => {
    const out = await openaiToAnthropic({ messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'high' }, (m) => m)
    expect(out.output_config).toEqual({ effort: 'high' })
  })

  it('ensures non-empty first user message', async () => {
    const out = await openaiToAnthropic({ messages: [] }, (m) => m)
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }] }])
  })
})

describe('anthropicToOpenAI', () => {
  it('converts content, stop reason and usage', () => {
    const out = anthropicToOpenAI({
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: '答案' },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    }, 'glm-5.3')
    expect(out.object).toBe('chat.completion')
    expect(out.model).toBe('glm-5.3')
    expect(out.choices[0].message.content).toBe('答案')
    expect(out.choices[0].message.reasoning_content).toBe('hmm')
    expect(out.choices[0].finish_reason).toBe('stop')
    expect(out.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  })

  it('maps a single tool_use block to openai tool_calls', () => {
    const out = anthropicToOpenAI({
      id: 'msg_2',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: '北京' } },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    }, 'glm-5.3')
    const msg = out.choices[0].message
    expect(out.choices[0].finish_reason).toBe('tool_calls')
    expect(msg.content).toBeNull()
    expect(Array.isArray(msg.tool_calls)).toBe(true)
    expect(msg.tool_calls).toHaveLength(1)
    const tc = msg.tool_calls[0]
    expect(tc.id).toBe('tu_1')
    expect(tc.type).toBe('function')
    expect(tc.function.name).toBe('get_weather')
    expect(typeof tc.function.arguments).toBe('string')
    expect(JSON.parse(tc.function.arguments)).toEqual({ city: '北京' })
  })

  it('maps multiple tool_use blocks in order', () => {
    const out = anthropicToOpenAI({
      id: 'msg_3',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '先查两个城市' },
        { type: 'tool_use', id: 'tu_a', name: 'get_weather', input: { city: '北京' } },
        { type: 'tool_use', id: 'tu_b', name: 'get_weather', input: { city: '上海' } },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    }, 'glm-5.3')
    const msg = out.choices[0].message
    expect(out.choices[0].finish_reason).toBe('tool_calls')
    expect(msg.content).toBe('先查两个城市')
    expect(msg.tool_calls).toHaveLength(2)
    expect(msg.tool_calls.map((t) => t.id)).toEqual(['tu_a', 'tu_b'])
    expect(msg.tool_calls.map((t) => t.function.name)).toEqual(['get_weather', 'get_weather'])
    expect(msg.tool_calls.map((t) => JSON.parse(t.function.arguments))).toEqual([{ city: '北京' }, { city: '上海' }])
  })

  it('serializes missing tool input as an empty json object string', () => {
    const out = anthropicToOpenAI({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_x', name: 'ping' }],
    }, 'glm-5.3')
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{}')
  })

  it('omits tool_calls for pure text responses', () => {
    const out = anthropicToOpenAI({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
    }, 'glm-5.3')
    expect(out.choices[0].message.tool_calls).toBeUndefined()
    expect(out.choices[0].message.content).toBe('hi')
    expect(out.choices[0].finish_reason).toBe('stop')
  })
})

// 图片输入：上游目录里只有 GLM-5.3-Flash 带 vision。OpenAI 形态的 image_url 必须转成
// Anthropic base64 块透传（静默丢弃会让模型基于纯文本"自信作答"——比报错更糟）；
// 非视觉模型的带图请求在本地拒绝，不白烧 captcha 参数。
describe('openaiToAnthropic 图片输入', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('data URL 转 Anthropic base64 图片块', async () => {
    const out = await openaiToAnthropic({
      model: 'glm-5.3-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        ],
      }],
    }, (m) => m)
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    ])
  })

  it('http(s) 图片 URL 抓取后转 base64（媒体类型取自 content-type）', async () => {
    const fetchImpl = async () => new Response(Buffer.from(PNG_B64, 'base64'), { headers: { 'content-type': 'image/jpeg' } })
    const out = await openaiToAnthropic({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] }],
    }, (m) => m, { fetchImpl })
    expect(out.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 },
    })
  })

  it('远程图片下载失败时显式报错（不静默丢弃）', async () => {
    await expect(openaiToAnthropic({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] }],
    }, (m) => m, { fetchImpl: async () => new Response('nope', { status: 404 }) })).rejects.toThrow(/图片下载失败/)
  })

  it('非视觉模型（映射为 GLM-5.3）的带图请求被本地拒绝', async () => {
    await expect(openaiToAnthropic({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }],
    }, (m) => 'GLM-5.3')).rejects.toThrow(/不支持图片输入/)
  })

  it('视觉模型（映射为 GLM-5.3-Flash）的带图请求放行', async () => {
    const out = await openaiToAnthropic({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] }],
    }, (m) => 'GLM-5.3-Flash')
    expect(out.messages[0].content[0].type).toBe('image')
  })

  it('超过 5MB 上限的图片被拒绝', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024).toString('base64')
    await expect(openaiToAnthropic({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }] }],
    }, (m) => m)).rejects.toThrow(/5MB 上限/)
  })

  it('白名单之外的媒体类型（svg）被拒绝', async () => {
    await expect(openaiToAnthropic({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }] }],
    }, (m) => m)).rejects.toThrow(/不支持的图片类型/)
  })

  it('音频块仍被显式拒绝', async () => {
    await expect(openaiToAnthropic({
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }],
    }, (m) => m)).rejects.toThrow(/unsupported content type/)
  })
})
