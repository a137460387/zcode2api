# zcode2api

把 ZCode（zcode.z.ai GLM 套餐）反代为本地 OpenAI / Anthropic 双协议 API。
设计文档：`docs/superpowers/specs/2026-09-23-zcode2api-design.md`。

> **✅ 状态：已跑通，正在消费官方额度（2026-09-25 实测）**
>
> - ✅ **双协议可用**：`/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI），
>   含流式 SSE、工具调用、思考块（`reasoning_content`）。
> - ✅ **真实用上官方额度**：实测请求后余额消耗（`GLM-5.3: used 129333`、`Flash: used 1730`）。
> - ✅ 227 个单元测试 + 端到端冒烟全通过。
>
> **关键突破（曾经 3012 的根因）**：上游网关对请求做**内容检查**——`system` 字段里
> 必须含 ZCode 身份块，否则直接返回 `3012 "method not allowed"`（对外文案为
> "request has been blocked due to unusual activity"）。
> 官方客户端的请求体是 **~8.5KB**（含身份块 + 环境信息 + `<system-reminder># currentDate`），
> 而此前的实现只发"裸请求"（~100 字节）。详见
> [3012 的根因与修复](#3012-的根因与修复)。


## 快速开始

```bash
npm install
cp .env.example .env   # 至少配置 API_KEY
npm start
```

- API：`http://127.0.0.1:8787/v1`（OpenAI `/v1/chat/completions`、Anthropic `/v1/messages`）
- 看板：`http://127.0.0.1:8787/`（本机免密）
- farm 页：`http://127.0.0.1:8789/farm`（启动时已自动打开无头 Chrome；也可手动打开并保持标签页）

## 验证

```bash
npm test        # 单元/集成测试（198 项，不碰网络与真实上游）
npm run e2e     # 端到端冒烟：真实 server + 真实 Response 走通双协议四条路径
```

`npm run e2e` 用本地假上游起真实服务，覆盖「OpenAI/Anthropic × 流式/非流式」四条路径，
并核对 captcha 参数送达、SSE 透传与 usage 记账。它存在的原因是：单元测试把上游桩成普通对象，
会掩盖只有真实 `Response` 才暴露的缺陷（例如 `Response.body` 是一次性流）。


## 添加账号

1. 看板 →「+ BigModel 登录」或「+ Z.AI 登录」→ 浏览器完成授权 → 自动入库。
2. （可选）从 ZCode 桌面端迁移：账号凭据在 `~/.zcode/v2/credentials.json`（enc:v1 加密），
   解密方案见 `D:\code\Ai\zcode-proxy\NOTES.md`，本工具不做自动迁移，看板重新登录即可。

## 两种账号通道

| 账号类型 | 上游 | 需 captcha | 适用 |
|---|---|---|---|
| oauth | `zcode.z.ai/api/v1/zcode-plan/anthropic` | 每请求一个一次性参数（farm 供给） | Start Plan / Global Build 免费额度 |
| apikey | `open.bigmodel.cn/api/anthropic` | 否 | 付费 GLM Coding Plan key |

添加 apikey 账号：把 `accounts/<id>.json` 手工放入目录，
`{"id":"bigmodel:manual-1","provider":"bigmodel","type":"apikey","apiKey":"<key>", ...}`（其余字段同 oauth 账号默认值），重启生效。

## 客户端接入

- Claude Code：`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` + `ANTHROPIC_AUTH_TOKEN=<API_KEY>`
- OpenAI SDK：`base_url=http://127.0.0.1:8787/v1`，`api_key=<API_KEY>`
- 模型：`glm-5.3`、`glm-5.3-flash`（`claude-*` 自动映射 GLM-5.3-Flash）

## 3012 的根因与修复

**上游网关会对请求做内容检查**：如果 `system` 字段里看不到 ZCode 身份块，
直接返回 `3012 "method not allowed"`（对外文案 `request has been blocked due to unusual activity`）。

这解释了此前所有排查都失败的原因——**发出去的是"裸请求"**：

| | 官方客户端 / 现在的实现 | 修复前 |
|---|---|---|
| 请求体大小 | **~8.3–8.6 KB** | ~100 字节 |
| `system` 字段 | 3 块官方身份块（带 `cache_control: ephemeral`） | 无 / 仅用户 system |
| 首轮 user 消息 | 前挂 `<system-reminder>…# currentDate…</system-reminder>` | 纯用户文本 |
| 模型名 | 小写 `glm-5.3` | 大写 `GLM-5.3` |
| `user-agent` | `ZCode/3.14.3 ai-sdk/anthropic/3.0.81` | `…ai-sdk/provider-utils/4.0.27 runtime/node.js/24` |
| `x-zcode-app-version` | `3.14.3` | 缺失 |
| `accept-encoding` | `gzip` | 缺失 |
| `x-title` | `Z Code@cli` | `Z Code@electron` |
| `x-query-id` / `x-session-id` | 不带 | 带了 |

**修复**：新增 `src/upstream/system-prompt.js`（按官方形态组装三块身份 + 上下文前缀），
`src/upstream/zcode-plan.js` 在发送前调用 `shapeZcodePlanBody()` 补齐请求体，
`src/upstream/headers.js` 按抓包复刻请求头。文案资产在 `src/upstream/zcode-system.json`。

### 实测结果（2026-09-25）

```
/v1/messages        → 200 {"content":[{"type":"text","text":"SYSTEM-FIX-OK"}],"usage":{"input_tokens":1707}}
/v1/chat/completions → 200 {"choices":[{"message":{"content":"OPENAI-OK"}}]}
流式 SSE            → 200 完整事件流（message_start → content_block_delta → …）
GLM-5.3-Flash       → 200（含 thinking 块）
余额复查            → GLM-5.3 used=129333｜Flash used=1730   ← 真实消耗官方额度
```

### 排查方法学（值得记下的教训）

定位过程中走了很长弯路，以下方法最终有效，也澄清了几个误区：

1. **以余额变化为最终判据** —— 只有 `used_units` 增长才证明请求被接受。
   `3007`/`3012` 都发生在计费之前，故余额不变。
2. **区分中间环节与最终结果** —— captcha 验证通过 ≠ 模型请求成功；
   连接建立 ≠ 响应返回。（曾把 captcha SDK 回调误读为"请求成功"。）
3. **对比一个已知可用的第三方实现**是最高效的定位手段——
   同样的账号/机器它能通，就能确定问题在自身实现而非环境。
4. **已排除的因素**（供参考）：captcha 参数格式与新鲜度、certifyId 重复、
   账号状态、额度、出口 IP、浏览器指纹（真实 Chrome 同）、TLS 指纹
   （Electron 原生网络栈同）、`x-client-sig`/`x-client-pow` 签名头（上游不校验）。
   **这些都不是原因**——真正的原因是请求体形态。

## 风险与已知限制

- 上游对模型端点有风控：`3012` 会触发账号冷却（默认 30min，24h 内第 3 次起 24h，5 次停用）。
  **请勿压测**——每次失败都在消耗账号行为分。
- **`system` 字段形态与上游策略强耦合**：若官方客户端升级后改变身份块结构，
  需要同步更新 `src/upstream/zcode-system.json` 与组装逻辑，否则会重新出现 3012。
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`）。该配置由服务端下发，
  可用 `GET https://zcode.z.ai/api/v1/client/configs`（带 JWT）读取，便于核对是否变更。
- farm 的浏览器 UA 必须覆盖且版本要真实：playwright 在 headless 下默认 UA 含
  `HeadlessChrome/<ver>`，SDK 见之即返回 `F001`（verifyResult:false）导致**一个参数都产不出来**。
  `src/captcha/browser.js` 会自动探测本机 Chrome 版本并构造桌面 UA。
  注：SDK 不检查 `navigator.webdriver`（实测该标志始终为 true，不影响结果）。
- 手动模式：`FARM_AUTO_BROWSER=0` 时不启动自动浏览器，改用你自己的真实 Chrome 打开
  farm 页（`http://127.0.0.1:8789/farm`）。
- 纯 CLI 无法直接使用官方套餐（官方 `account:*` provider 不在 headless 注册表内）——
  这正是本项目存在的意义：让官方额度可被程序调用。
- 测试超时：`vitest.config.mjs` 把 `testTimeout` 设为 30s（并发/落盘类测试在慢机器上波动较大）。
- 仅供个人学习研究，遵守上游服务条款。
