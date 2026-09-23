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
- farm 依赖阿里云验证码 SDK 配置（SceneId `11xygtvd` / prefix `no8xfe`），官方更新可能失效。
- HTTPS farm：如 HTTP 下 SDK 异常，把 mkcert 证书放到 `certs/localhost-key.pem`、
  `certs/localhost.pem`（可从 `D:\code\Ai\zcode-proxy\certs\` 复制）并重启，自动切 HTTPS。
- 仅供个人学习研究，遵守上游服务条款。
