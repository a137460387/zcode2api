const ZCODE_PLAN_MAP = {
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3-Flash',
  glm_5p3: 'GLM-5.3',
  glm_5p3f: 'GLM-5.3-Flash',
}

export function mapToZcodePlan(name) {
  if (!name) return 'GLM-5.3'
  const key = String(name).toLowerCase()
  if (key.startsWith('claude-')) return 'GLM-5.3-Flash'
  return ZCODE_PLAN_MAP[key] || name
}

export function mapToBigModel(name) {
  if (!name) return 'glm-5.3-flash'
  const key = String(name).toLowerCase()
  if (key.startsWith('claude-')) return 'glm-5.3-flash'
  return key
}

export function publicModelIds() {
  return ['glm-5.3', 'glm-5.3-flash']
}
