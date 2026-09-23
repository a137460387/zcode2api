import { describe, it, expect } from 'vitest'
import { mapToZcodePlan, mapToBigModel, publicModelIds } from '../src/models.js'

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
