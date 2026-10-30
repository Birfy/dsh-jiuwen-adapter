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
