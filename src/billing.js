import { buildBalanceHeaders } from './upstream/headers.js'

const BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance'

export async function fetchBalance({ jwt, appVersion = '3.11.2', fetchImpl = fetch }) {
  const res = await fetchImpl(`${BALANCE_URL}?app_version=${appVersion}`, {
    headers: buildBalanceHeaders({ jwt }),
  })
  const j = await res.json().catch(() => ({}))
  if (res.status !== 200 || j.code !== 0) {
    // 只回显 status 与业务码：上游响应体可能回显凭据（与网关同样的泄露面），
    // 整个 JSON 拼进错误信息会把它们写进看板与日志。
    throw new Error(`balance query failed: HTTP ${res.status}${j.code != null ? ` code=${j.code}` : ''}`)
  }
  const balances = (j.data?.balances ?? []).map((b) => ({
    entitlementId: b.entitlement_id,
    modelName: b.show_name,
    meter: b.meter,
    total: b.total_units ?? 0,
    used: b.used_units ?? 0,
    remaining: b.available_units ?? b.remaining_units ?? 0,
    expiresAt: b.expires_at ?? null,
  }))
  return { plans: j.data?.plans ?? [], balances }
}
