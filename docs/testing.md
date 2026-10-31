# Testing

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
