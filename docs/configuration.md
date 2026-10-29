# Configuration reference / 配置参考

Precedence: **environment variable > Cordis plugin config > default**（`provider`/`displayName`/`models`/`defaultModel` 仅来自插件配置）。

| Plugin key | Env | Default | Meaning / 含义 |
|---|---|---|---|
| `provider` | — | `jiuwen` | Provider id registered on `ctx.llm` |
| `displayName` | — | `JiuwenSwarm` | `providerInfo().name` |
| `mode` | `JIUWEN_MODE` | `gateway` | `gateway` (product, Jiuwen brain) / `openai` (diagnostics; aliases `llm`, `completions`) |
| `gatewayURL` | `JIUWEN_GATEWAY_URL` | `ws://127.0.0.1:19000/ws` | Gateway WebSocket |
| `baseURL` | `JIUWEN_BASE_URL` | `http://127.0.0.1:18080/v1` | OpenAI-compatible root (openai mode only) |
| `apiKey` | `JIUWEN_API_KEY` or `$apiKeyEnv` | — | Bearer key for openai mode |
| `apiKeyEnv` | — | `JIUWEN_API_KEY` | Name of an alternative env var holding the key |
| `authToken` | `JIUWEN_AUTH_TOKEN` | — | Gateway token (also fallback for `accessToken`) |
| `accessToken` | `JIUWEN_ACCESS_TOKEN` | = `authToken` | Sent as query `access_token` |
| `cookie` | `JIUWEN_COOKIE` | — | `Cookie` header (may contain `access_token=`) |
| `authorization` | `JIUWEN_AUTHORIZATION` | — | Raw `Authorization` header |
| `xToken` | `JIUWEN_X_TOKEN` | — | `X-Token` header |
| `userId` | `JIUWEN_USER_ID` | `dsh-adapter` | Gateway `user_id` |
| `models` | — | `jiuwen-default`, `jiuwen-swarm` (128k ctx, 8192 max; swarm → `chatMode: team.work.normal`) | Catalog `[{id,name,contextWindow,maxTokens, modelName?, chatMode?, agentTemplateName?, agentGroupName?}]` |
| `defaultModel` | — | first model id | |
| `mappingPath` | `JIUWEN_SESSION_MAP` | `$DSH_HOME/jiuwen-adapter/session-map.json` (`DSH_HOME`→`ctx path.home`→`HOME`→cwd) | Host session ↔ Jiuwen session map |
| `workMode` | `JIUWEN_WORK_MODE` | `agent` | `chat.send` `work_mode` |
| `projectDir` | `JIUWEN_PROJECT_DIR` | — | Forwarded project directory |
| `requestTimeoutMs` | `JIUWEN_TIMEOUT_MS` | `180000` | Per-turn timeout |
| `allowDshAgentLoop` | `JIUWEN_ALLOW_DSH_AGENT_LOOP=1` | `false` | openai mode: forward host tools, return `tool-call` chunks |
| `exposeJiuwenTools` | `JIUWEN_EXPOSE_TOOLS=1` | `false` | Enable `bridge.listJiuwenTools()` discovery |
| `surfaceGatewayToolEvents` | — | `true` | Render Jiuwen tool/subtask events as text markers |
| `eventDisplay` | `JIUWEN_EVENT_DISPLAY` | `reasoning` (`none` if `surfaceGatewayToolEvents: false`) | Jiuwen tool/subtask activity: `reasoning` block / legacy text `markers` / `none` |
| `forwardReasoning` | `JIUWEN_FORWARD_REASONING=0` disables | `true` | `chat.reasoning` → `reasoning-delta` |
| `showProcessingStatus` | `JIUWEN_SHOW_PROCESSING_STATUS=1` | `false` | Show `chat.processing_status` (filtered by default) |
| `emitUsage` | — | `true` | Emit `usage` chunk from `chat.usage_summary` |
| `historyMode` | `JIUWEN_HISTORY_MODE` | `gateway` | `gateway`: after turn 1 send only new user text; `transcript`: always recent transcript |
| `ignoreMessagePatterns` | — | `['^Current runtime context\\.']` | Regexes; matching user blocks (from match onward) are not forwarded |
| `chatMode` | `JIUWEN_CHAT_MODE` | = `workMode` | chat.send `mode` (`agent`, `agent.plan`, `agent.fast`, `agent.work.normal`, `agent.code.normal`, `team`, `team.work.normal`, …) |
| `agentTemplateName` | `JIUWEN_AGENT_TEMPLATE` | — | Jiuwen expert (`agent_template_name`) |
| `agentGroupName` | `JIUWEN_AGENT_GROUP` | — | Jiuwen expert group for Team (`agent_group_name`) |
| `skills` | `JIUWEN_SKILLS` (comma list) | — | Selected Jiuwen skills |
| `forwardModelName` | `JIUWEN_FORWARD_MODEL=0` disables | `true` | Send non-catalog model ids as `model_name` |
| `supportsUserInteraction` | `JIUWEN_SUPPORTS_USER_INTERACTION=1\|0` | `auto` | `auto`: tell Jiuwen it may ask when the host has `ctx.userQuestions`; questions are answered via dsh user-questions (see [dsh-integration.md](./dsh-integration.md)) |
| `questionTimeoutMs` | `JIUWEN_QUESTION_TIMEOUT_MS` | `600000` | Max wait for a dsh answer, then `noUiAnswer` |
| `approvalTimeoutMs` | `JIUWEN_APPROVAL_TIMEOUT_MS` | `300000` | Max wait for a dsh approval decision on Jiuwen permission / plan approval, then **deny** |
| `toolPassthrough` | `JIUWEN_TOOL_PASSTHROUGH` | `off` | `mcp`: expose allowlisted dsh tools to Jiuwen as a local MCP server ([dsh-integration.md](./dsh-integration.md#3-dsh-tools--jiuwen-opt-in-mcp-passthrough)) |
| `toolAllowlist` | `JIUWEN_TOOL_ALLOWLIST` (comma) | `[]` | Tool names / `prefix*` / `*` |
| `toolApproval` | `JIUWEN_TOOL_APPROVAL` | `dsh` | Gate each passthrough call with `ctx.approval` (deny when unavailable); `none` |
| `toolCallTimeoutMs` | `JIUWEN_TOOL_CALL_TIMEOUT_MS` | `120000` | Abort a passthrough dsh tool call |
| `mcpServerName` | `JIUWEN_MCP_SERVER_NAME` | `dsh-tools` | MCP server name registered in Jiuwen |
| `noUiAnswer` | — | "No interactive user is available…" | Reply sent to Jiuwen when no dsh answerer exists |
| `interruptOnAbort` | — | `true` | Host abort → `chat.interrupt {intent:'cancel'}` |
| `finalGraceMs` | `JIUWEN_FINAL_GRACE_MS` | `1500` | Idle grace after `chat.final` (turn normally ends on `processing_status.is_complete`) |
| `terminalFinalGraceMs` | `JIUWEN_TERMINAL_FINAL_GRACE_MS` | `100` | JiuwenSwarm sends an empty, request-scoped `chat.final` (no `final_mode`) ~0.7 s before `processing_status.is_complete`; the turn ends this long after it if nothing else arrives. Negative = wait for `processing_status`/`finalGraceMs` |
| `postCancelSettleMs` | `JIUWEN_POST_CANCEL_SETTLE_MS` | `1000` | After a cancel, delay the next `chat.send` on that session until this long after the cancel (JiuwenSwarm drops a send that arrives within ~300 ms of `chat.interrupt`). `0` disables |
| `titleMode` | `JIUWEN_TITLE_MODE` | `local` | `purpose: session-title` answered locally (`local`) or by Jiuwen (`jiuwen`) |
| `compactionMode` | `JIUWEN_COMPACTION_MODE` | `local` | `purpose: compaction`: `local` digest (no Jiuwen call) / `local+jiuwen` (+ `command.compact` on the Jiuwen session) / `jiuwen` (legacy aux turn) |
| `traceFile` | `JIUWEN_TRACE_FILE` | — | Append JSONL trace of turns/events |
| `serviceName` | — | `jiuwenAdapter` | ctx service name for the helper API (unique per instance) |
| `llmAdapterModule` | `JIUWEN_LLM_ADAPTER_MODULE` | — | Explicit module/path exporting `LlmAdapter` |
| — | `DSH_NODE_MODULES` / `DSH_LLM_PATH` / `DSH_CORDIS_PATH` | global npm dsh install | Used by `scripts/cordis-load-smoke.mjs` only |

Auth resolution order (matches Jiuwen web_proxy): query `access_token`/`token` → `Authorization: Bearer` / `X-Token` → Cookie `access_token` → config/env. Node WS sends both query and headers.

## Full example (`cordis.patch.yml`)

```yaml
- insert:
    - id: llm-jiuwen
      name: '@dsh-jiuwen/adapter'
      config:
        provider: jiuwen
        mode: gateway
        gatewayURL: ws://127.0.0.1:19000/ws
        userId: alice
        workMode: agent
        requestTimeoutMs: 180000
        models:
          - { id: jiuwen-default, name: Jiuwen Default, contextWindow: 128000, maxTokens: 8192 }
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
```

## JiuwenSwarm model config (`~/.jiuwenswarm/config/.env`)

Never commit this file. Fields:

| Field | Meaning |
|---|---|
| `API_BASE` | Model endpoint base URL |
| `API_KEY` | Model key |
| `MODEL_NAME` | Model name |
| `MODEL_PROVIDER` | Protocol: `OpenAI` (compatible) or `Anthropic` |
| `ENDPOINT_PROFILE` | OpenAI dialect: `openai` / `deepseek` / `openrouter` / `siliconflow` / `dashscope` / `openai_compatible` / `ollama` / `lmstudio` / `vllm` / `sglang` |
| `CUSTOM_HEADERS` | Extra request headers |
| `EMBED_API_BASE` / `EMBED_API_KEY` / `EMBED_MODEL` | Embeddings (memory) |
| `VIDEO_API_BASE` / `VIDEO_API_KEY` / `VIDEO_MODEL_NAME` / `VIDEO_PROVIDER` | Video model |
| `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` | Optional browser-decision credentials |

Other settings: `~/.jiuwenswarm/config/config.yaml`.

## Per-request options

Any `GenerateOptions` may carry `providerOptions.jiuwen` (or `metadata.jiuwen` / `jiuwen`):

```js
ctx.llm.stream({ provider: 'jiuwen', model: 'jiuwen-default', messages, providerOptions: { jiuwen: {
  chatMode: 'agent.plan', agentTemplateName: 'coder', agentGroupName: 'g1', skills: ['pptx-generator'],
  pluginNames: [], modelName: 'doubao-seed-2.0-mini', projectDir: '/repo', sessionId: 'existing-jiuwen-session',
  historyMode: 'transcript', supportsUserInteraction: true, metadata: {}, onEvent: e => console.log(e),
} } })
```

Precedence: request > catalog model entry > plugin config.
