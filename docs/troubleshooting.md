# Troubleshooting & FAQ / 排障与常见问题

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `permissionPresets.catalog is not a function`（Mac brew dsh `0.1.2-rc.1`） | 旧版 dsh 宿主 ABI 缺 `catalog()`，与本插件无关 | `brew upgrade` 到 dsh `>= 0.2`，或使用源码构建的 dsh |
| `ECONNREFUSED 127.0.0.1:19000` / 一直无输出 | Gateway 未启动 | `jiuwenswarm-start app`；`ss -ltn \| grep 19000`（Mac: `lsof -iTCP:19000 -sTCP:LISTEN`）；或 `npm run mock:gateway` 先联调 |
| 401 / 403 / WS 立刻关闭 | token / cookie 不对或过期 | 设置 `JIUWEN_ACCESS_TOKEN` 或 `JIUWEN_COOKIE='access_token=...'`；确认 `JIUWEN_USER_ID` 与 token 匹配；见 [configuration.md](./configuration.md) 鉴权顺序 |
| 回复「还没有配置可用的模型…」 | Jiuwen 未配置模型 | 填写 `~/.jiuwenswarm/config/.env` 的 `API_BASE/API_KEY/MODEL_NAME/MODEL_PROVIDER` 后重启 gateway |
| 日志 `dsh-llm not resolvable; using duck-typed base` | 宿主没有 `@deepseek-ai/dsh-llm` | 通常无害；需要时设置 `JIUWEN_LLM_ADAPTER_MODULE` |
| provider `jiuwen` 不出现 | 插件未加载 / 缺 `llm` 服务 | 检查 `inject: ['llm']` 满足；`dsh plugin --profile web add <path>` |
| 超时 | 长任务超过 `requestTimeoutMs` | 调大 `JIUWEN_TIMEOUT_MS` |
| 宿主想自己执行工具 | gateway 模式下工具归 Jiuwen | 改 `mode: openai` + `allowDshAgentLoop: true`（仅诊断） |
| FlyBot 路径被意外探测 | `compat: auto` 检测到 `/workspace/FlyBot` | `compat: none` 或 `JIUWEN_COMPAT=none` |

## FAQ

- **一定要 DSH / FlyBot 吗？** 不需要。任何提供 Cordis `llm` 服务（`registerAdapter`）的宿主都行，见 `test/generic-host.test.js`。
- **工具调用谁执行？** 默认 Jiuwen 执行，宿主只看到文本 marker（`[jiuwen-tool:name]`），finish=`stop`，不会二次执行。
- **会话如何保持？** 宿主 `sessionId` 映射到稳定的 Jiuwen `session_id`（`dsh-<hex>`），存于 `mappingPath`；历史/记忆在 Jiuwen 侧。
- **支持图片/文件吗？** 支持 data URL / 可读路径的图片与文件，转为 `media_items`；仅设备端/离线附件只能发文本占位。
- **如何列历史、模型、MCP？** `ctx.jiuwenAdapter.gateway.historyGet / modelsList / mcpList / memoryList / filesList / chatCancel / workflows`。
- **会提交密钥吗？** 不会；`.gitignore` 排除 `.env*`、cookie/token 文件、session-map、examples 证据目录。
