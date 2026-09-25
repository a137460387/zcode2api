import { describe, it, expect } from 'vitest'
import { mapToZcodePlan, mapToBigModel, publicModelIds, zcodePlanAliasKeys , modelCatalog, aliasPatterns } from '../src/models.js'

describe('mapToZcodePlan', () => {
  it('maps known aliases case-insensitively', () => {
    expect(mapToZcodePlan('glm-5.3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('GLM-5.3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('glm-5.3-flash')).toBe('GLM-5.3-Flash')
    expect(mapToZcodePlan('glm_5p3f')).toBe('GLM-5.3-Flash')
  })
  it('maps underscore aliases case-insensitively', () => {
    expect(mapToZcodePlan('glm_5p3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('GLM_5P3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('glm_5p3f')).toBe('GLM-5.3-Flash')
    expect(mapToZcodePlan('GLM_5P3F')).toBe('GLM-5.3-Flash')
    expect(mapToZcodePlan('Glm_5p3f')).toBe('GLM-5.3-Flash')
  })
  it('maps claude-* aliases to GLM-5.3-Flash', () => {
    expect(mapToZcodePlan('claude-sonnet-4-5')).toBe('GLM-5.3-Flash')
  })
  it('passes through unknown names untouched (case-sensitive upstream)', () => {
    expect(mapToZcodePlan('GLM-5.2')).toBe('GLM-5.2')
    expect(mapToZcodePlan('GLM-5.2')).not.toBe('GLM-5.3')
    expect(mapToZcodePlan('claude')).toBe('claude')
    expect(mapToZcodePlan('GLM-4.6-Air')).toBe('GLM-4.6-Air')
    expect(mapToZcodePlan('gpt-4o')).toBe('gpt-4o')
  })
  it('never rewrites an upstream-native name via a lowercase alias key', () => {
    // 别名表的 key 若是小写，查表前的 toLowerCase() 会把上游原生大小写名折叠到
    // 表内 key 上，导致未命中透传被静默改写成别的模型。这两个名字不在别名表内
    // （表内只有 glm-5.3 / glm-5.3-flash / glm_5p3 / glm_5p3f），必须原样透传。
    expect(mapToZcodePlan('GLM_5P3-Flash')).toBe('GLM_5P3-Flash')
    expect(mapToZcodePlan('GLM_5P3_plus')).toBe('GLM_5P3_plus')
    expect(mapToZcodePlan('glm_5p3X')).toBe('glm_5p3X')
  })
  it('keeps the alias table keys uppercase (structural contract)', () => {
    // 查表走 toUpperCase()，key 若含小写字母就永远命中不了，别名会静默失效。
    for (const k of zcodePlanAliasKeys()) {
      expect(k).toBe(k.toUpperCase())
    }
  })
  it('exhaustively passes through names that fold onto an alias without being one', () => {
    // 对拍：任何"大小写折叠后等于某个 key、但本身不是该 key 精确形式"的输入，
    // 只要它不在别名表里，就必须原样透传。这条断言能真正驱动红阶段
    // —— 若改回 toLowerCase() 查表，下面的探针会被折叠到别名上而失败。
    const aliasKeys = zcodePlanAliasKeys()
    for (const key of aliasKeys) {
      for (const probe of [key + '-EXTRA', key + '_X', key.replace('-', '_'), key + 'X']) {
        const folded = probe.toUpperCase()
        if (aliasKeys.includes(folded)) continue // 与某个别名精确同名，属合法别名
        expect(mapToZcodePlan(probe)).toBe(probe)
      }
    }
  })
  it('trims surrounding whitespace before matching', () => {
    expect(mapToZcodePlan('  glm-5.3  ')).toBe('GLM-5.3')
    expect(mapToZcodePlan('\tGLM-5.2\n')).toBe('GLM-5.2')
    expect(mapToZcodePlan('   ')).toBe('GLM-5.3')
    expect(mapToZcodePlan('  claude-sonnet-4-5 ')).toBe('GLM-5.3-Flash')
  })
  it('defaults empty to GLM-5.3', () => {
    expect(mapToZcodePlan(undefined)).toBe('GLM-5.3')
    expect(mapToZcodePlan(null)).toBe('GLM-5.3')
    expect(mapToZcodePlan('')).toBe('GLM-5.3')
  })
})

describe('mapToBigModel', () => {
  it('lowercases and maps claude aliases', () => {
    expect(mapToBigModel('GLM-5.3-Flash')).toBe('glm-5.3-flash')
    expect(mapToBigModel('claude-opus-4-7')).toBe('glm-5.3-flash')
  })
})

describe('publicModelIds', () => {
  it('lists the two public ids', () => {
    expect(publicModelIds()).toEqual(['glm-5.3', 'glm-5.3-flash'])
  })
})

/**
 * 模型目录：面板与文档的**唯一事实来源**。
 *
 * 前端硬编码那次把别名 `claude-*` 和两个正式模型混排在同一张"模型清单"里，
 * 于是只有 2 个模型的产品看起来像 3 个（用户当场就问"不是只有两个模型吗"）。
 */
describe('modelCatalog', () => {
  it('模型只有 2 个（这是事实，面板的数量不能比它多）', () => {
    const c = modelCatalog()
    expect(c.models.map((m) => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
    expect(c.models).toHaveLength(2)
  })

  it('别名单列，且与模型分开（别名不是模型）', () => {
    const c = modelCatalog()
    const ids = c.models.map((m) => m.id)
    for (const a of c.aliases) {
      expect(ids).not.toContain(a.pattern)   // 别名不得混进模型列表
      expect(a.mapsTo).toBeTruthy()
    }
  })

  // 这条是把"目录"钉在**真实映射**上：目录里声称 claude-* → glm-5.3-flash，
  // 那 mapToZcodePlan 就必须真的这么映射。否则面板写一套、实际跑另一套。
  it('每条别名声称的映射与实际 mapToZcodePlan 一致', () => {
    for (const a of aliasPatterns()) {
      const probe = a.pattern.endsWith('*')
        ? a.pattern.slice(0, -1) + 'sonnet-4-5-20250929'
        : a.pattern
      expect(mapToZcodePlan(probe)).toBe(mapToZcodePlan(a.mapsTo))
    }
  })

  it('每个模型的 upstream 是上游要求的大小写形式', () => {
    for (const m of modelCatalog().models) {
      expect(mapToZcodePlan(m.id)).toBe(m.upstream)
    }
  })

  it('声明大小写不敏感，且确实如此', () => {
    const c = modelCatalog()
    expect(c.caseInsensitive).toBe(true)
    for (const m of c.models) {
      expect(mapToZcodePlan(m.id.toUpperCase())).toBe(m.upstream)
    }
  })
})
