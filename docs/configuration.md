# Configuration reference

Precedence: **environment variable > Cordis plugin config > default** (`provider` / `displayName` / `models` / `defaultModel` come from plugin config only).

| Plugin key | Env | Default | Meaning |
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
| `injectSystem` | `JIUWEN_INJECT_SYSTEM` | `persona` | Set `off` to disable. Forward the host system prompt to Jiuwen (its `chat.send` has no system field): `persona` = FlyBot identity/instructions/group/language sections only (no markers → nothing sent); `full` = whole text. Sent once per Jiuwen session as a `[System instructions from host]…[/System]` prefix, resent only when its hash changes; capped at 8 KB; latest in-history system message wins; any error → plain query |
| `trajectoryDetail` | `JIUWEN_TRAJECTORY_DETAIL` | `full` | Set `summary` for one-line activity only. `full`: Jiuwen tool calls/results, subtasks, todos and `trace.*` steps as Markdown steps (header, args, result; 4 KB per item) in the reasoning block (dsh Trajectory tab). Never emits tool-call blocks. Needs `eventDisplay: reasoning` |
| `ignoreMessagePatterns` | — | `['^Current runtime context\\.', '^Time sampled while preparing turn \\d+']` | Regexes; matching user blocks (from match onward) are not forwarded |
| `chatMode` | `JIUWEN_CHAT_MODE` | = `workMode` | chat.send `mode` (`agent`, `agent.plan`, `agent.fast`, `agent.work.normal`, `agent.code.normal`, `team`, `team.work.normal`, …). Per-session override via `/jiuwen mode` (stored in the session map) |
| `agentTemplateName` | `JIUWEN_AGENT_TEMPLATE` | — | Jiuwen expert (`agent_template_name`); may also be stored per-session in the map |
| `agentGroupName` | `JIUWEN_AGENT_GROUP` | — | Jiuwen expert group for Team (`agent_group_name`) |
| `skills` | `JIUWEN_SKILLS` (comma list) | — | Selected Jiuwen skills; may also be stored per-session in the map |
| `forwardModelName` | `JIUWEN_FORWARD_MODEL=0` disables | `true` | Send non-catalog model ids as `model_name` |
| `supportsUserInteraction` | `JIUWEN_SUPPORTS_USER_INTERACTION=1\|0` | `auto` | `auto`: tell Jiuwen it may ask when the host has `ctx.userQuestions` and a live answerer (not headless); questions are answered via dsh user-questions (see [dsh-integration.md](./dsh-integration.md)) |
| `questionTimeoutMs` | `JIUWEN_QUESTION_TIMEOUT_MS` | `600000` | Max wait for a dsh answer, then `noUiAnswer` |
| `approvalTimeoutMs` | `JIUWEN_APPROVAL_TIMEOUT_MS` | `300000` | Max wait for a dsh approval decision on Jiuwen permission / plan approval, then **deny** |
| `toolPassthrough` | `JIUWEN_TOOL_PASSTHROUGH` | `mcp` when `hostSync` on, else `off` | `mcp`: expose allowlisted dsh tools to Jiuwen as a local MCP server |
| `toolAllowlist` | `JIUWEN_TOOL_ALLOWLIST` (comma) | `["*"]` when `hostSync` on, else `[]` | Tool names / `prefix*` / `*` |
| `toolApproval` | `JIUWEN_TOOL_APPROVAL` | `dsh` | Gate each passthrough call with `ctx.approval` (deny when unavailable); `none` |
| `toolCallTimeoutMs` | `JIUWEN_TOOL_CALL_TIMEOUT_MS` | `120000` | Abort a passthrough dsh tool call |
| `mcpServerName` | `JIUWEN_MCP_SERVER_NAME` | `dsh-tools` | Name of the stable stdio MCP proxy registered once in Jiuwen (experimental) |
| `mcpStateDir` | `JIUWEN_MCP_STATE_DIR` | `~/.cache/dsh-jiuwen/mcp/<name>` | Shared dir: `schemas.json` + `ep-<pid>.json` read by the proxy |
| `mcpRpcTimeoutMs` | `JIUWEN_MCP_RPC_TIMEOUT_MS` | `30000` | Timeout for `mcp.register_custom` / `connect` / `disconnect` |
| `noUiAnswer` | — | "No interactive user is available…" | Reply sent to Jiuwen when no dsh answerer exists |
| `interruptOnAbort` | — | `true` | Host abort → `chat.interrupt {intent:'cancel'}` |
| `finalGraceMs` | `JIUWEN_FINAL_GRACE_MS` | `1500` | Idle grace after `chat.final` (turn normally ends on `processing_status.is_complete`) |
| `terminalFinalGraceMs` | `JIUWEN_TERMINAL_FINAL_GRACE_MS` | `100` | JiuwenSwarm sends an empty, request-scoped `chat.final` (no `final_mode`) ~0.7 s before `processing_status.is_complete`; the turn ends this long after it if nothing else arrives. Negative = wait for `processing_status`/`finalGraceMs` |
| `postCancelSettleMs` | `JIUWEN_POST_CANCEL_SETTLE_MS` | `1000` | After a cancel, delay the next `chat.send` on that session until this long after the cancel (JiuwenSwarm drops a send that arrives within ~300 ms of `chat.interrupt`). `0` disables |
| `titleMode` | `JIUWEN_TITLE_MODE` | `local` | `purpose: session-title` answered locally (`local`) or by Jiuwen (`jiuwen`) |
| `compactionMode` | `JIUWEN_COMPACTION_MODE` | `local` | `purpose: compaction`: `local` digest (no Jiuwen call) / `local+jiuwen` (+ `command.compact` on the Jiuwen session) / `jiuwen` (legacy aux turn) |
| `registerCommands` | `JIUWEN_REGISTER_COMMANDS=0` disables | `true` | Register `/jiuwen <sub>` on `ctx.commands` ([dsh-integration.md](./dsh-integration.md#5-jiuwen-slash-command-dsh-command-registry)) |
| `commandName` | `JIUWEN_COMMAND_NAME` | `jiuwen` | Slash command name. If another plugin owns `/jiuwen`, registration fails soft (warning) — pick a unique name |
| `swarmflowStopOnAbort` | `JIUWEN_SWARMFLOW_STOP_ON_ABORT=0` disables | `true` | Host abort also sends `swarmflow.stop` for the last SwarmFlow run seen in that Jiuwen session (only when a run id was seen) |
| `swarmflowReply` | — | `true` | SwarmFlow human turns (`source: swarmflow_human`) → `ctx.approval.request` → `chat.swarmflow_reply` (`approved` / `rejected (…)`; never fails open) |
| `documentPersist` | `JIUWEN_DOCUMENT_PERSIST=1` | `false` | Opt-in: `document.persist` document attachments on the turn socket before `chat.send` (fail soft: originals are sent if it fails) |
| `modelDiscovery` | `JIUWEN_MODEL_DISCOVERY=1` | `false` | **Opt-in.** Append Jiuwen `models.list` to this provider's catalog as unique ids `<discoveryPrefix><model_name>` (routed as `model_name`), and offer `llm.registerModelDiscovery(discoveryNamespace)` when the host has it. Never sets a default model |
| `discoveryNamespace` | — | `jiuwen` | Settings namespace for `registerModelDiscovery`; requests for other providers get `[]` |
| `recoverOnDrop` | `JIUWEN_RECOVER_ON_DROP=0` disables | `true` | If the Gateway socket drops mid-turn, poll `history.get` and return the reply, with the visible mark `[Recovered from Jiuwen history after the Gateway connection dropped]`. If nothing is recovered, the original error is kept |
| `recoverWindowMs` | `JIUWEN_RECOVER_WINDOW_MS` | `15000` | How long to poll history for the dropped reply |
| `discoveryPrefix` | — | `jiuwen-model:` | Id prefix for discovered models (keeps them distinct from `jiuwen-default` / other providers) |
| `sessionSync` | `JIUWEN_SESSION_SYNC=0` disables | `true` (with `hostSync`) | `session/created` → ensure mapping; `session/disposed` → clear pending question / SwarmFlow run (mapping kept). Jiuwen sessions only |
| `planBridge` | `JIUWEN_PLAN_BRIDGE=0` disables | `true` (with `hostSync`) | After a Jiuwen turn / plan event, mirror `session.plan_status.in_plan` onto `ctx.planMode`. Jiuwen sessions with a live agent only |
| `typedEvents` | `JIUWEN_TYPED_EVENTS=1` | `false` | **Opt-in.** Also emit `jiuwen/tool`, `jiuwen/plan`, `jiuwen/approval`, `jiuwen/swarm` (declared in `index.d.ts`). `jiuwen/event` is always emitted |
| `traceFile` | `JIUWEN_TRACE_FILE` | — | Append JSONL trace of turns/events |
| `serviceName` | — | `jiuwenAdapter` | ctx service name for the helper API (unique per instance). Exposed only via `ctx.provide`; a host without it (or a name clash) logs a warning instead of writing `ctx[serviceName]` |
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

## Compatibility guarantees

With `hostSync: false` (and `sessionSync`/`planBridge` off) behaviour matches the pre-sync adapter: no global listeners besides the plugin's own dispose, no host service is written except `ctx.provide(serviceName)`, no default model / permission preset / built-in command / tool is touched, and only namespaced names are used (`/jiuwen`, `jiuwen/*` events, `jiuwen_*` tools, `jiuwenAdapter`). Gateway methods are feature-detected (an `unknown method` answer is cached per Gateway URL; the subcommand soft-fails and disappears from `/jiuwen help`). Covered by `test/compat.test.js`.


## Validation

On load the adapter checks its config and logs `[jiuwen] …` warnings. It never throws and never prints values:

- **Unknown key**: `unknown config key "gatewayUrl" (did you mean "gatewayURL"?)`
- **Deprecated**: `apiKey`, because inline secrets end up in profile files. Put the key in an env var and name it with `apiKeyEnv`. Also `compactionMode: "jiuwen"`, because it runs a full Jiuwen turn; use the default `local`
- **Wrong type**: a value of the wrong kind, such as an object where a string is expected

`index.d.ts` exports `JiuwenAdapterConfig` for typed configs.
