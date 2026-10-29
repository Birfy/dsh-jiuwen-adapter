# Testing / 测试

| 命令 | 内容 | 依赖 |
|---|---|---|
| `npm test` | 单元 + 通用宿主测试（`node --test test/*.test.js`，24 项）；`generic-host.test.js` 启动 `bin/mock-gateway.mjs` 验证 plain chat、流式、gateway 工具（Jiuwen 执行）、openai `tool_calls` | 仅 Node ≥ 22 |
| `npm run smoke` | mock-openai + mock-gateway 端到端，会话映射持久化 | 无 |
| `npm run smoke:cordis` | 真实 Cordis `Context` + `LlmRuntime` 加载插件并 stream | `@deepseek-ai/cordis`/`dsh-llm`，或 `DSH_CORDIS_PATH`/`DSH_LLM_PATH`，或 FlyBot checkout |
| `npm run smoke:live` | 通用最小宿主连真实 Gateway（`JIUWEN_GATEWAY_URL`，默认 `:19000`），不在线则 `SKIP` 退出 0 | 运行中的 JiuwenSwarm |
| `npm run verify:flybot` | FlyBot core/social/tree + 适配器装入 DSH profile（可选兼容） | FlyBot + 已构建 DSH CLI |
| `npm run mock:gateway` / `mock:openai` | 单独启动 mock（端口 `JIUWEN_GATEWAY_MOCK_PORT`，默认 19000） | 无 |

证据输出到 `examples/`（已 gitignore）。
