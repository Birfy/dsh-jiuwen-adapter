# dsh integration

How the adapter cooperates with other dsh (Cordis) plugins while JiuwenSwarm stays the agent brain.
Verified live on npm `@deepseek-ai/dsh@0.2.1-rc.2` + local JiuwenSwarm Gateway `ws://127.0.0.1:19000/ws` (2026-10-29).

## 1. ask_user → dsh user-questions (`ctx.userQuestions`)

- `supportsUserInteraction` (default **`auto`**): `supports_user_interaction=true` is sent on `chat.send` only when the host provides `ctx.userQuestions` (`@deepseek-ai/dsh-user-questions`) **and** a client listens on `user-questions/request` (TUI/web). Headless dsh has no answerer, so `auto` stays off there — enabling it would add Jiuwen's `ask_user` tool (~920 input tokens per turn) for questions that can never be answered. `true` / `false` force it (`JIUWEN_SUPPORTS_USER_INTERACTION=1|0`).
- On `chat.ask_user_question` the adapter calls `ctx.userQuestions.ask({ questions, agent, signal })` (agent = `ctx.agents.get(sessionId)`), so any dsh answerer UI (web `dsh-client-ui-user-questions`, ACP, a custom plugin hooking the `user-questions/request` waterfall) shows its native card.
- The answer is mapped back (option label → Jiuwen option `value`) and sent on the **same socket**: sources `ask_user_interrupt` / `confirm_interrupt` / `permission_interrupt` / `evolution_interrupt` resume with `chat.send {query:'', request_id, answers, source}` (as Jiuwen's own CLI does); other sources use `chat.user_answer`. The dsh turn keeps streaming the resumed output.
- Fallback: no answerer (`NO_PROVIDER`, e.g. headless), error or `questionTimeoutMs` (default 600000) → Jiuwen is told `noUiAnswer` ("No interactive user is available…") so it never stays paused. With `supportsUserInteraction: false` the legacy behaviour remains (question printed as text, turn ends, `gateway.userAnswer()` available).
- Duplicate cards for an already-answered `request_id` are ignored.


## 2. Permission / plan approval → dsh user-approval (`ctx.approval`)

- Routed to `ctx.approval.request({ agent, toolName, reason, signal })` (`@deepseek-ai/dsh-user-approval`, i.e. the dsh approval card / `approval/request` waterfall / ACP permission):
  - `chat.ask_user_question` with `source: permission_interrupt` (Jiuwen tool permission card; `card_id` is echoed back),
  - `source: confirm_interrupt` (plan approval, `exit_plan_mode`),
  - `plan.approval_required`.
- Decision → Jiuwen option: `allowed-once` → option whose value/label is `allow_once`/`approve`/…; anything else → `reject`/`deny`/…, then resumed with `chat.send {request_id, answers, source}`.
- **Safe default = deny**: no `ctx.approval`, no live agent, `rejected`/`cancelled`/`unavailable`, error, abort or `approvalTimeoutMs` (default 300000) → reject. Approvals never fail open. dsh approval policy `never` (auto-approve) is honoured because it is dsh's own decision.
- Live (dsh 0.2.1-rc.2, `JIUWEN_CHAT_MODE=code.plan`): rejected → Jiuwen did not execute the plan (file not created); `allowed-once` → plan executed (`/tmp/jwplan.txt` = `hi`).


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
- **Recovery** if the Jiuwen worker sits at ~100 % CPU while idle / all turns get slower: `/jiuwen mcp-reset confirm` (disconnect + delete while the proxy answers; the next passthrough turn re-registers the identical proxy) and restart the JiuwenSwarm agentserver **and** gateway (killing the old worker process; it does not exit on SIGTERM when wedged). See known-issues.md.
- Live (dsh 0.2.1-rc.2, first implementation): allowlist `working_directory` → Jiuwen called `mcp_dsh-tools_working_directory`, got the dsh cwd; with approval rejected Jiuwen received `dsh denied working_directory (rejected)`.


## 4. dsh auxiliary calls (titles, compaction) don't run Jiuwen turns

Verified first: dsh `dsh-compaction-basic` calls `ctx.llm.stream({ purpose: 'compaction' })`; before this change the adapter ran a **full Jiuwen agent turn in a throwaway session** (`<jiuwen-session>-aux-<ts>`, full transcript) — live ~7.4–9.4 s and one extra Jiuwen session per compaction. Session titles (`purpose: 'session-title'`) were already local (`titleMode: local`).

- `compactionMode` (`JIUWEN_COMPACTION_MODE`), default **`local`**: return a local role-tagged digest of the conversation (newest kept, ~6000 chars) instantly (live: 1 ms). Jiuwen keeps the real history (`historyMode: gateway` only sends new user text), so the dsh checkpoint doesn't need an LLM summary.
- `local+jiuwen`: same, plus `command.compact {session_id}` on the mapped Jiuwen session (live: `{"result":"compressed",…}`, ~15 s, only when the session has turns).
- `jiuwen`: legacy throwaway-session turn.


## 5. `/jiuwen` slash command (dsh command registry)

When the host provides `ctx.commands` (`@deepseek-ai/dsh-commands`; web UI, ACP and other command-capable surfaces), the adapter registers one namespaced command — it does not shadow dsh's own `/compact`, `/goal`, `/plan`, …:

| Command | Jiuwen RPC / behaviour |
|---|---|
| `/jiuwen status` | `models.list` + `session.get_metadata`; mapping, turns, session overrides (mode/skills/agentTemplate), title |
| `/jiuwen models` | `models.list` (★ = Jiuwen default) |
| `/jiuwen model <name\|default>` | validated against `models.list`; per-session `modelName` for following `chat.send` |
| `/jiuwen model-info <id\|name>` | match `models.list` by model_id/model_name/alias/#index; `models.get` when an id exists (0.2.5b1), else list entry (0.2.7); no api_key printed |
| `/jiuwen mode [name\|default]` | show/set per-session `chatMode` (`default` clears); applied on following `chat.send` |
| `/jiuwen pause` / `resume` | `chat.interrupt {intent:'pause'\|'resume'}` |
| `/jiuwen rename <title>` | `session.rename` |
| `/jiuwen pin [on\|off]` | `session.pin` (default on) |
| `/jiuwen fork` | `session.fork`; reports new `session_id` (does not overwrite the current local mapping) |
| `/jiuwen switch` | `session.switch` on the mapped session |
| `/jiuwen archive` / `unarchive` | `session.archive` / `session.unarchive` (`session_ids: [sid]`) |
| `/jiuwen unmap` | drop local dsh↔Jiuwen mapping only (no Gateway delete) |
| `/jiuwen delete confirm` | `session.delete` then clear local mapping (refuses without `confirm`; a never-used / already-deleted session only clears the mapping) |
| `/jiuwen goal [get\|set <text>\|pause\|resume\|clear]` | `command.goal` (default get) |
| `/jiuwen workflows [list\|get <id>]` | `command.workflows` (default list) |
| `/jiuwen history` | `history.list_turns` / `history.get` (capped ~15 turns) |
| `/jiuwen btw <question>` | `command.btw` `{session_id, question}` (unary side-question; short summary) |
| `/jiuwen recap` | `command.recap` `{session_id}` |
| `/jiuwen skill-toggle <name> <on\|off>` | `skills.toggle` (requires explicit on/off) |
| `/jiuwen plan-status` | `session.plan_status` |
| `/jiuwen supplement <text>` | `chat.interrupt {intent:'supplement', new_input}` (not `chat.send` `is_supplement`) |
| `/jiuwen teams` | `team.templates.list` + `team.list` → fallback `team.bindings.list` (0.2.7) |
| `/jiuwen tools` | `agents.tools_list` (Jiuwen-owned tool names + count) |
| `/jiuwen hooks` | `hooks.list` (total hooks, non-empty events) |
| `/jiuwen permissions` [`set <tool> <allow\|ask\|deny>`\|`unset <tool>`] | get: `permissions.tools.get` + `permissions.rules.get`; set/unset: `permissions.tools.update` / `delete` |
| `/jiuwen plugins` [`enable\|disable <name>`] | list: `plugins.list`; enable/disable: `plugins.enable` / `plugins.disable` (`name`) |
| `/jiuwen projects` [`info\|sessions [id]`] | list: `project.list`; info: `project.info`; sessions: `project.get_sessions` |
| `/jiuwen archived` | `session.archived.list` |
| `/jiuwen assets` | `session.assets.list` for the mapped session (0.2.7: clear not-available message) |
| `/jiuwen version` | `updater.get_status` (current / latest version, install mode) |
| `/jiuwen heartbeat` [`set <every> [target]`\|`jobs`] | get: `heartbeat.get_conf`; set: `heartbeat.set_conf` (preserves active_hours); jobs: `heartbeat.job.list` |
| `/jiuwen path` | `path.get` (chrome/headless/decision) |
| `/jiuwen locale` | `locale.get_conf` |
| `/jiuwen commands` | `commands.list` (Gateway slash command names) |
| `/jiuwen templates` | `agent_templates.list` |
| `/jiuwen cron` | `cron.job.list` |
| `/jiuwen compact` | `command.compact` on the mapped Jiuwen session |
| `/jiuwen interrupt` | `chat.interrupt {intent:'cancel'}` |
| `/jiuwen sessions` / `skills` [`installed`] / `agents` / `mcp` | `session.list` / `skills.list` (or `skills.installed`) / `agents.list` / `mcp.list` |
| `/jiuwen mcp-reset confirm` | disconnect + delete the dsh MCP registration (passthrough recovery; the next passthrough turn re-registers it identically) |
| `/jiuwen updater [check\|conf]` | `updater.get_status` / `updater.check` (read-only, 60s timeout) / `updater.get_conf`; never downloads or upgrades |
| `/jiuwen agent <name>` | `agents.get` (description, model, tools) |
| `/jiuwen skill-info <name>` | `skills.get` + `skills.versions.list` |
| `/jiuwen marketplaces` | `skills.marketplace.list` (read-only) |
| `/jiuwen bindings` | `team.bindings.list` |
| `/jiuwen help` | grouped help (Session / Turn control / Models & mode / Skills & agents / Config & policy / System); also printed for unknown subcommands |

Per-session overrides (`modelName`, `chatMode`, `skills`, `agentTemplateName`) live in the session map file; request `providerOptions.jiuwen` and catalog model fields still win over the mapping.

**Title sync:** when `titleMode: local` answers `purpose: session-title`, the adapter also fire-and-forgets `session.rename` on the mapped Jiuwen session (skips empty / same-as-`mapping.title`; rename failures are logged at debug and do not fail the dsh title stream). Persists `title` on the mapping when rename succeeds.

`registerCommands: false` (`JIUWEN_REGISTER_COMMANDS=0`) disables it; the same handler is available as `ctx.jiuwenAdapter.command(sessionId, 'models')`. dsh headless has no command parser (a `/…` task is sent as text), so use the web UI / ACP there.

Live (dsh 0.2.1-rc.2, via `ctx.commands.execute(agent, …)` inside headless): registry lists `compact, feedback, goal, jiuwen, permission, plan`; `/jiuwen status`, `models`, `model doubao-seed-2.0-mini`, `model nosuch` (rejected with the available list) and `skills` all returned from the live gateway. Newer session RPCs (`session.rename` / `pin` / `fork` / `delete`, `command.goal`, `skills.toggle`, `command.btw` / `command.recap`, `session.plan_status`, `team.*`, `skills.installed`) depend on the Gateway build — see [known-issues.md](./known-issues.md) live probe notes; probe with `ctx.jiuwenAdapter.gateway.rpc` if a live call fails.


### 5a. Extended subcommands (JiuwenSwarm 0.2.7 `/ws`)

Read-only: `config [get] [dot.path]` (secrets incl. `api_key` masked as `***`), `mcp show <name|id>`, `skills search|online|show|files <name> [path]|retrieval [status|tree]|graph [status|get]|evolution <name> [status|get]|experience`, `memory [forbidden|context [status|config|services]]`, `cron get|preview <id>`, `cron meta`, `heartbeat job|preview <id>`, `heartbeat meta`, `schedule [list|status|logs|check]`, `team [history|snapshot]`, `template show <id|name>`, `template files <id> [path]`, `group [list|show <id>]`, `group files <id> [path]`, `packages [list|show <id>]`, `extensions`, `vendors [list|models <vendor_key> <plan>]` (never passes `api_key`; Gateway preset fallback), `openai [auth|models]`, `health`, `projects pinned|cron [project_id]`, `git [status|diff|probe|turns|turn <id>] [project]` (soft-fails when git disabled), `models validate` (uses Jiuwen's stored config; refuses `api_key=` args), `permissions overrides|scopes`, `document formats`, `publish [describe|status|records|local] kind=.. local_id=..` (Hub AUTH soft-fails; no credentials via slash), `channels [conf <dingtalk|discord|feishu|slack|telegram|wechat|wecom|whatsapp|xiaoyi>]` (secrets masked), `rsi [tasks|versions|task|report|tree|usage <task_id>|files <task_id> [path]]`, `context [search <q>|node <id>|source <id>|auth <provider>|runs]` (personal context), `issues [matrix|states]` (feature-detected; unknown on 0.2.7), `harness packages`, `skills hub <team [q]|team-info|swarm <asset_id>|recommend <asset_id>|skillnet <q>|clawhub <q>>` (search only; nothing installed).

Safe writes (reversible; every delete / bulk overlay needs a trailing `confirm`): `cron create name=.. expr="m h dom mon dow" [desc=..] [tz=..] [target=web] [mode=..] [enabled=off]` (created **disabled** unless `enabled=on`), `cron update <id> key=value…`, `cron toggle <id> on|off`, `cron run <id>`, `cron delete <id> confirm`; `heartbeat create name=.. prompt=".." [every=..] [enabled=off]`, `heartbeat update <id> key=value…`, `heartbeat toggle|run|cancel <id>`, `heartbeat delete <id> confirm`; `schedule create|run|cancel` (feature-detected); `permissions rule add tools=a,b pattern=.. action=allow|ask|deny [severity=..] [desc=..]`, `permissions rule update <id> key=value…`, `permissions rule delete <id> confirm`; `permissions set-all tool=allow|ask|deny … confirm` (`permissions.tools.set` — **replaces** the user overlay; prefer `permissions set` for one tool); `mcp cancel <name>` (`mcp.cancel_connect`, idempotent); `marketplace toggle <name> on|off`; `extensions toggle <name> on|off`; `projects rename <id> <name>`, `projects pin <id> [on|off]` (the default project refuses both); `continue-queued` (`session.message.continue_queued`); `swarm-stop [run_id]`; `doc persist <host path>`; `media discard <uploads path> confirm`.

Feature detection: the first `unknown method` for a Gateway method is cached per Gateway URL; that subcommand then soft-fails with *not available on this Gateway* and is hidden from `/jiuwen help`. `ctx.jiuwenAdapter.gateway.supports(method)` probes once; `gateway.unsupported()` lists the cache. On 0.2.7 only `schedule.*` is affected.

Registration fails soft: the `commands.register` call runs inside a try/catch **inside** the inject callback, so a duplicate `/jiuwen` (another plugin) only logs a warning. Use `commandName` to pick another name.

### 5b. SwarmFlow

- Host abort during a SwarmFlow run: `chat.interrupt` **and** `swarmflow.stop {session_id, run_id}` (last run id seen on that Jiuwen session; `swarmflowStopOnAbort`).
- SwarmFlow human turns (`chat.ask_user_question` with `source: swarmflow_human`) → `ctx.approval.request({ toolName: 'swarmflow:<agent>', reason: <prompt> })`; `allowed-once` → `chat.swarmflow_reply {run_id, correlation_id, answer: 'approved'}`, anything else (no UI, no agent, timeout) → `answer: 'rejected (…)'`. Never fails open.

### 5c. Opt-in bridges (default OFF)

| Flag | DSH side | Jiuwen side | Scope |
|---|---|---|---|
| `modelDiscovery` | `listModels` + `llm.registerModelDiscovery('jiuwen')` | `models.list` → ids `jiuwen-model:<model_name>` (routed as `model_name`) | own provider only |
| `sessionSync` (default on) | `session/created`, `session/disposed` | local mapping upkeep (no Gateway create/delete) | sessions whose header provider is `jiuwen` or that already have a mapping |
| `planBridge` (default on) | `ctx.planMode.set(agent, active)` | `session.plan_status.in_plan` after turn completion / plan events | jiuwen sessions with a live agent |
| `hostSync` (default on) | skills, title, workDir, plan, model, goal, delete, fork, pause, … | full host→Jiuwen forward ([host-sync.md](./host-sync.md)) | jiuwen sessions only |
| `typedEvents` | `jiuwen/tool`, `jiuwen/plan`, `jiuwen/approval`, `jiuwen/swarm` | derived from `jiuwen/event` | jiuwen turns only |
| `documentPersist` | file blocks / `attachments` | `document.persist` before `chat.send` | jiuwen turns only |

Goal sync (`syncGoal`, default on): host `goal/changed` → Jiuwen `command.goal` for jiuwen sessions. DSH goal *rounds* still run on the host; Jiuwen gets the objective/pause/clear. See [host-sync.md](./host-sync.md).

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

With `typedEvents: true` the same activity is also emitted as `jiuwen/tool` (tool_call/update/result), `jiuwen/approval` (ask_user / interaction_answered, `kind: question|approval|swarmflow`), `jiuwen/plan` (`{type:'plan', event, inPlan?, status?}`) and `jiuwen/swarm` (`{type:'swarm', event, runId?, summary?}`), all declared in `index.d.ts`.

All events carry `dshSessionId`, `sessionId` (Jiuwen) and `requestId`; `raw` is the untouched Jiuwen payload (owned by JiuwenSwarm, may change). Live check: a co-loaded plugin's `ctx.on('jiuwen/event')` received events with `dshSessionId` (used by the command test in §5).


## 7. Compatibility guarantees

- **Same behaviour with and without jiuwen.** `scripts/compat-runtime.mjs` runs the full dsh agent runtime through a scripted session twice, once with jiuwen loaded and once without. The session covers approvals, user-questions, tool calls, commands, `/plan` with `exit_plan_mode`, `/goal` rounds, automatic and manual compaction, an in-process subagent, and bash in a temp sandbox. `scripts/compat-matrix.mjs --diff` requires every row to match. CI runs it on dsh 0.2.1-rc.2 and 0.2.1-rc.5 ([log](./known-issues.md#15-round-8-full-runtime-scenarios--version-matrix)).
- **Fail soft.** Missing host services such as `commands`, `approval`, `userQuestions` and `attachments` are detected, not required. A `/jiuwen` name clash only logs a warning. Bad config only warns ([validation](./configuration.md#validation)).
- **No global side effects.** The matrix checks globals, env, prototypes, process listeners, unhandled rejections and the provider list after dispose.
- **Supported range.** dsh `>=0.2.1-rc.2 <0.3.0` (`engines.dsh`), Cordis `^4.0.5`, Node `>=22`. dsh-llm is an optional peer.
