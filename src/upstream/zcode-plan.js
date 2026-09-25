import { buildZcodePlanHeaders } from './headers.js'
import { buildZcodePlanSystem, attachContextPrefix } from './system-prompt.js'

export const ZCODE_PLAN_MESSAGES_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'

/**
 * 按官方客户端形态补齐请求体。
 *
 * **必须做的两件事**（缺任一个都会被上游 3012 拒绝，详见 system-prompt.js）：
 * 1. `system` 字段注入 ZCode 身份块（调用方原有的 system 追加在其后）
 * 2. 首轮 user 消息前挂 `<system-reminder>…# currentDate…</system-reminder>`
 *
 * 另：官方客户端发的是**小写模型名**（`glm-5.3`），此处按官方形态归一。
 */
export function shapeZcodePlanBody(body, { cwd, provider = 'bigmodel' } = {}) {
  const model = typeof body.model === 'string' ? body.model.toLowerCase() : body.model
  return {
    ...body,
    model,
    system: buildZcodePlanSystem({ existingSystem: body.system, currentModel: model, provider, cwd }),
    messages: attachContextPrefix(body.messages),
  }
}

export async function sendZcodePlan({ jwt, param, body, sessionId, fetchImpl = fetch, cwd, provider = 'bigmodel' }) {
  const shaped = shapeZcodePlanBody(body, { cwd, provider })
  return fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
    method: 'POST',
    headers: buildZcodePlanHeaders({ jwt, param, sessionId }),
    body: JSON.stringify(shaped),
  })
}
