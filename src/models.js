// A 通道（zcode.z.ai）模型名大小写敏感，别名表 key 统一用大写，
// 查表用 key.toUpperCase()：未命中即原样透传输入，不会被折叠到别名上。
const ZCODE_PLAN_MAP = {
  'GLM-5.3': 'GLM-5.3',
  'GLM-5.3-FLASH': 'GLM-5.3-Flash',
  GLM_5P3: 'GLM-5.3',
  GLM_5P3F: 'GLM-5.3-Flash',
}

export function mapToZcodePlan(name) {
  if (!name) return 'GLM-5.3'
  const key = String(name).trim()
  if (!key) return 'GLM-5.3'
  const upper = key.toUpperCase()
  if (upper.startsWith('CLAUDE-')) return 'GLM-5.3-Flash'
  return ZCODE_PLAN_MAP[upper] || key
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
