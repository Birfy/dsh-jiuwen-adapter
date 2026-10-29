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

## 3. dsh tools → Jiuwen (opt-in MCP passthrough)

Default stays **`toolPassthrough: off`**: dsh tool schemas are stripped and Jiuwen only uses its own tools (no double execution, no DSH agent-loop re-entry).

With `toolPassthrough: mcp` the adapter serves the allowlisted tool schemas of each dsh turn (`GenerateOptions.tools`: built-ins, other plugins' tools, `dsh-mcp-client` tools) as a minimal Streamable-HTTP MCP server on `127.0.0.1:<random>` with a random bearer token, registers it in Jiuwen (`mcp.register_custom` + `mcp.connect`, name `mcpServerName`) and enables it per turn (`chat.send` param `mcp: [name]`). Jiuwen calls it as `mcp_<name>_<tool>`; dsh executes `ctx.tools.get(tool).execute()` in-process.

```yaml
- id: llm-jiuwen
  config:
    toolPassthrough: mcp             # JIUWEN_TOOL_PASSTHROUGH
    toolAllowlist: [web_fetch, working_directory, 'my_plugin_*']   # JIUWEN_TOOL_ALLOWLIST (comma); '*' = all — empty = none
    toolApproval: dsh                # every call needs ctx.approval allowed-once (deny on no UI/timeout); 'none' to skip
    toolCallTimeoutMs: 120000
    mcpServerName: dsh-tools
```

Notes / risks:
- Registration is written to Jiuwen's MCP state; on plugin dispose the adapter sends `mcp.disconnect` + `mcp.delete_custom`. A killed host may leave a dead entry; the next start overwrites it (same name).
- Calls run outside dsh's tool scheduler (no dsh tool cards / pre-/post-execute hooks); approval is the gate. Prefer narrow allowlists; do not allowlist tools Jiuwen already has (bash/read/write…) unless you mean it.
- Live (dsh 0.2.1-rc.2): allowlist `working_directory` → Jiuwen called `mcp_dshtest_working_directory`, got `{"cwd":"/tmp/qs-KbEo"}`; with approval rejected Jiuwen received `dsh denied working_directory (rejected)`. Registration adds ~1–2 s on the first turn of a process.

中文：默认仍剥离 dsh 工具；设 `toolPassthrough: mcp` + `toolAllowlist` 后，dsh（含其他插件/MCP）工具以本地 MCP 服务注册给 Jiuwen，由 dsh 执行、每次调用需 dsh 审批（默认拒绝）。

## 4. dsh auxiliary calls (titles, compaction) don't run Jiuwen turns

Verified first: dsh `dsh-compaction-basic` calls `ctx.llm.stream({ purpose: 'compaction' })`; before this change the adapter ran a **full Jiuwen agent turn in a throwaway session** (`<jiuwen-session>-aux-<ts>`, full transcript) — live ~7.4–9.4 s and one extra Jiuwen session per compaction. Session titles (`purpose: 'session-title'`) were already local (`titleMode: local`).

- `compactionMode` (`JIUWEN_COMPACTION_MODE`), default **`local`**: return a local role-tagged digest of the conversation (newest kept, ~6000 chars) instantly (live: 1 ms). Jiuwen keeps the real history (`historyMode: gateway` only sends new user text), so the dsh checkpoint doesn't need an LLM summary.
- `local+jiuwen`: same, plus `command.compact {session_id}` on the mapped Jiuwen session (live: `{"result":"compressed",…}`, ~15 s, only when the session has turns).
- `jiuwen`: legacy throwaway-session turn.

中文：dsh 压缩默认本地生成摘要，不再为压缩起一个 Jiuwen 回合；`local+jiuwen` 额外让 Jiuwen 压缩自己的会话。

## 5. `/jiuwen` slash command (dsh command registry)

When the host provides `ctx.commands` (`@deepseek-ai/dsh-commands`; web UI, ACP and other command-capable surfaces), the adapter registers one namespaced command — it does not shadow dsh's own `/compact`, `/goal`, `/plan`, …:

| Command | Jiuwen RPC |
|---|---|
| `/jiuwen status` | `models.list` (active model) + `session.get_metadata`; shows dsh → Jiuwen session mapping and turns |
| `/jiuwen models` | `models.list` (★ = Jiuwen default) |
| `/jiuwen model <name\|default>` | validated against `models.list`; persists a per-session `model_name` override for following `chat.send` |
| `/jiuwen compact` | `command.compact` on the mapped Jiuwen session |
| `/jiuwen interrupt` | `chat.interrupt {intent:'cancel'}` |
| `/jiuwen sessions` / `skills` / `agents` / `mcp` | `session.list` / `skills.list` / `agents.list` / `mcp.list` |

`registerCommands: false` (`JIUWEN_REGISTER_COMMANDS=0`) disables it; the same handler is available as `ctx.jiuwenAdapter.command(sessionId, 'models')`. dsh headless has no command parser (a `/…` task is sent as text), so use the web UI / ACP there.

Live (dsh 0.2.1-rc.2, via `ctx.commands.execute(agent, …)` inside headless): registry lists `compact, feedback, goal, jiuwen, permission, plan`; `/jiuwen status`, `models`, `model doubao-seed-2.0-mini`, `model nosuch` (rejected with the available list) and `skills` all returned from the live gateway.

中文：在 dsh 命令注册表上注册 `/jiuwen <子命令>`，映射到 Jiuwen 的 status / models / 模型切换 / compact / interrupt / sessions / skills / agents / mcp。

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
