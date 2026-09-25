import { describe, it, expect } from 'vitest'
import { buildZcodePlanSystem, buildContextPrefixBlock, attachContextPrefix, systemAssets } from '../src/upstream/system-prompt.js'
import { shapeZcodePlanBody, ZCODE_PLAN_MESSAGES_URL } from '../src/upstream/zcode-plan.js'

// 【关键回归】上游网关会对 system 字段做内容检查——看不到 ZCode 身份块就返回
// 3012 "method not allowed"。这是本项目最核心的可用性前提，必须锁住形态。
describe('buildZcodePlanSystem', () => {
  it('产出官方形态的三块，且每块带 cache_control', () => {
    const s = buildZcodePlanSystem({ currentModel: 'glm-5.3' })
    expect(s).toHaveLength(3)
    expect(s[0].text).toBe(systemAssets().cliPrefix)
    expect(s[0].text).toContain('You are ZCode')
    for (const b of s) expect(b.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('第三块以 \n\n 开头（官方动态段的固定形态）', () => {
    const s = buildZcodePlanSystem({ currentModel: 'glm-5.3' })
    expect(s[2].text.startsWith('\n\n')).toBe(true)
  })

  it('调用方原有的 system 追加在官方三块之后（不被丢弃）', () => {
    const s = buildZcodePlanSystem({ existingSystem: 'USER-SYSTEM', currentModel: 'glm-5.3' })
    expect(s).toHaveLength(4)
    expect(s[3]).toEqual({ type: 'text', text: 'USER-SYSTEM' })
  })

  it('Environment 段带真实 cwd 与模型名（避免与请求头矛盾）', () => {
    const s = buildZcodePlanSystem({ currentModel: 'glm-5.3', cwd: 'D:/proj' })
    expect(s[2].text).toContain('D:/proj')
    expect(s[2].text).toContain('glm-5.3')
  })
})

describe('attachContextPrefix / buildContextPrefixBlock', () => {
  it('首轮 user 消息前挂 system-reminder 的 currentDate', () => {
    const out = attachContextPrefix([{ role: 'user', content: 'hi' }], new Date('2026-09-25T10:00:00'))
    const blocks = out[0].content
    expect(blocks[0].text.startsWith('<system-reminder>')).toBe(true)
    expect(blocks[0].text).toContain('# currentDate')
    expect(blocks[0].text).toContain('2026-09-25')
    expect(blocks[1]).toEqual({ type: 'text', text: 'hi' })
  })

  it('已有前缀时不重复插入（幂等）', () => {
    const once = attachContextPrefix([{ role: 'user', content: 'hi' }])
    const twice = attachContextPrefix(once)
    expect(twice[0].content.filter((c) => c.text.startsWith('<system-reminder>'))).toHaveLength(1)
  })

  it('空消息或非 user 开头时原样返回', () => {
    expect(attachContextPrefix([])).toEqual([])
    const sys = [{ role: 'assistant', content: 'x' }]
    expect(attachContextPrefix(sys)).toBe(sys)
  })
})

describe('shapeZcodePlanBody', () => {
  it('模型名归一为小写（官方发小写）', () => {
    expect(shapeZcodePlanBody({ model: 'GLM-5.3-Flash', messages: [] }).model).toBe('glm-5.3-flash')
  })
  it('注入 system 与上下文前缀', () => {
    const b = shapeZcodePlanBody({ model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] })
    expect(b.system).toHaveLength(3)
    expect(b.messages[0].content[0].text).toContain('<system-reminder>')
  })
})

// 头集合按官方 CLI 抓包复刻（此前用错会导致上游拒绝）
describe('A 通道请求头形态', async () => {
  const { buildZcodePlanHeaders } = await import('../src/upstream/headers.js')
  it('UA 为 ai-sdk/anthropic（不是 provider-utils），且带 app-version / accept-encoding', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    expect(h['user-agent']).toMatch(/^ZCode\/[\d.]+ ai-sdk\/anthropic\//)
    expect(h['user-agent']).not.toContain('provider-utils')
    expect(h['x-zcode-app-version']).toBeTruthy()
    expect(h['accept-encoding']).toBe('gzip')
    expect(h['x-title']).toBe('Z Code@cli')
  })
  it('不带 x-query-id / x-session-id（仅 coding-plan 路径才带）', () => {
    const h = buildZcodePlanHeaders({ jwt: 'J', param: 'P', sessionId: 'S' })
    expect(h['x-query-id']).toBeUndefined()
    expect(h['x-session-id']).toBeUndefined()
  })
})
