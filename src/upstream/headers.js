import crypto from 'node:crypto'

const uuid = () => crypto.randomUUID()

/**
 * A 通道（caption 通道）请求头——按**官方 CLI 客户端的真实请求**复刻。
 *
 * 几处关键点（此前用错会导致上游 3012 / 3007，均已按抓包实测修正）：
 * - `user-agent` 的 SDK 段是 `ai-sdk/anthropic/3.0.81`，**不是**
 *   `ai-sdk/provider-utils/... runtime/node.js/...`（后者是引擎内部标识，会露馅）
 * - `x-title` 是 `Z Code@cli`（CLI 形态），`@electron` 是桌面形态
 * - **必须**带 `x-zcode-app-version`
 * - `accept-encoding: gzip`（官方固定带）
 * - **不带** `x-query-id` / `x-session-id`（仅 coding-plan 路径才带）
 */
export function buildZcodePlanHeaders({ jwt, param, sessionId, appVersion = '3.14.3', clientTitle = 'cli' }) {
  return {
    'accept-encoding': 'gzip',
    'anthropic-version': '2023-06-01',
    authorization: `Bearer ${jwt}`,
    'content-type': 'application/json',
    'http-referer': 'https://zcode.z.ai',
    'user-agent': `ZCode/${appVersion} ai-sdk/anthropic/3.0.81`,
    'x-aliyun-captcha-verify-param': param,
    'x-aliyun-captcha-verify-region': 'cn',
    'x-api-key': jwt,
    'x-client-language': 'zh-CN',
    'x-client-timezone': 'Asia/Shanghai',
    'x-os-category': 'windows',
    'x-os-version': '10.0.26200',
    'x-platform': 'win32-x64',
    'x-release-channel': 'production',
    'x-request-id': uuid(),
    'x-title': `Z Code@${clientTitle}`,
    'x-zcode-agent': 'glm',
    'x-zcode-app-version': appVersion,
    'x-zcode-session-type': 'main',
    'x-zcode-trace-id': uuid(),
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
