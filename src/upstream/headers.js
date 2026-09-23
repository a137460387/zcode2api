import crypto from 'node:crypto'

const uuid = () => crypto.randomUUID()

export function buildZcodePlanHeaders({ jwt, param, sessionId }) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${jwt}`,
    'x-api-key': jwt,
    'anthropic-version': '2023-06-01',
    'user-agent': 'ZCode/3.11.2 ai-sdk/provider-utils/4.0.27 runtime/node.js/24',
    'http-referer': 'https://zcode.z.ai',
    'x-aliyun-captcha-verify-param': param,
    'x-aliyun-captcha-verify-region': 'cn',
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Asia/Shanghai',
    'x-os-category': 'windows',
    'x-os-version': '10.0.26200',
    'x-platform': 'win32-x64',
    'x-release-channel': 'production',
    'x-title': 'Z Code@electron',
    'x-request-id': uuid(),
    'x-query-id': uuid(),
    'x-session-id': sessionId,
    'x-zcode-trace-id': uuid(),
    'x-zcode-agent': 'glm',
    'x-zcode-session-type': 'main',
  }
}

export function buildBigModelHeaders({ apiKey }) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'user-agent': 'zcode2api/0.1.0',
  }
}

export function buildBalanceHeaders({ jwt }) {
  return { authorization: jwt, 'x-device-mid': uuid() }
}
