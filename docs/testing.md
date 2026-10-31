# Testing

## Layout

```
test/*.test.js            npm test: unit + in-process scenarios (mocks only; no network, no real Jiuwen)
test/helpers/mock-host.js mock-gateway on a random port + minimal Cordis-like host
test/fixtures/stand-in.mjs scripted OpenAI-compatible model (TAG/SLOW/REASON/HUGE/ERR500/ERRMID/TOOL:/MCP:)
bin/mock-gateway.mjs      Gateway mock; a query with TAG: emulates Jiuwen in front of the stand-in
test/live/run.mjs         npm run test:live (opt-in, real JiuwenSwarm)
test/live/plain-dsh.mjs   npm run test:plain-dsh (opt-in, real dsh web profiles, no FlyBot)
test/live/plain-dsh/driver test-only dsh plugin that drives host services in a real profile
test/live/lib.mjs         guards, stand-in launcher, Jiuwen snapshot + exact restore
```

`test/scenario-catalog.test.js` lists every scenario from the test rounds and fails if its test is missing.

## npm test (fast, deterministic)

| File | Covers |
|---|---|
| deep-pass | A 12-turn history · B reasoning · C tool calls · D 200 KB answer · E model 500 · F mid-stream drop · G cancel · J persona once/resend/full · K 6 concurrent · M bad port/URL/switches · L 200-turn leak · reload 3× |
| memory-plugins | AGENTS.md and session-reference context forwarded with the prompt, not resent; runtime/time context still stripped |
| plugin-compat-matrix | 12 plain-dsh plugin areas × 2 load orders: non-jiuwen untouched, Jiuwen read-back, listeners released |
| plain-dsh-web | the 8 bb9df82 fixes (dispose keep, scoped skills, cwd seed, schedule list, fork wait, scoped plan, single delete); `{{model}}` persona is in persona-generic |
| drop-recovery, gateway-drop-rpc | drop/reconnect, fast-fail RPCs |
| mcp-bridge | MCP verify, tools/call approval + execute, proxy lifecycle |
| edge-cases, host-sync*, persona-generic | edge cases, resume, rename/fork, ask_user (Other strip), persona generic/minimal/`{{model}}` |
| fuzz-gateway | adversarial frames |

## Opt-in live suites

Both skip (exit 0) unless `JIUWEN_LIVE=1` is set and the Gateway (`JIUWEN_GATEWAY_URL`, default `ws://127.0.0.1:19000/ws`) is reachable. They snapshot Jiuwen first: config bytes (in memory, never printed), sessions, heartbeat, permissions, skills, MCP, jobs, and the custom MCP records in `~/.jiuwenswarm/agent/workspace/mcp/state.json` (command, args, state, enabled; the dsh-tools proxy path depends on the dsh HOME). They restore it at the end and fail if anything differs.

```bash
JIUWEN_LIVE=1 \
JW_USE_STANDIN_CMD='<point Jiuwen model at http://127.0.0.1:18999/v1 and restart>' \
JW_RESTORE_CMD='<restore the original Jiuwen config and restart>' \
DSH_NM=<dsh node_modules> DSH_BIN=<dsh binary> \
GW_KILL='<kill gateway>' GW_START='<start gateway on the stand-in>' \
npm run test:live
```

| Step | Needs |
|---|---|
| live-gateway-smoke | `LIVE_SMOKE=1` and a working real model (it asks natural-language memory/tool questions) |
| live-deep (A–M, L, MCP tool_search invocation, ask_user card) | `JW_USE_STANDIN_CMD`/`JW_RESTORE_CMD` |
| compat-runtime `--sync --sync2 --reload` | + `DSH_NM` |
| live-drop-recovery | + `GW_KILL`/`GW_START` |
| plain-dsh profile matrix + memory-module plugins (`PLAIN_DSH_ONLY=plain\|mem`) | + `DSH_BIN` (also standalone: `npm run test:plain-dsh`) |

The stand-in (`test/fixtures/stand-in.mjs`) is started on `STANDIN_PORT` (18999) unless a server is already listening there. It logs to `STANDIN_LOG`.

## Other tools

| Command | What it covers | Requires |
|---|---|---|
| `npm test` | Unit + generic host + gateway features (112 tests as of Round 3). Includes plain chat, streaming, gateway tools, openai `tool_calls`, reasoning/structured events/usage/`processing_status` filtering, markers compat, session continuity, cancel → `chat.interrupt`, agent/mode/skills/model selection, multimodal `base64Data`/`attachments`, ask_user, local titles, runtime-context filtering, extended RPCs, Round 1–3 live-fix regressions | Node ≥ 22 |
| `npm run smoke` | mock-openai + mock-gateway end-to-end; session mapping persistence | none |
| `npm run smoke:cordis` | Real Cordis `Context` + `LlmRuntime` loads the plugin and streams (openai mock + gateway mock; checks LlmRuntime stream grammar) | global npm dsh install (or `DSH_NODE_MODULES` / `DSH_LLM_PATH` / `DSH_CORDIS_PATH`) |
| `GW_KILL=… GW_START=… node scripts/live-drop-recovery.mjs` | Kills/restarts a real Gateway mid-turn and idle; checks soft failure, reconnect, mapping and conversation continuity. Use a scripted stand-in model (query `SLOW<ms>` streams slowly) | controllable JiuwenSwarm |
| `node --test test/fuzz-gateway.test.js` | Adversarial frames: malformed/null/binary, events before ack, duplicated finals, unicode/control/surrogates in tool args, 40× send/cancel, slow/missing ack, shared session id, hostile mapping ids | none |
| `node --expose-gc scripts/live-deep.mjs` | Deep live pass with the scripted stand-in (`/workspace/jw-live/stand-in.mjs`-style: markers `TAG`/`SLOW`/`REASON`/`HUGE`/`ERR500`/`ERRMID`/`TOOL:`/`MCP:`): 12-turn history, reasoning, Jiuwen tool events, 200 KB answer, provider 500 / mid-stream drop, abort, ask_user card + no-UI, dsh-tools MCP call round trip, persona once/resend, 6 concurrent sessions, bad URL/port, config variants, `LEAK_TURNS` (default 200) leak check. `ONLY=A,C,…` picks sections | stand-in-backed JiuwenSwarm |
| `node scripts/compat-runtime.mjs --jiuwen --sync --gateway=ws://…` | Real dsh runtime: title, `/jiuwen rename`, plan mode, workdir, goal create/pause/resume/clear, second turn; each read back from Jiuwen. `--reload`: 3× dispose/re-plugin in the live runtime. `--sync2`: skills body, permission baseline (no global flip), dsh fork → Jiuwen fork, delete idle + mid-turn, persona/group reinject, schedule→heartbeat (conf restored), MCP passthrough. `--providers`: also load pi-ai + deepseek-account | `DSH_NM` + JiuwenSwarm |
| `npm run smoke:live` | Minimal generic host against a real Gateway (default `:19000`; `SKIP` if offline): single turn, multi-turn memory, tool-call events, usage, no `processing_status` leak, cancel, session/skills/team/models RPCs | running JiuwenSwarm |
| `npm run bare-dsh` | Install npm dsh and wire headless/web profiles — see [bare-dsh.md](./bare-dsh.md) | npm network |
| `npm run mock:gateway` / `mock:openai` | Standalone mocks (`JIUWEN_GATEWAY_MOCK_PORT`, default 19000) | none |

Evidence lands under `examples/` (gitignored).

The mock gateway mirrors live wire shapes (`tool_call.name` nesting, `rendered_result`, `patch_segment` final, `usage_summary`, `processing_status.is_complete`; `slow` for slow streams, `ask me` for questions, `echo-params` echo, `debug.state` RPC). Set `MOCK_STREAM_END=1` to also emit `stream.end`. Use `JIUWEN_GATEWAY_MOCK_SHAPE=0.2.7` for the 0.2.7 response shape.
