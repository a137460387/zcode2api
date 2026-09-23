import { buildZcodePlanHeaders } from './headers.js'

export const ZCODE_PLAN_MESSAGES_URL = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'

export async function sendZcodePlan({ jwt, param, body, sessionId, fetchImpl = fetch }) {
  return fetchImpl(ZCODE_PLAN_MESSAGES_URL, {
    method: 'POST',
    headers: buildZcodePlanHeaders({ jwt, param, sessionId }),
    body: JSON.stringify(body),
  })
}
