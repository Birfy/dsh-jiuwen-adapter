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

