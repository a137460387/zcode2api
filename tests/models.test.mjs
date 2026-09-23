import { describe, it, expect } from 'vitest'
import { mapToZcodePlan, mapToBigModel, publicModelIds } from '../src/models.js'

describe('mapToZcodePlan', () => {
  it('maps known aliases case-insensitively', () => {
    expect(mapToZcodePlan('glm-5.3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('GLM-5.3')).toBe('GLM-5.3')
    expect(mapToZcodePlan('glm-5.3-flash')).toBe('GLM-5.3-Flash')
    expect(mapToZcodePlan('glm_5p3f')).toBe('GLM-5.3-Flash')
  })
  it('maps claude-* aliases to GLM-5.3-Flash', () => {
    expect(mapToZcodePlan('claude-sonnet-4-5')).toBe('GLM-5.3-Flash')
  })
  it('passes through unknown names untouched (case-sensitive upstream)', () => {
    expect(mapToZcodePlan('GLM-5.2')).toBe('GLM-5.2')
  })
  it('defaults empty to GLM-5.3', () => {
    expect(mapToZcodePlan(undefined)).toBe('GLM-5.3')
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
