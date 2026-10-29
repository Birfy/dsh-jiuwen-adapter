# Testing / 测试

| 命令 | 内容 | 依赖 |
|---|---|---|
| `npm test` | 单元 + 通用宿主 + gateway 特性（35 项）。`generic-host.test.js`：plain chat、流式、gateway 工具、openai `tool_calls`；`gateway-features.test.js`：推理块/结构化事件/usage/processing_status 过滤/markers 兼容/会话连续性/取消→chat.interrupt/agent·mode·skills·model 选择/多模态 base64Data/attachments 服务/ask_user/本地标题/runtime context 过滤/扩展 RPC | 仅 Node ≥ 22 |
| `npm run smoke` | mock-openai + mock-gateway 端到端，会话映射持久化 | 无 |
| `npm run smoke:cordis` | 真实 Cordis `Context` + `LlmRuntime` 加载插件并 stream（openai mock + gateway mock，校验 LlmRuntime 流语法不变式） | 全局 npm dsh 安装（或 `DSH_NODE_MODULES` / `DSH_LLM_PATH` / `DSH_CORDIS_PATH`） |
| `npm run smoke:live` | 通用最小宿主连真实 Gateway（默认 `:19000`，不在线则 `SKIP`）：单轮、多轮记忆、工具调用结构化事件、usage、processing_status 不泄漏、取消、session/skills/team/models RPC（13 项） | 运行中的 JiuwenSwarm |
| `npm run bare-dsh` | 安装 npm 版 dsh 并配置 headless/web profile，见 [bare-dsh.md](./bare-dsh.md) | npm 网络 |
| `npm run mock:gateway` / `mock:openai` | 单独启动 mock（端口 `JIUWEN_GATEWAY_MOCK_PORT`，默认 19000） | 无 |

证据输出到 `examples/`（已 gitignore）。

mock gateway 模拟真实线格式（`tool_call.name` 嵌套、`rendered_result`、`patch_segment` final、`usage_summary`、`processing_status.is_complete`；`slow` 慢流、`ask me` 触发提问、`echo-params` 回显参数、`debug.state` RPC 读取最近参数/中断）。`MOCK_STREAM_END=1` 额外发 `stream.end`。
