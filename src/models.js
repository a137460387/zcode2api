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

/**
 * 客户端可写的**别名**（不是模型，只是"写这个名字也能用"的入口）。
 *
 * 单独列出来是因为面板一度把别名和正式模型混在同一张"模型清单"里，于是只有 2 个模型的
 * 产品看起来像有 3 个（用户当场就问"不是只有两个模型吗"）。别名与模型是两类东西：
 * 模型决定发到上游哪个 id，别名只决定"客户端可以怎么称呼它"。
 */
const ALIASES = [
  { pattern: 'claude-*', mapsTo: 'glm-5.3-flash', note: 'Claude Code / Claude SDK 发来的模型名' },
  { pattern: 'GLM_5P3', mapsTo: 'glm-5.3', note: '下划线写法' },
  { pattern: 'GLM_5P3F', mapsTo: 'glm-5.3-flash', note: '下划线写法' },
]

/**
 * 模型目录：面板与文档**唯一**的事实来源。
 *
 * 为什么不把模型表写在前端：面板原来把三行硬编码在 HTML 里，`claude-*` 被当成模型列出来，
 * 既误导用户又与 `mapToZcodePlan` 各说各话——服务端改了映射，面板不会跟着变。
 * 现在由服务端给出目录，并有测试断言每个别名**真的**映射到它声称的那个模型。
 */
export function modelCatalog() {
  return {
    models: publicModelIds().map((id) => ({
      id,
      // 大写形式是上游要求的（A 通道模型名大小写敏感）
      upstream: mapToZcodePlan(id),
      channel: 'oauth',
      needsCaptcha: true,
    })),
    aliases: ALIASES.map((a) => ({ ...a })),
    // 模型名大小写不敏感（查表前统一 toUpperCase），面板要告诉用户这一点
    caseInsensitive: true,
  }
}

// 别名表的结构契约：查表前会对输入做 toUpperCase()，所以每个 key 必须已经是
// 大写形式，否则该别名永远无法命中。测试用它与 mapToZcodePlan 做穷举对拍。
export function zcodePlanAliasKeys() {
  return Object.keys(ZCODE_PLAN_MAP)
}

/** 供测试对拍：别名目录里每一条声称的映射，必须与真实映射一致。 */
export function aliasPatterns() {
  return ALIASES.map((a) => ({ ...a }))
}
