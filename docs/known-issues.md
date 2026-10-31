# Known issues (JiuwenSwarm side)

## 1. Jiuwen worker spins at 100 % CPU after an MCP server disappears

**Status:** JiuwenSwarm / openjiuwen bug (upstream). Adapter mitigation: stable stdio proxy for `toolPassthrough: mcp` (see [dsh-integration.md §3](./dsh-integration.md#3-dsh-tools--jiuwen-opt-in-mcp-passthrough--experimental)).

**Environment:** JiuwenSwarm (local checkout, 2026-10), openjiuwen `StreamableHttpClient`, `mcp` 1.29.0, `anyio` 4.13.0, Python 3.12.

**Repro (no dsh needed):**
1. Start any streamable-http MCP server on 127.0.0.1 (one tool).
2. `mcp.register_custom {name, transport: "streamable-http", url}` + `mcp.connect {name}` via the gateway WS.
3. Optionally run a `chat.send` with `mcp: [name]` that calls the tool (works).
4. Kill the MCP server process.
5. `mcp.disconnect {name}` (or re-register the same name, or let a session that leased the server end).
6. Watch the agentserver worker (`jiuwenswarm.server.worker.main`): idle CPU goes from ~0 to ~100 % and stays there (measured 800 ticks / 8 s at CLK_TCK 100, before: 1–3). Every later turn gets 2–4 s slower before the model call (`SkillUseRail` 1.3–2.0 s, `SessionMessagingRouteRail` ~1 s in `runner.log` RailChain lines). The worker ignores SIGTERM.

Control: the same `mcp.disconnect` while the server is still alive returns in 8 ms and the worker stays idle (1–2 ticks / 8 s). A long-lived server used by 3 sessions in a row: no spin.

**Evidence (py-spy 0.4, 8 s, `record -f raw`):** ~60–70 % of event-loop samples in `anyio/_backends/_asyncio.py:_deliver_cancellation`; `dump --locals` shows several `CancelScope` objects in it with `should_retry: True`, i.e. the scope keeps rescheduling itself via `call_soon` because its host task never acknowledges the cancellation.

**Likely cause:** `StreamableHttpClient.connect()` enters `streamablehttp_client` / `ClientSession` (anyio task groups) on an `AsyncExitStack` inside the task that handled `mcp.connect` (each gateway RPC runs in its own task), while `disconnect()` / lease `close()` run `exit_stack.aclose()` in a different task (`interface_deep._safe_remove_mcp_server` deliberately uses `asyncio.create_task`). When the HTTP peer is gone, the transport's task group is cancelled from a foreign task; anyio's cancel scope can never deliver to its (finished) host task and retries forever.

**Suggested upstream fix:** own each MCP client in a dedicated long-lived task (start/stop via an event, e.g. `anyio.create_task_group()` in one runner task per client) so enter and exit happen in the same task; bound `aclose()` with a timeout and abandon the client instead of retrying cancellation.

**Recovery:** restart the JiuwenSwarm agentserver (kill the worker; `kill -9` if it ignores SIGTERM) and the gateway (it does not reconnect to a new agentserver on its own).

## 2. Latency outliers are upstream model time

30 + 30 alternating pongs (2026-10-30 07:04–07:08 UTC+8): A median 4.21 s (max 5.23 s), C median 3.55 s (max 4.78 s); no outliers. The 9–18 s outliers of 2026-10-29 23:16–23:40 were all a **single** LLM call (no `llm_call_error`, no retry) taking 9.0–17.5 s; Jiuwen time from user message to `llm_call_start` was 0.25–0.56 s; output 24–64 tokens; both A and C (no dsh) were affected. Nothing adapter-side.

## 3. Live Gateway RPC probe (ws://127.0.0.1:19000/ws, 2026-10-30)

Non-destructive unary probe against the local Jiuwen Gateway (AgentServer :18092). Throwaway `session.create` only; no goals / no prod deletes.

| Method | Result |
|---|---|
| `session.create` | ok |
| `session.plan_status` | ok (`in_plan=false`) |
| `command.btw` | ok (`status=ok`, returns `answer`) |
| `command.recap` | **FAIL** — Gateway: `unknown method: command.recap` (AgentServer may implement it; this Gateway build does not route it) |
| `team.templates.list` | ok |
| `team.list` | ok |
| `skills.installed` | ok (payload key `plugins`) |
| `skills.list` | ok |

Adapter still exposes `/jiuwen recap` → `command.recap`; expect an error text until the Gateway build registers the method.


## 4. Second-batch probe: TUI-only methods (2026-10-30)

Probed for the `/jiuwen tools|hooks|permissions|plugins|projects|archived|assets|version|heartbeat` batch. All ten backing RPCs returned ok on `ws://127.0.0.1:19000/ws` (Gateway 0.2.5b1).

These exist in `ReqMethod` and AgentServer but the Gateway **web** channel does not route them (`unknown method: …`); they are registered only for the `/tui` channel (`gateway/channel_manager/tui/tui_connect.py`). They are therefore **not** exposed as subcommands:

| Method | Result on /ws |
|---|---|
| `memory.list`, `memory.status` | FAIL — unknown method |
| `schedule.list`, `schedule.status` (and create/run/delete) | FAIL — unknown method |
| `command.context`, `command.status` | FAIL — unknown method |
| `session.preview`, `diagnosis.list` | FAIL — unknown method |
| `models.get` (no `model_id`) | FAIL — `unknown model_id ''` (needs an id; `/jiuwen models` already covers listing) |

Note: `project.list` returns two projects both named 默认项目 (`default` work mode and `default_code` code mode); `/jiuwen projects` prints `project_id` and `work_mode` to disambiguate (and dedupes exact `project_id` repeats). The `memoryList/memoryStatus` gateway helpers remain for builds that route them.


## 5. Third-batch probe: mutate + high-value reads (2026-10-30)

Probed for archive/unarchive, plugins enable/disable, permissions tools update/delete, heartbeat set/jobs, project info/sessions, session.switch, models.get, path/locale/commands/templates/cron. All answered on `ws://127.0.0.1:19000/ws` (Gateway 0.2.5b1).

| Method | Result on /ws |
|---|---|
| `session.archive` / `session.unarchive` | ok — params use **`session_ids`** (array), not `session_id` |
| `session.switch` | ok |
| `plugins.enable` / `plugins.disable` | ok — params use **`name`** |
| `permissions.tools.update` | ok — `{tool, level}` (`allow`/`ask`/`deny`) |
| `permissions.tools.delete` | ok — `{tool}` |
| `heartbeat.set_conf` / `heartbeat.job.list` | ok |
| `project.info` / `project.get_sessions` | ok |
| `models.get` | ok when given `model_id` (e.g. `mdl_default_primary` from `models.list`); `model_name` alone fails |
| `path.get` / `locale.get_conf` / `commands.list` / `agent_templates.list` / `cron.job.list` | ok |
| `session.preview` / `diagnosis.list` / `command.recap` / `memory.list` | still FAIL — unknown method (unchanged from §3–4) |

Adapter exposes `/jiuwen archive|unarchive|switch|model-info|path|locale|commands|templates|cron` plus expansions of `permissions` / `plugins` / `heartbeat` / `projects`. Live probes that mutate must reverse (unarchive/delete throwaway sessions; restore heartbeat; unset probe tools; re-enable plugins).


## 6. Fourth-batch probe: updater / agent / skill detail / marketplaces / bindings (2026-10-30)

Re-scanned gateway handler tables (`gateway/channel_manager/web/app_web_handlers.py`, `tui/tui_connect.py`) and probed `ws://127.0.0.1:19000/ws` (Gateway 0.2.5b1).

| Method | Result on /ws |
|---|---|
| `updater.get_status` / `updater.check` / `updater.get_conf` | ok (check contacts the release source; read-only) |
| `agents.get` | ok with `{name}`; unknown name → `Agent 不存在: <name>` |
| `skills.get` / `skills.versions.list` | ok with `{name}` (versions list needs `name`) |
| `skills.marketplace.list` / `team.bindings.list` / `team.templates.list` | ok |
| `session.get`, `session.color_set`, `session.preview` | FAIL — unknown method on /ws (TUI-only handlers) |
| `agent_templates.show` | needs `asset_id`; not exposed |

Deliberately not exposed (non-trivially reversible or side-effectful): `updater.download/upgrade`, `skills.install/uninstall`, `skills.marketplace.add/remove`, `agents.create/delete`, `team.delete`, `session.rewind*`, `assets.publish.*`.
UX: `/jiuwen help` groups subcommands; errors are `Jiuwen: <msg>` plus a hint for unknown methods, timeouts and connection failures. Live probe cleaned up the leftover empty `probe-1793340702422` session.

## 7. Re-probe after upgrading to JiuwenSwarm 0.2.7 (2026-10-30)

Upgraded the box from the 0.2.5b1 source checkout to the official `workswarm-0.2.7` wheel (GitHub release asset; PyPI has no 0.2.7 and gitcode returns HTTP 418 from this box) in a separate uv venv. Same ports (Gateway :19000, AgentServer :18092), same `~/.jiuwenswarm` config, model `doubao-seed-2.0-mini`. `updater.get_status` → `current_version: 0.2.7`, `/jiuwen version` → `JiuwenSwarm 0.2.7 (pip, linux)`.

| Method on `/ws` | 0.2.7 |
|---|---|
| `memory.list`, `memory.status` | still FAIL — unknown method |
| `schedule.list`, `schedule.status` | still FAIL — unknown method |
| `command.context`, `command.status`, `command.recap` | still FAIL — unknown method |
| `session.preview`, `session.get`, `diagnosis.list` | still FAIL — unknown method |

No previously unknown method started working.

Regressions compared with 0.2.5b1 (Gateway-side). Status after the adapter fix below:

| Adapter surface | 0.2.7 behaviour |
|---|---|
| `/jiuwen assets` (`session.assets.list`) | Unknown method. Neither the web handler table (`app_web_handlers.py`) nor the `/ws` routes have a replacement (`files.list` is sandbox-only and also unknown on /ws). **Fixed:** degrades to a clear "not available on this Gateway" message (still uses `session.assets.list` on 0.2.5b1). |
| `/jiuwen teams` (`team.list`) | `team.list` is unknown. **Fixed:** falls back to `team.bindings.list` (`{teams:[{team_name}]}`) when `team.list` is unknown. Templates still come from `team.templates.list`. |
| `/jiuwen model-info` | `models.list` entries are now `{model_name, alias, origin_index, is_default, model_provider, api_base, endpoint_profile, context_window_tokens, api_key}` with no `model_id`, and `models.get` is gone from the web table. **Fixed:** matches on model_id, model_name, id, name, alias, or `#<origin_index>` (exact match first, then case-insensitive). It calls `models.get` only when a `model_id` exists; otherwise it renders from the list entry. `api_key` is reduced to set/missing and never printed. |

Everything else passed live: `npm test` 58/58, `smoke:live` 13/13, the other `/jiuwen` read subcommands, ask_user resume, MCP stdio-proxy passthrough, `jiuwen/event` streaming, per-turn model/chatMode/skills overrides, local title + `session.rename`, and `local+jiuwen` compaction (`command.compact`).

Observation: MCP passthrough serves tools that Jiuwen discovered at prewarm (`working_directory`). A tool name added later was not visible to `tool_search` on the same turn.

Live after the fix (:19000, 0.2.7): `assets` gives the degrade message; `teams` gives `templates: jiuwen_team`, `teams: none` (via `team.bindings.list`); `model-info doubao-seed-2.0-mini` gives provider/api_base/profile/context=262144/default/api_key=set. The mock gateway has a 0.2.7 shape (`JIUWEN_GATEWAY_MOCK_SHAPE=0.2.7` or `debug.set_shape`), and a test covers it.

## 8. P1–P3 mapping probe on 0.2.7 (2026-10-30, UTC+8)

| Method | 0.2.7 `/ws` | Notes |
|---|---|---|
| `config.get` | OK | returns `api_key: "[REDACTED]"` already; adapter masks every secret-looking key again |
| `mcp.show` | OK | needs the SkillHub asset **id** (`{id}`), not the name — adapter resolves name → id via `mcp.list` |
| `agent_templates.show`, `agent_groups.show` | OK | param is `{id}`; the error text says `asset_id is required` but `asset_id`/`assetId` are not accepted |
| `skills.retrieval.search`, `skills.online_search.search`, `memory.forbidden.get`, `personal_context.*` reads, `cron.job.meta/get/preview`, `heartbeat.job.meta`, `team.history.get`, `team.snapshot`, `agent_groups.list`, `document.formats`, `permissions.approval_overrides.get`, `permissions.owner_scopes.get` | OK | |
| `project.git.status`, `project.git.diff_status` | routed | `git operations not available for this project` when the project has git disabled (default project here) |
| `models.validate`, `config.validate_model` | routed | require `api_key` for non-OAuth providers; the adapter never passes keys, so on this box it reports Jiuwen's validation error |
| `schedule.*` (7) | **unknown method** | listed in the web forward tables but not routed; feature-detected → hidden |
| `cron.job.create/toggle/delete` | OK | cron expressions are normalised to 7 fields (`0 3 1 1 *` → `0 0 3 1 1 * *`); live probe job created disabled, toggled on/off, deleted |
| `permissions.rules.create/update/delete` | OK | probe rule `dsh-probe-*` created → updated → deleted (rules 37 → 38 → 37) |
| `session.message.continue_queued` | routed | `Session was not found` for a session that never ran a turn |
| `swarmflow.stop` | routed | `工作流控制不可用…` when no team/workflow is awake |
| `document.persist` | OK | local `path` items are validated and referenced in place (not copied); base64 items land in `sessions/<id>/uploads/` |
| `media.discard` | OK | `{deleted: true}` for an uploads path; paths outside the session uploads dir are rejected by AgentServer |
| `session.create` | OK | ignores a caller-provided `session_id` (always returns `web_…`) — why `sessionSync` does not pre-create Jiuwen sessions |
| `cron.job.run_now`, `heartbeat.job.run_now/cancel` | OK (live, §9) | throwaway disabled jobs: cron run → `run <id>:<ts>`; heartbeat run → `status: running` → cancel → `disabled`; both deleted |

## 9. Full live run through the real Cordis host (2026-10-30, UTC+8)

Real `@deepseek-ai/cordis` Context + `dsh-llm` LlmRuntime + `dsh-commands` CommandRuntime (`commands.execute('/jiuwen …')`), JiuwenSwarm 0.2.7 on :19000, model doubao-seed-2.0-mini. Every `/jiuwen` subcommand/variant, chat flows and each P3 flag were run; state (cron, heartbeat conf/jobs, permission tools/rules/overrides, plugins, skills, archived, sessions) was snapshotted before and verified identical after; 28 throwaway sessions deleted.

**Adapter bugs found and fixed**

| Symptom | Cause | Fix |
|---|---|---|
| `/jiuwen history` always "No history" | 0.2.7 `history.get` only acks `{accepted:true}` and streams the page as `history.message` events (`page_idx` 1-based, newest first, `_part` splits, final `{status:'done'}`); `history.list_turns` is unknown | `GatewayTransport.historyMessages()` collects/reassembles one page; `/jiuwen history` uses it; `api.gateway.historyMessages(sid)` |
| `/jiuwen fork` → `source_session_id is required` | AgentServer 0.2.7 reads `source_session_id` | send both `session_id` and `source_session_id` |
| `heartbeat job/preview/toggle/run/cancel/delete` → `job belongs to another session`; `heartbeat jobs` empty | heartbeat jobs are session-scoped; the connection session comes from `params.session_id` | pass the mapped Jiuwen `session_id` on every heartbeat job RPC |
| planBridge never synced | turns end on the terminal `chat.final` grace, before `processing_status{is_complete}` | adapter emits `{type:'turn_end'}`; planBridge syncs on it |
| documentPersist never fired under real dsh | `dsh-llm` ≥0.2 projects every `file` block into handle text (`[File "x" (N bytes, sha256:…): verbatim read-only copy saved at "<path>"…]`) before the adapter sees it | with `documentPersist` on, file handles in the last user message become document items → `document.persist` |
| `/jiuwen team history` printed raw JSON | 0.2.7 records carry empty `content` for tool/team events | readable `[member] 🔧 tool` / `↳ tool ok` / `event` lines |

**Gateway-side / environment limits (not adapter bugs)**

- `permission_interrupt` is not triggerable on this install: with `permissions set bash ask` *and* `deny`, bash still ran without an interrupt (tool-level permissions are not enforced for the web channel agent here). The approval → `ctx.approval.request` path stays covered by mock tests; `ask_user_interrupt` → `ctx.userQuestions.ask` passed live.
- SwarmFlow: a team (`/jiuwen mode team.work.normal`) wakes and runs (team history/snapshot OK) but emits no SwarmFlow `run_id`; `swarmflow.stop` answers `工作流控制不可用，发送一条消息唤醒团队后即可使用。` once the team is idle, so abort→`swarmflow.stop` cannot be exercised live. Host abort → `chat.interrupt` passed.
- Legacy chat modes (`agent.fast`, `code.normal`) are normalised by Jiuwen to `agent`; use canonical modes (`agent.code.normal`, `team.work.normal`, …) for per-session overrides — `agent.code.normal` is recorded in `session.get_metadata`.
- MCP passthrough serves tools Jiuwen saw at AgentServer prewarm (`working_directory` passed live, approval-gated); a brand-new tool name is still invisible to `tool_search` across turns and reconnects until AgentServer restarts.
- `git status|diff` → `git operations not available for this project` (default project has no git). `models validate` needs an `api_key`, which the adapter refuses to pass. `schedule.*`, `command.recap`, `session.assets.list` remain unrouted (soft-fail).
- `mode=openai` (path C fallback) has no live target: port 18092 is the AgentServer WebSocket, not an OpenAI-compatible HTTP server.
- ~~`/jiuwen delete` deletes without a trailing `confirm`~~ — fixed in round 2 (§10): `/jiuwen delete confirm`.

## 10. Round 2 live edge tests (2026-10-30, UTC+8)

Same real Cordis host (`Context` + `dsh-llm` + `dsh-commands`), JiuwenSwarm 0.2.7, doubao-seed-2.0-mini. 105 bad/missing-argument variants of every subcommand (usage text or a clean `Jiuwen: "<gateway error>"`; no throw, no stack trace, no `[object Object]`), unicode/Chinese + emoji (turn, rename, status title, history), 30 k-char input, 5 k-char rename, 3 concurrent sessions (0/193 cross-session events), abort after 2.5 s and after 300 ms then a new turn, 4 s turn timeout (`TIMEOUT`, next turn fine), Gateway restart mid-stream (`TRANSPORT: Gateway WebSocket closed`, then command + turn reconnect), image attachment (base64 PNG → "red"), `compactionMode: local+jiuwen` (local digest + `command.compact` ok), mapping persistence across plugin dispose + reload, two instances (`jiuwen-a`/`/jwa`, `jiuwen-b`/`/jwb`) concurrently, all P3 flags on for 6 turns incl. a bash tool call, `api_key` values grepped in every output/log (0 hits). Gateway state snapshot before/after identical (MCP list differs only in presigned icon URLs).

**Adapter bugs found and fixed**

| Symptom | Cause | Fix |
|---|---|---|
| `/jiuwen mcp-reset` then a passthrough turn in the same process never re-registered `dsh-tools` (`mcp.show` → `SkillHub asset not found`) | the bridge cached its first `prepare()` result; only new tool names triggered `ensureRegistered` | `unregister()` marks the bridge dirty; the next `prepare()` re-registers the identical stdio proxy (`register_custom` + `connect`; same command/args/timeout_s; Jiuwen `state.json` record byte-identical) |
| after a reconnect the proxy listed tools of long-dead dsh processes (a stale tool from an earlier run resurfaced) | `schemas.json` union never pruned | union keeps only names advertised by live `ep-<pid>.json` files |
| `/jiuwen mcp-reset` and `/jiuwen delete` ran without confirmation | — | both require a trailing `confirm` (`unmap` stays local and confirm-free) |
| `/jiuwen workflows get <id>` → `unknown action: get` | 0.2.7 names it `get_workflow` | send `get_workflow`, fall back to `get` on older builds |
| `/jiuwen delete confirm` on a never-used mapping → `session not found`, local mapping left behind | delete threw before clearing the mapping | on `session not found` the mapping is still cleared and reported |
| `/jiuwen document bogus` → `Unknown subcommand "document"` | ext returned `null` | prints `document formats` usage |

**Expected / gateway-side**

- Lookups of non-existent ids/names (`cron get`, `heartbeat job`, `skill-info`, `agent`, `mcp show`, `template/group show`, `projects sessions`) surface Jiuwen's own message (often Chinese, e.g. `未找到 skill`); `fork`/`continue-queued` on a session with no turns → `source session not found` / `Session was not found` (the Jiuwen session is created lazily on the first turn).
- `media discard /etc/passwd confirm` → `path is outside session uploads` (Gateway guard).
- Gateway restart mid-stream ends the turn with `TRANSPORT`; the in-flight answer is lost (Jiuwen does not resume a turn on a new socket); the next command/turn reconnects transparently. Verified live 2026-10-31 (`scripts/live-drop-recovery.mjs` 9/9).
- `/jiuwen rename` accepts very long titles (5000 chars) — Jiuwen stores them as is.

## 11. Round 3 live hunt + fixes (2026-10-30, UTC+8)

Same Cordis host pattern (`Context` + `dsh-llm` + command handlers), JiuwenSwarm 0.2.7 on :19000, model doubao-seed-2.0-mini. Gateway state snapshotted before/after (20 sessions, 0 cron, 0 heartbeat jobs, 37 permission rules, 43 tool overrides, heartbeat conf unchanged). Throwaways cleaned; state restored identical.

**Adapter bugs found and fixed**

| Symptom | Cause | Fix |
|---|---|---|
| Slash errors looked like `Jiuwen: "未找到 skill"` / `Jiuwen: "Agent 不存在"` (extra quotes); objects risked `[object Object]` | `_unary` / stream paths used `JSON.stringify` on Gateway `frame.error` even when it was already a string | `formatGatewayError()` unwraps JSON-string layers and object `.message`/`.error`/`.detail`; used on all Gateway error paths + command handler |
| Corrupt `mappingPath` JSON crashed plugin load | `SessionStore._load` threw on parse failure | Soft-fail: empty store + `loadError`; next save rewrites the file |
| Mid-stream Gateway close message was opaque (`Gateway WebSocket closed`) | Bare TRANSPORT text | Message now says in-flight answer is lost and the next user message reconnects |
| `/jiuwen continue-queued` on a never-used mapping → hard error `Session was not found` | Session is created lazily on first turn | Soft-fail success text explaining no queue / reconnect via next message |
| `/jiuwen swarm-stop` when team idle → hard error with Chinese Gateway text | Expected upstream idle state | Soft-fail success text (`no active SwarmFlow`) keeping the Gateway message |
| `cron create` with 5- or 6-field exprs failed (`must have 5 or 7 fields`) | Docs claimed normalisation but the adapter never padded | `normalizeCronExpr()` pads 5→7 (`0 … *`) and 6→7 (prepend `0`); applied on create + update |

**Also mapped (safe reversible writes, Round 3 hunt list)**

| Surface | RPC |
|---|---|
| `/jiuwen heartbeat create name=… prompt="…" [every=…] [enabled=off]` | `heartbeat.job.create` with `schedule: {type:'interval', interval_seconds}` (created disabled by default) |
| `/jiuwen cron update <id> key=value…` | `cron.job.update` `{id, patch}` |

**Still Gateway / environment limits (unchanged)**

- Mid-stream Gateway restart loses the in-flight answer (TRANSPORT); next turn reconnects cleanly (verified).
- Nonexistent id lookups return Jiuwen’s own message (often Chinese); now consistently prefixed `Jiuwen: …` without quotes.
- Tool permissions (ask/deny) not enforced on the web-channel agent here.
- `swarmflow.stop` has no `run_id` when the team is idle (adapter soft-fails clearly).
- Unknown on /ws: `memory.*`, `schedule.*`, `command.recap/context/status`, `session.preview/get`, `diagnosis.list`, `session.assets.list`, `team.list`, `history.list_turns`, `models.get`, `files.list`.
- Git disabled on the default project; `models.validate` needs `api_key` (adapter never passes).
- MCP: tools discovered only at AgentServer prewarm; new names invisible until AS restart.
- `mode=openai` has no live HTTP target on :18092.
- `permissions.rules.restore` / `permissions.snapshot.restore` are unknown on /ws — not exposed.
- `heartbeat.job.update` is routed but not mapped (create/toggle/run/cancel/delete cover the lifecycle).

**Tests:** 102 → 112, all green. Secret grep on live outputs/logs: no raw `api_key` / `sk-…` leaks.

## 12. Round 4 safe reads mapping (2026-10-30, UTC+8)

Cordis host (`Context` + `dsh-llm` + `api.command`), JiuwenSwarm 0.2.7 on :19000, doubao-seed-2.0-mini. Snapshot before/after identical (20 sessions, 0 cron, 43 tool overrides, 37 permission rules, heartbeat conf, empty `user_permissions.yaml`). Live: 26 ok + 6 expected soft-fails + 0 hard fails; heartbeat create→update→delete reversed.

**New `/jiuwen` surfaces → `/ws` methods**

| Surface | RPC |
|---|---|
| `skills files <name> [path]` | `skills.files.list` / `skills.files.get` |
| `skills retrieval [status\|tree]` | `skills.retrieval.status` / `skills.retrieval.tree` |
| `skills graph [status\|get]` | `skills.graph.status` / `skills.graph.get` |
| `skills evolution <name> [status\|get]` | `skills.evolution.status` / `skills.evolution.get` |
| `skills experience` | `skills.experience.list` |
| `template files <id> [path]` / `group files <id> [path]` | `agent_templates.file.*` / `agent_groups.file.*` |
| `packages [list\|show]` | `plugin_packages.list` / `show` |
| `extensions` | `extensions.list` |
| `vendors [list\|models <key> <plan>]` | `vendors.list` / `vendors.fetch_models` (never passes `api_key`) |
| `openai [auth\|models]` | `openai_account.auth.status` / `openai_account.models.list` |
| `health` | `health_check.get_conf` |
| `projects pinned\|cron` | `project.pinned_sessions` / `project.get_cron_sessions` |
| `git probe\|turns\|turn <id>` (+ soft-fail on status/diff) | `project.git.probe` / `turn_diff_list` / `turn_diff` |
| `publish …` (read-only) | `assets.publish.describe\|status\|records\|local_status` |
| `mcp cancel <name>` | `mcp.cancel_connect` |
| `permissions set-all … confirm` | `permissions.tools.set` (bulk user-overlay replace; distinct from `update`) |
| `heartbeat update <id>` | `heartbeat.job.update` |

**Live soft-fails (expected, not adapter bugs)**

- `skills retrieval tree` → Gateway `unsupported` / `tree_supported=false`.
- `skills graph get` → graph artifact missing until built in UI.
- `git *` on default project → `git operations not available for this project` (soft-failed text).
- `publish describe|status|records` → `AUTH_REQUIRED` without Hub login; `local` → `RESOURCE_NOT_FOUND` for unknown ids.
- `vendors models` without a stored key → `source=preset` fallback (adapter never sends `api_key`).

**Not mapped on purpose**

- `mcp.wait_auth` — holds the RPC open for minutes (browser OAuth poll); use the Jiuwen UI.
- Irreversible / credential / P4 voice / UI channels remain excluded.

**Coverage / tests:** covered 106→138 / 334 (safe 45.1%→58.7%). Unit tests 112→118.

### 12a. Round 5: remaining safe reads + full regression (2026-10-30, UTC+8)

Added `channels` / `channels conf <name>` (`channel.get`, `channel.*.get_conf`; `app_secret`, `encrypt_key`, `*_token`, `webhook_url` masked), `rsi …` (8 reads), `context …` (5 personal-context reads), `issues` (wired; `issue.*` unknown on 0.2.7 → soft-fail, hidden from help once both methods are probed), `harness packages` (soft-fails without a GitCode token), `skills hub …` (TeamSkillsHub / SwarmSkillsHub / SkillNet / ClawHub search/detail/recommend/info; nothing installed), `marketplace toggle`, `extensions toggle`, `projects rename|pin`.

Full regression through the Cordis host: every `/jiuwen` subcommand (148 checks incl. usage paths and reversible writes: rename/pin/archive, skill-toggle, marketplace toggle, permissions set/unset, cron and heartbeat create→update→delete, permission rule add→update→delete, fork + cleanup, delete confirm) plus a live chat turn (`r5-pong`). 14 checks returned Gateway errors, all expected and rendered as clean `Jiuwen: …` text. Gateway state before/after byte-identical (sessions, cron, heartbeat conf, tool overrides, rules, projects, marketplaces, extensions, plugins, skill enablement, archived, `user_permissions.yaml`).

**Fixed:** the `/jiuwen` command `description` and `input.hint` listed only the built-in subcommands; they are now generated from the extension table, so host UIs/autocomplete show every extended subcommand.

**Gateway-side (not adapter bugs):** the default project cannot be renamed or pinned; `/jiuwen fork` prints the full new session id (the live script truncated it when matching, so the throwaway fork was cleaned by hand).

**Coverage / tests:** covered 138→172 / 334 (safe 58.7%→73.2%). Unit tests 118→124.

## 13. Round 6: plugin compatibility first (2026-10-30, UTC+8)

**Priority:** compatibility with other dsh plugins. See dsh-integration.md §7 for the guarantees and how they are checked.

**Compat matrix** (real Cordis host with 21 real dsh plugins, A/B against no adapter):

| Run | Non-jiuwen identical | Services | Events | Globals/proto/env/process | Dispose leaks | Gateway down |
|---|---|---|---|---|---|---|
| adapter after others (live) | yes | unchanged | none extra | clean | none | n/a |
| adapter before others (live) | yes | unchanged | none extra | clean | none | n/a |
| two instances (live) | yes | unchanged | none extra | clean | none | n/a |
| down, after / before / two / two+before | yes | unchanged | none extra | clean | none | soft (`finish: error`, `/jiuwen` text) |

**Fixed:** the opt-in MCP bridge added a `process.once('exit')` listener and never removed it, so each prepare/dispose cycle leaked one global listener. `dispose()` now detaches it. A regression test plus a static scan of `src/` for env, global, prototype and process-listener writes guard against this.

**Stress:** see dsh-integration.md §7, mock and live. Gateway state was byte-identical afterwards.

**Create mappings skipped (not reversible byte-identically, so they risk other plugins' or users' state):**
- `project.create`: `project.remove` only hides the project, so a permanent record remains.
- `agents.create`: defaults to an LLM `generate` step and edits `config.yaml`.
- `agent_templates` / `agent_groups` / `plugin_packages` create: these write package directories, and their rollbacks (delete/uninstall) are excluded.
- `team.binding` create/generate: needs `team.delete` as its rollback, which is out of scope.

**Harness notes:** only `/compact` is active among the host commands without a full agent runtime. `commands.execute` needs a real agent, so the probe compares the registry instead.

## 14. Round 7: full agent runtime A/B (2026-10-30, UTC+8)

A real dsh agent runtime (dsh-agent + dsh-agent-loop and 25 more real plugins) runs a scripted non-jiuwen agent through approval, tools, ask-user, MCP, retry, `/goal`, `/plan`, `/compact`, title and token meter, with and without the adapter. See dsh-integration.md §7a.

| Feature | mock/mixed | down/after | down/before | down/two | down/mixed | live/after | live/mixed | live/two+before+mixed |
|---|---|---|---|---|---|---|---|---|
| Session events (normalized hash) | = | = | = | = | = | = | = | = |
| Approval approve + deny | = | = | = | = | = | = | = | = |
| Tool calls (todo, guarded, ask-user, MCP echo) | = | = | = | = | = | = | = | = |
| Ask-user answers | = | = | = | = | = | = | = | = |
| `commands.execute` (/goal, /plan, /compact, unknown) | = | = | = | = | = | = | = | = |
| Agent tool list / command list (minus `jiuwen`) | = | = | = | = | = | = | = | = |
| Session title, token meter | = | = | = | = | = | = | = | = |
| Host event names and counts (non-jiuwen) | = | = | = | = | = | = | = | = |
| Providers after dispose | = | = | = | = | = | = | = | = |
| Globals, env, prototypes, process listeners | = | = | = | = | = | = | = | = |
| Unhandled rejections, load failures | none | none | none | none | none | none | none | none |

`=` means byte-identical to the run without the adapter. In the mixed runs, the concurrent jiuwen agent (driven by dsh-agent-loop) answered `mixed-ok` live, and with the Gateway down it retried and closed its turn. The Gateway state was byte-identical afterwards.

**Fixed:** in the real agent loop, user messages carry no `role` (only `source.kind: 'user'`). Every role check in the adapter missed them, so a jiuwen agent's query fell back to the dsh system prompt (live, the model replied about the `create_goal` rules). `stream()` now infers roles with `withInferredRoles`. Tests: unit tests, plus `mock/mixed` in the matrix, which fails without the fix.

**dsh-llm-deepseek:** this package is a library (it exports `DeepSeekAdapter` and `registerDeepSeekProvider`; it has no `apply` and no default export), so it cannot be loaded as a Cordis plugin. The plugin is `dsh-llm-deepseek-api-key`. It loads in the runtime with an unset `apiKeyEnv` (no key is ever passed) and registers `deepseek-official` next to `jiuwen`.

**Still not covered, and why:**
- Real DeepSeek model calls: they need an API key, which we never pass.
- Bash, fs and sandbox tools, subagents, workflows, jobs and schedule: these execute host side effects and are outside the sdk-minimal kernel.
- The Web/SDK/ACP front ends: these are transports over the same runtime.
- `/plan` approval through `exit_plan_mode`: plan mode is toggled by commands only.
- Goal rounds that actually run: `/goal` is paused or cleared before any round starts, to keep the run deterministic.
- Automatic token-pressure compaction: only `/compact` is exercised.


## 15. Round 8: full-runtime scenarios + version matrix (2026-10-30, UTC+8)

This round extended `scripts/compat-runtime.mjs` beyond the round-7 runtime with real scenarios:
- **Plan mode**: `/plan`, then `exit_plan_mode`, approved through the user-questions plan review.
- **Goal**: `/goal …` runs a real goal round, and the scripted model calls `get_goal` then `update_goal complete`.
- **Automatic compaction**: a small context window (1500) with realistic token usage triggers compaction-basic 8 times. There is also one manual `/compact`.
- **Subagent**: in-process spawn plus `wait`.
- **bash**: runs in a temp `danger-full-access` sandbox root.

Every row of `compat-matrix --diff` is identical with and without jiuwen (330 events, 28 types). This holds on both **dsh 0.2.1-rc.2 (cordis 4.0.5)** and **dsh 0.2.1-rc.5**, in the variants before, after, two adapters, mixed, and Gateway down. CI repeats the diff on both versions for every push.

Gateway drop: a TCP proxy cut the live 0.2.7 Gateway 2.5 s into a turn and again at 4 s. Both runs recovered the full answer from `history.get`, marked as recovered. The 4 s run was a continuation of the partial text. When history does not have the reply, the original error is surfaced (mock `drop-lost`).

dsh 0.2.2-alpha.* is outside the declared range: SemVer prereleases of 0.2.2 do not match `<0.3.0` with a `0.2.1-rc` floor unless they are included explicitly. It is untested because the box's disk ran out of inodes during installation.

CI note: GitHub runners showed a `session/flush` count difference of ±1, in a different variant on each run (`down/two` once, `down/before` once), and never locally across 16 parallel runs. dsh-session also fires this durability checkpoint on goal-round-driver idle timers, so the count depends on scheduling, not on which plugins are loaded. The strict host-event-count row now leaves it out, and a separate row checks that flush checkpoints still fire.
