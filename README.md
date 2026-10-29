# @dsh-jiuwen/adapter

**DSH = Cordis plugin ABI/shell. JiuwenSwarm = the agent brain.**

Chat loop, tools, memory, sessions, and models are grounded in JiuwenSwarm. DSH only hosts Cordis-compatible plugins (FlyBot). See [ARCHITECTURE.md](./ARCHITECTURE.md).

Chinese: [README.zh.md](./README.zh.md). Verification: [VERIFICATION.md](./VERIFICATION.md).

Default `mode=gateway` → `chat.send` with auth (query/Bearer/X-Token/Cookie) and multimodal `media_items`. OpenAI mode is diagnostics-only unless `allowDshAgentLoop` is explicitly enabled. Unary E2A helpers hang off `ctx.jiuwenAdapter.gateway.*`; tools stay on Jiuwen.

```bash
dsh plugin --profile web add /path/to/dsh-jiuwen-adapter
export JIUWEN_MODE=gateway
export JIUWEN_GATEWAY_URL=ws://127.0.0.1:19000/ws
npm test && npm run smoke && npm run smoke:cordis && npm run verify:flybot
```

## 简介 (中文)

DSH/Cordis FlyBot 插件适配器：把 llm provider `jiuwen` 路由到 JiuwenSwarm gateway（`ws://127.0.0.1:19000/ws`，`mode=gateway`，调用 `chat.send`）。

- 配置：通过 `cordis.patch.yml` 启用插件并设置 provider。
- 模型：在 `~/.jiuwenswarm/config/.env` 中配置（不要提交该文件）。
- Mac 兼容提示：brew 安装的 dsh `0.1.2-rc.1` 缺少 `permissionPresets.catalog()`，请升级到 dsh `>= 0.2`。
