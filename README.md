# zcode2api

把 ZCode（zcode.z.ai GLM 套餐）反代为本地 OpenAI / Anthropic 双协议 API。
设计文档：`docs/superpowers/specs/2026-09-23-zcode2api-design.md`。

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

## 风险与已知限制

- 上游对模型端点有行为风控（3012 unusual activity）：默认 2s/账号最小间隔 + 30min 冷却；
  高频失败会加重行为分（小时~天级衰减）。请勿压测。
  **注意**：该风控针对"账号+设备+IP"的行为分，**官方桌面端在同期也会被同样拦截**。
  实测（2026-09-23）代理与桌面端同时返回 3012，故遇到时先确认桌面端能否发消息，
  以区分"风控冷却中"与"代理配置问题"。
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`），官方更新可能失效。
- farm 的浏览器 UA 必须覆盖：playwright 在 headless 下默认 UA 含 `HeadlessChrome/<ver>`，
  SDK 见之即返回 `F001`（verifyResult:false）导致**一个参数都产不出来**。
  `src/captcha/browser.js` 已自动覆盖为桌面 Chrome UA，两种模式都可用
  （实测：默认 UA → F001 且 0 产出；覆盖 UA → 30s 内产出 3 个）。
  注：SDK 不检查 `navigator.webdriver`（实测该标志始终为 true，不影响结果）。
- HTTPS farm：如 HTTP 下 SDK 异常，把 mkcert 证书放到 `certs/localhost-key.pem`、
  `certs/localhost.pem`（可从 `D:\code\Ai\zcode-proxy\certs\` 复制）并重启，自动切 HTTPS。
- 测试超时：`vitest.config.mjs` 把 `testTimeout` 设为 30s。并发/落盘类测试在负载高的机器上
  会明显变慢（实测同一批测试在 1.7s 与 >20s 之间波动），默认 5s 会误报失败。
- 仅供个人学习研究，遵守上游服务条款。

