# dsh integration / 与 dsh 扩展点的集成

How the adapter cooperates with other dsh (Cordis) plugins while JiuwenSwarm stays the agent brain.
Verified live on npm `@deepseek-ai/dsh@0.2.1-rc.2` + local JiuwenSwarm Gateway `ws://127.0.0.1:19000/ws` (2026-10-29).

## 1. ask_user → dsh user-questions (`ctx.userQuestions`)

- `supportsUserInteraction` (default **`auto`**): `supports_user_interaction=true` is sent on `chat.send` only when the host provides `ctx.userQuestions` (`@deepseek-ai/dsh-user-questions`) **and** a client listens on `user-questions/request` (TUI/web). Headless dsh has no answerer, so `auto` stays off there — enabling it would add Jiuwen's `ask_user` tool (~920 input tokens per turn) for questions that can never be answered. `true` / `false` force it (`JIUWEN_SUPPORTS_USER_INTERACTION=1|0`).
- On `chat.ask_user_question` the adapter calls `ctx.userQuestions.ask({ questions, agent, signal })` (agent = `ctx.agents.get(sessionId)`), so any dsh answerer UI (web `dsh-client-ui-user-questions`, ACP, a custom plugin hooking the `user-questions/request` waterfall) shows its native card.
- The answer is mapped back (option label → Jiuwen option `value`) and sent on the **same socket**: sources `ask_user_interrupt` / `confirm_interrupt` / `permission_interrupt` / `evolution_interrupt` resume with `chat.send {query:'', request_id, answers, source}` (as Jiuwen's own CLI does); other sources use `chat.user_answer`. The dsh turn keeps streaming the resumed output.
- Fallback: no answerer (`NO_PROVIDER`, e.g. headless), error or `questionTimeoutMs` (default 600000) → Jiuwen is told `noUiAnswer` ("No interactive user is available…") so it never stays paused. With `supportsUserInteraction: false` the legacy behaviour remains (question printed as text, turn ends, `gateway.userAnswer()` available).
- Duplicate cards for an already-answered `request_id` are ignored.

中文：`supportsUserInteraction` 默认 `auto`——宿主有 `ctx.userQuestions` 且有客户端监听 `user-questions/request`（TUI/web）时才告诉 Jiuwen 可交互（headless 不开启，省掉 ask_user 工具约 920 输入 token/轮）；问题走 dsh 原生问答卡，答案在同一 WS 上回给 Jiuwen 并继续流式输出；无答题 UI/超时则回一个中性答复让 Jiuwen 自行继续。

## 2. Permission / plan approval → dsh user-approval (`ctx.approval`)

- Routed to `ctx.approval.request({ agent, toolName, reason, signal })` (`@deepseek-ai/dsh-user-approval`, i.e. the dsh approval card / `approval/request` waterfall / ACP permission):
  - `chat.ask_user_question` with `source: permission_interrupt` (Jiuwen tool permission card; `card_id` is echoed back),
  - `source: confirm_interrupt` (plan approval, `exit_plan_mode`),
  - `plan.approval_required`.
- Decision → Jiuwen option: `allowed-once` → option whose value/label is `allow_once`/`approve`/…; anything else → `reject`/`deny`/…, then resumed with `chat.send {request_id, answers, source}`.
- **Safe default = deny**: no `ctx.approval`, no live agent, `rejected`/`cancelled`/`unavailable`, error, abort or `approvalTimeoutMs` (default 300000) → reject. Approvals never fail open. dsh approval policy `never` (auto-approve) is honoured because it is dsh's own decision.
- Live (dsh 0.2.1-rc.2, `JIUWEN_CHAT_MODE=code.plan`): rejected → Jiuwen did not execute the plan (file not created); `allowed-once` → plan executed (`/tmp/jwplan.txt` = `hi`).

中文：Jiuwen 的工具权限卡 / 计划审批统一交给 dsh `ctx.approval`；只有 `allowed-once` 才放行，其余（无 UI、超时、出错）一律拒绝。

## 3. dsh tools → Jiuwen (opt-in MCP passthrough) — **experimental**

Default stays **`toolPassthrough: off`**: dsh tool schemas are stripped and Jiuwen only uses its own tools (no double execution, no DSH agent-loop re-entry).

With `toolPassthrough: mcp` each dsh process serves the allowlisted tool schemas of its turns (`GenerateOptions.tools`: built-ins, other plugins' tools, `dsh-mcp-client` tools) on a private `127.0.0.1:<random>` endpoint with a random bearer token. Jiuwen does **not** connect to that endpoint: it talks to one stable stdio MCP server, `bin/jiuwen-mcp-proxy.mjs`, registered once per Jiuwen backend under `mcpServerName` (`mcp.register_custom` transport `stdio` + `mcp.connect`) and owned by Jiuwen. Each dsh process drops `ep-<pid>.json` (0600) into the shared state dir (`mcpStateDir`, default `~/.cache/dsh-jiuwen/mcp/<mcpServerName>/`) and merges its schemas into `schemas.json`; the proxy forwards `tools/call` to the newest live process that serves the tool and answers `isError` "dsh is not running" otherwise. The turn enables it via `chat.send` param `mcp: [name]`; Jiuwen calls `mcp_<name>_<tool>`; dsh executes `ctx.tools.get(tool).execute()` in-process.

Why the proxy: JiuwenSwarm's worker spins at 100 % CPU forever when it closes a streamable-http MCP client whose server already exited ([known-issues.md](./known-issues.md#1-jiuwen-worker-spins-at-100-cpu-after-an-mcp-server-disappears)). dsh processes are short-lived and may be killed (`kill -9`), so per-process register/remove — the first implementation — reliably wedged the backend. Now:
- no `mcp.disconnect` / `mcp.delete_custom` per process; dispose / exit only removes `ep-<pid>.json` (a stale file of a killed process is ignored by pid liveness);
- an existing connected proxy record is reused without any RPC (read from Jiuwen's `agent/workspace/mcp/state.json`); new tool names trigger a disconnect + connect **while the proxy is alive** (safe);
- RPCs time out after `mcpRpcTimeoutMs` (30 s); registration failure only disables passthrough for that turn.

```yaml
- id: llm-jiuwen
  config:
    toolPassthrough: mcp             # JIUWEN_TOOL_PASSTHROUGH
    toolAllowlist: [web_fetch, working_directory, 'my_plugin_*']   # JIUWEN_TOOL_ALLOWLIST (comma); '*' = all — empty = none
    toolApproval: dsh                # every call needs ctx.approval allowed-once (deny on no UI/timeout); 'none' to skip
    toolCallTimeoutMs: 120000
    mcpServerName: dsh-tools
    # mcpStateDir: ~/.cache/dsh-jiuwen/mcp/dsh-tools   # JIUWEN_MCP_STATE_DIR
    # mcpRpcTimeoutMs: 30000                            # JIUWEN_MCP_RPC_TIMEOUT_MS
```

Notes / risks:
- Requires dsh and Jiuwen on the same host/user (the proxy reads the state dir). Concurrent dsh processes share one registration; a call goes to the newest live process exposing that tool.
- Calls run outside dsh's tool scheduler (no dsh tool cards / pre-/post-execute hooks); approval is the gate. Prefer narrow allowlists; do not allowlist tools Jiuwen already has (bash/read/write…) unless you mean it.
- Upgrading from the old per-process streamable-http registration: the first re-register replaces the old record; if that old server is gone Jiuwen may wedge once (see recovery).
- **Recovery** if the Jiuwen worker sits at ~100 % CPU while idle / all turns get slower: `/jiuwen mcp-reset` (disconnect + delete while the proxy answers) and restart the JiuwenSwarm agentserver **and** gateway (killing the old worker process; it does not exit on SIGTERM when wedged). See known-issues.md.
- Live (dsh 0.2.1-rc.2, first implementation): allowlist `working_directory` → Jiuwen called `mcp_dsh-tools_working_directory`, got the dsh cwd; with approval rejected Jiuwen received `dsh denied working_directory (rejected)`.

中文（实验性）：默认仍剥离 dsh 工具；设 `toolPassthrough: mcp` + `toolAllowlist` 后，Jiuwen 只连接一个由它自己托管、常驻的 stdio MCP 代理（`bin/jiuwen-mcp-proxy.mjs`，每个 Jiuwen 后端注册一次），代理把调用转发给当前存活的 dsh 进程（`ep-<pid>.json`）；dsh 进程退出或被 kill -9 只会留下无效端点文件，不再逐进程 disconnect/delete，从而避开 Jiuwen 在关闭"服务端已消失"的 MCP 客户端时 worker 100% CPU 空转的 bug。每次调用仍需 dsh 审批（默认拒绝）。出现空转时：`/jiuwen mcp-reset` 后重启 Jiuwen agentserver + gateway。

## 4. dsh auxiliary calls (titles, compaction) don't run Jiuwen turns

Verified first: dsh `dsh-compaction-basic` calls `ctx.llm.stream({ purpose: 'compaction' })`; before this change the adapter ran a **full Jiuwen agent turn in a throwaway session** (`<jiuwen-session>-aux-<ts>`, full transcript) — live ~7.4–9.4 s and one extra Jiuwen session per compaction. Session titles (`purpose: 'session-title'`) were already local (`titleMode: local`).

- `compactionMode` (`JIUWEN_COMPACTION_MODE`), default **`local`**: return a local role-tagged digest of the conversation (newest kept, ~6000 chars) instantly (live: 1 ms). Jiuwen keeps the real history (`historyMode: gateway` only sends new user text), so the dsh checkpoint doesn't need an LLM summary.
- `local+jiuwen`: same, plus `command.compact {session_id}` on the mapped Jiuwen session (live: `{"result":"compressed",…}`, ~15 s, only when the session has turns).
- `jiuwen`: legacy throwaway-session turn.

中文：dsh 压缩默认本地生成摘要，不再为压缩起一个 Jiuwen 回合；`local+jiuwen` 额外让 Jiuwen 压缩自己的会话。

## 5. `/jiuwen` slash command (dsh command registry)

When the host provides `ctx.commands` (`@deepseek-ai/dsh-commands`; web UI, ACP and other command-capable surfaces), the adapter registers one namespaced command — it does not shadow dsh's own `/compact`, `/goal`, `/plan`, …:

| Command | Jiuwen RPC / behaviour |
|---|---|
| `/jiuwen status` | `models.list` + `session.get_metadata`; mapping, turns, session overrides (mode/skills/agentTemplate), title |
| `/jiuwen models` | `models.list` (★ = Jiuwen default) |
| `/jiuwen model <name\|default>` | validated against `models.list`; per-session `modelName` for following `chat.send` |
| `/jiuwen mode [name\|default]` | show/set per-session `chatMode` (`default` clears); applied on following `chat.send` |
| `/jiuwen pause` / `resume` | `chat.interrupt {intent:'pause'\|'resume'}` |
| `/jiuwen rename <title>` | `session.rename` |
| `/jiuwen pin [on\|off]` | `session.pin` (default on) |
| `/jiuwen fork` | `session.fork`; reports new `session_id` (does not overwrite the current local mapping) |
| `/jiuwen unmap` | drop local dsh↔Jiuwen mapping only (no Gateway delete) |
| `/jiuwen delete` | `session.delete` then clear local mapping |
| `/jiuwen goal [get\|set <text>\|pause\|resume\|clear]` | `command.goal` (default get) |
| `/jiuwen workflows [list\|get <id>]` | `command.workflows` (default list) |
| `/jiuwen history` | `history.list_turns` / `history.get` (capped ~15 turns) |
| `/jiuwen btw <question>` | `command.btw` `{session_id, question}` (unary side-question; short summary) |
| `/jiuwen recap` | `command.recap` `{session_id}` |
| `/jiuwen skill-toggle <name> <on\|off>` | `skills.toggle` (requires explicit on/off) |
| `/jiuwen plan-status` | `session.plan_status` |
| `/jiuwen supplement <text>` | `chat.interrupt {intent:'supplement', new_input}` (not `chat.send` `is_supplement`) |
| `/jiuwen teams` | `team.templates.list` + `team.list` (names) |
| `/jiuwen tools` | `agents.tools_list` (Jiuwen-owned tool names + count) |
| `/jiuwen hooks` | `hooks.list` (total hooks, non-empty events) |
| `/jiuwen permissions` | `permissions.tools.get` (allow/ask/deny counts, ask/deny names) + `permissions.rules.get` (rule count) |
| `/jiuwen plugins` | `plugins.list` (enabled / disabled) |
| `/jiuwen projects` | `project.list` (name, `project_id`, work mode, default marker, dir) |
| `/jiuwen archived` | `session.archived.list` |
| `/jiuwen assets` | `session.assets.list` for the mapped session |
| `/jiuwen version` | `updater.get_status` (current / latest version, install mode) |
| `/jiuwen heartbeat` | `heartbeat.get_conf` (interval, target, active hours) |
| `/jiuwen compact` | `command.compact` on the mapped Jiuwen session |
| `/jiuwen interrupt` | `chat.interrupt {intent:'cancel'}` |
| `/jiuwen sessions` / `skills` [`installed`] / `agents` / `mcp` | `session.list` / `skills.list` (or `skills.installed`) / `agents.list` / `mcp.list` |
| `/jiuwen mcp-reset` | disconnect + delete the dsh MCP registration (passthrough recovery) |

Per-session overrides (`modelName`, `chatMode`, `skills`, `agentTemplateName`) live in the session map file; request `providerOptions.jiuwen` and catalog model fields still win over the mapping.

**Title sync:** when `titleMode: local` answers `purpose: session-title`, the adapter also fire-and-forgets `session.rename` on the mapped Jiuwen session (skips empty / same-as-`mapping.title`; rename failures are logged at debug and do not fail the dsh title stream). Persists `title` on the mapping when rename succeeds.

`registerCommands: false` (`JIUWEN_REGISTER_COMMANDS=0`) disables it; the same handler is available as `ctx.jiuwenAdapter.command(sessionId, 'models')`. dsh headless has no command parser (a `/…` task is sent as text), so use the web UI / ACP there.

Live (dsh 0.2.1-rc.2, via `ctx.commands.execute(agent, …)` inside headless): registry lists `compact, feedback, goal, jiuwen, permission, plan`; `/jiuwen status`, `models`, `model doubao-seed-2.0-mini`, `model nosuch` (rejected with the available list) and `skills` all returned from the live gateway. Newer session RPCs (`session.rename` / `pin` / `fork` / `delete`, `command.goal`, `skills.toggle`, `command.btw` / `command.recap`, `session.plan_status`, `team.*`, `skills.installed`) depend on the Gateway build — see [known-issues.md](./known-issues.md) live probe notes; probe with `ctx.jiuwenAdapter.gateway.rpc` if a live call fails.

中文：在 dsh 命令注册表上注册 `/jiuwen <子命令>`，覆盖 status / models / model / mode / pause / resume / rename / pin / fork / unmap / delete / goal / workflows / history / btw / recap / skill-toggle / plan-status / supplement / teams / tools / hooks / permissions / plugins / projects / archived / assets / version / heartbeat / compact / interrupt / sessions / skills[installed] / agents / mcp / mcp-reset；本地标题会兼容同步 `session.rename`；会话级 mode/skills/agentTemplate 可覆盖默认配置。

## 6. `jiuwen/event` (declared Cordis event)

The adapter emits every structured Jiuwen activity as the Cordis event **`jiuwen/event`** (constant `JIUWEN_EVENT`), also available as `ctx.jiuwenAdapter.onEvent(fn)` and per request via `providerOptions.jiuwen.onEvent`. Types ship in [`index.d.ts`](../index.d.ts) (module augmentation of `@deepseek-ai/cordis` `Events` and `Context.jiuwenAdapter`).

```ts
import type { JiuwenEvent } from '@dsh-jiuwen/adapter'
ctx.on('jiuwen/event', (e: JiuwenEvent) => { if (e.type === 'tool_call') console.log(e.dshSessionId, e.name) })
```

| `type` | fields |
|---|---|
| `reasoning` | `text` |
| `tool_call` / `tool_update` / `tool_result` | `name`, `id`, `arguments` / `status` / `success`, `result` |
| `subtask_update`, `subagent_activity`, `todo.updated`, `team.task`, `team.member`, `team.message` | `summary` |
| `processing_status` | `isProcessing`, `isComplete` |
| `usage` | `usage {inputTokens,outputTokens,totalTokens}`, `model` |
| `media` / `file` | `name`, `path`, `url` |
| `ask_user` | `questions` (legacy text path) |
| `interaction_answered` | `eventType`, `source`, `kind: question\|approval`, `outcome`, `answers` |
| `error`, `interrupt`, `interrupt_result` | `message` / `intent` |
| `raw` | `event` (any other Jiuwen event name, e.g. `context.usage`, `chat.output_phase`) |

All events carry `dshSessionId`, `sessionId` (Jiuwen) and `requestId`; `raw` is the untouched Jiuwen payload (owned by JiuwenSwarm, may change). Live check: a co-loaded plugin's `ctx.on('jiuwen/event')` received events with `dshSessionId` (used by the command test in §5).

中文：`jiuwen/event` 现已在 index.d.ts 中声明（Cordis Events 扩展），字段如上表；其他插件可直接 `ctx.on('jiuwen/event')` 订阅。
