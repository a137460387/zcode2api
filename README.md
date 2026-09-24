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
  详见下方"3012 的根因"——该风控**判定的是产出 captcha 参数的浏览器环境**，
  自动化驱动的浏览器产出的参数会被判低分。
- **新版桌面端把 captcha 配置改为服务端下发（2026-09-24 实测）**：`getCaptchaConfig()` 从
  `GET /api/v1/client/configs` 的 `data.configs.captcha` 读取（缓存 60s），CLI bundle 里已不再
  硬编码该配置；模型请求前多一个 `send_preflight` 阶段。配置值与本项目农场一致，故不构成问题。
- **3012 的根因（2026-09-24 完整实测，证据链闭合）**：不是配置失效、不是参数格式、不是账号。
  逐项排除如下（全部用真实 JWT 直连 `zcode.z.ai` 实测）：

  | 请求 | 响应 | 含义 |
  |---|---|---|
  | 不带 captcha 参数 | `3007` | 校验器正常工作，只是缺参数 |
  | 乱造参数 | `3007` | 格式无效被识别 |
  | **农场产出的合法参数（首次使用）** | **`3012`** | **格式正确 → 进入风控评估 → 判环境异常** |
  | 重复使用同一参数 | `3007` | 已消费，属正常 |

  另外确认：新版服务端下发的 captcha 配置（`GET /api/v1/client/configs` 的
  `data.configs.captcha`）与农场在用的**完全一致**（`sceneId: 11xygtvd` / `prefix: no8xfe` /
  `region: cn`），故**不是 sceneId 失效**；官方客户端还会对每个 provider 记录上一轮
  `certifyId` 以避免重复提交（`Pnn`/`F008`），但实测**新鲜参数的首次使用同样 3012**，
  故也不是重复提交。

  **结论：3012 判定的是"浏览器环境 + 请求上下文"，而非参数本身**。已排除的假设：
  配置失效（服务端下发的 captcha 配置与农场一致）、参数格式（合法参数同样被拒）、
  certifyId 重复（新鲜参数首次使用即 3012）、IP 行为分（换 IP 后仍 3012）、
  浏览器指纹（**用真实用户 Chrome 产出参数仍 3012**）。

  **最新发现（可能与签名头有关）**：新版引擎的请求头脱敏名单里包含三个"模型请求级"
  认证头——`x-aliyun-captcha-verify-param`（我们已实现）、**`x-client-sig`**、
  **`x-client-pow`**。后两者在任何客户端代码里都**不生成**：
  CLI bundle 中仅出现于脱敏名单（各 1 次），asar（主进程+renderer）中 **0 次**
  ——说明它们**由服务端随运行时头一起下发**（`requestProviderRuntimeHeaders` 机制）。
  同版本里旧笔记提到的 `isUnsignedModelRequestPath`（"模型端点永不签名"）**已不存在**，
  即新版该结论已过时。若上游已对模型端点校验 `x-client-sig`/`x-client-pow`，
  则**任何未实现该握手的第三方代理都会被 3012**——这与"代理失败、桌面端正常"的
  现象完全吻合。

  **可行方向**：① 从桌面端运行时抓取 `requestProviderRuntimeHeaders` 的完整返回值
  （含 `x-client-sig`/`x-client-pow` 的生成规则），这是唯一能补齐的路径；
  ② 或接受该限制，把本项目当作"桌面端在场时可用"的代理（需桌面端窗口配合）。
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`）。该配置来自
  服务端下发，可用 `GET https://zcode.z.ai/api/v1/client/configs`（带 JWT）读取，
  便于将来核对是否变更。
- 手动模式：`FARM_AUTO_BROWSER=0` 时不启动自动浏览器，改用你自己的真实 Chrome 打开
  farm 页（`http://127.0.0.1:8789/farm`）。注意：**实测真实 Chrome 参数同样会被 3012**，
  故手动模式并不能解决 3012，仅在调试指纹差异时有价值。
- farm 的浏览器 UA 必须覆盖且版本要真实：playwright 在 headless 下默认 UA 含
  `HeadlessChrome/<ver>`，SDK 见之即返回 `F001`（verifyResult:false）导致**一个参数都产不出来**。
  `src/captcha/browser.js` 会自动探测本机 Chrome 版本并构造桌面 UA
  （实测：默认 UA → F001 且 0 产出；覆盖 UA → 30s 内产出 3 个）。
  注：SDK 不检查 `navigator.webdriver`（实测该标志始终为 true，不影响结果）。
- 纯 CLI（headless）**无法**使用官方套餐通道：官方 `account:*` provider 不在 headless 注册表视图内
  （`Model creation failed`），这是新版桌面端的架构决定，非本项目缺陷。官方额度只在桌面端 GUI
  或"导入本机登录态 + 本代理"路径下可用。
- HTTPS farm：如 HTTP 下 SDK 异常，把 mkcert 证书放到 `certs/localhost-key.pem`、
  `certs/localhost.pem`（可从 `D:\code\Ai\zcode-proxy\certs\` 复制）并重启，自动切 HTTPS。
- 测试超时：`vitest.config.mjs` 把 `testTimeout` 设为 30s。并发/落盘类测试在负载高的机器上
  会明显变慢（实测同一批测试在 1.7s 与 >20s 之间波动），默认 5s 会误报失败。
- 仅供个人学习研究，遵守上游服务条款。

