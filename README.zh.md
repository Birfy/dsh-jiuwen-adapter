# @dsh-jiuwen/adapter

**DSH = Cordis 插件 ABI/壳；JiuwenSwarm = Agent 脑。**

聊天循环、工具、记忆、会话、模型选择等**基本 agent 能力一律落在 JiuwenSwarm**。DSH / FlyBot 只负责 Cordis 插件兼容（`ds-bot`、social、tree 等照常加载），不把 DSH `agent-loop` 当产品脑。

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。  
反向错误方向：openjiuwen `harness_providers/dsh`（Jiuwen 宿主、DSH 当 CLI brain）— **不要扩展**。

## 产品路径（默认 `mode=gateway`）

1. Cordis 插件照常挂到 DSH。
2. `ctx.llm` 路由 `jiuwen` → 本 adapter。
3. 每个模型调用映射到 Jiuwen Gateway `chat.send`（同一 Jiuwen session 持续记忆）；图/文件块投影为 `media_items` / attachments。
4. **剥离** DSH 工具 schema；Gateway 侧跑工具；流式文本回传并以 `finish:stop` 结束，避免 DSH agent-loop 再执行工具。
5. 可选 unary E2A：`ctx.jiuwenAdapter.gateway.*`（history / session / models / mcp / memory / files / cancel / workflows）。工具所有权仍在 Jiuwen。

`mode=openai` 仅作连通性/诊断回退；默认仍剥离工具。只有 `allowDshAgentLoop=true` / `JIUWEN_ALLOW_DSH_AGENT_LOOP=1` 才会把工具交回 DSH（明确非产品路径）。

## 安装

```bash
dsh plugin --profile web add /workspace/dsh-jiuwen-adapter
```

```yaml
# 默认模型切到 Jiuwen
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
- id: llm-jiuwen
  config:
    mode: gateway
    gatewayURL: ws://127.0.0.1:19000/ws
    # 可选鉴权（与 jiuwenswarm web_proxy 顺序一致）
    # accessToken / authToken / cookie / authorization / xToken
```

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `JIUWEN_MODE` | `gateway`（产品）/ `openai`（诊断） | **`gateway`** |
| `JIUWEN_GATEWAY_URL` | Gateway WS | `ws://127.0.0.1:19000/ws` |
| `JIUWEN_BASE_URL` | OpenAI 兼容根（仅 openai 模式） | `http://127.0.0.1:18080/v1` |
| `JIUWEN_API_KEY` / `JIUWEN_AUTH_TOKEN` / `JIUWEN_ACCESS_TOKEN` | 鉴权 | （空） |
| `JIUWEN_COOKIE` | Cookie 头（可含 `access_token=`） | （空） |
| `JIUWEN_USER_ID` | Gateway user_id | `dsh-adapter` |
| `JIUWEN_SESSION_MAP` | 会话映射文件 | `$DSH_HOME/jiuwen-adapter/session-map.json` |
| `JIUWEN_WORK_MODE` | `work_mode` | `agent` |
| `JIUWEN_ALLOW_DSH_AGENT_LOOP` | `1` 才允许 DSH 拥有工具环 | 关闭 |
| `JIUWEN_TIMEOUT_MS` | 单轮超时 | `180000` |

鉴权解析顺序（对齐 Gateway web_proxy）：query `access_token`/`token` → `Authorization: Bearer` / `X-Token` → Cookie `access_token` → 配置/环境变量。Node WS 同时带 query + headers。

## 源码面

| 模块 | 作用 |
|------|------|
| `src/e2a-methods.js` | Gateway / E2A 方法与事件名表 |
| `src/gateway-transport.js` | `chat.send` 流 + unary RPC |
| `src/auth.js` | cookie/session header 模式 |
| `src/multimodal.js` | DSH image/file → media_items |
| `src/agent-brain.js` | 剥离 DSH tools、脑所有权 |
| `src/plugin.js` | Cordis 注册 + `ctx.jiuwenAdapter.gateway` |

## 验证

```bash
cd /workspace/dsh-jiuwen-adapter
npm test                 # 含 auth / multimodal / e2a-rpc
npm run smoke            # gateway brain + openai fallback（mock）
npm run smoke:cordis     # Cordis 注册 + stream
npm run verify:flybot    # FlyBot core/social/tree + bridge（需 DSH CLI 已 build）
```

证据与诚实 pass/fail 见 [VERIFICATION.md](./VERIFICATION.md)。

## 当前缺口（诚实）

1. **Live chat 需真实模型**：Gateway 已可起（`jiuwenswarm-start app`，WS `19000`）；E2A RPC 已绿。未配置可用模型时 `chat.send` 返回「还没有配置可用的模型…」。
2. **完整 `dsh web` UI**：`apps/cli/lib/bin.js` 可用（定向 `tsc`+`tsdown`）；全量 `pnpm run build:lib` 仍因 host/client tsdown 缺 entry（如 `onboarding-config.js`）失败，verify 跳过 UI boot。
3. DSH 附件若仅 device/offloaded、无 data URL / 可读 path，只能发文本占位；Gateway 无法拉取 DSH 私有 attachment store。
4. Swarm 子任务/工具事件以文本 marker 回灌 DSH，不做完整 DSH 卡片 UI 映射。
5. Jiuwen 前端 `channels/web/frontend/dist` 未构建；仅后端/WS 路径已验证。
