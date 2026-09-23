import { buildBigModelHeaders } from './headers.js'

export const BIGMODEL_MESSAGES_URL = 'https://open.bigmodel.cn/api/anthropic/v1/messages'

export async function sendBigModel({ apiKey, body, fetchImpl = fetch }) {
  return fetchImpl(BIGMODEL_MESSAGES_URL, {
    method: 'POST',
    headers: buildBigModelHeaders({ apiKey }),
    body: JSON.stringify(body),
  })
}
