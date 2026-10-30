# Troubleshooting & FAQ

## Symptoms

| Symptom | Cause | Fix |
|---|---|---|
| `permissionPresets.catalog is not a function` (Mac brew dsh `0.1.2-rc.1`) | Old dsh host ABI lacks `catalog()` — not an adapter bug | `brew upgrade` to dsh `≥ 0.2`, or build dsh from source |
| `ECONNREFUSED 127.0.0.1:19000` / no output | Gateway not running | `jiuwenswarm-start app`; check `ss -ltn \| grep 19000` (Mac: `lsof -iTCP:19000 -sTCP:LISTEN`); or `npm run mock:gateway` |
| 401 / 403 / WS closes immediately | Bad or expired token/cookie | Set `JIUWEN_ACCESS_TOKEN` or `JIUWEN_COOKIE='access_token=…'`; match `JIUWEN_USER_ID`; see [configuration.md](./configuration.md) auth order |
| Reply: “no usable model configured…” | Jiuwen has no model | Fill `~/.jiuwenswarm/config/.env` (`API_BASE` / `API_KEY` / `MODEL_NAME` / `MODEL_PROVIDER`) and restart the gateway |
| Log: `dsh-llm not resolvable; using duck-typed base` | Host has no `@deepseek-ai/dsh-llm` | Usually harmless; set `JIUWEN_LLM_ADAPTER_MODULE` if needed |
| Provider `jiuwen` missing | Plugin not loaded / no `llm` service | Ensure `inject: ['llm']`; `dsh plugin --profile web add <path>` |
| Timeout | Long turn exceeds `requestTimeoutMs` | Raise `JIUWEN_TIMEOUT_MS` |
| Host wants to run tools itself | Gateway mode keeps tools on Jiuwen | Use `mode: openai` + `allowDshAgentLoop: true` (diagnostics only) |
| First turn very slow / odd sidebar title | Older builds treated dsh title calls as full Jiuwen turns | Upgrade this adapter (`titleMode: local`) |
| Jiuwen answers “runtime context received” | Host appended runtime context was forwarded | Filtered by default; customise `ignoreMessagePatterns` |
| Reply contains `[jiuwen-chat.processing_status] {…}` | Older leak | Filtered by default; `showProcessingStatus: true` to show |
| Want legacy `[jiuwen-tool:…]` text | New default puts activity in the reasoning block | `eventDisplay: markers` |
| Image sent but Jiuwen “cannot see” it | Model has no vision | Configure a vision model in Jiuwen, or `providerOptions.jiuwen.modelName` |
| Slash errors look like `Jiuwen: "未找到 skill"` (extra quotes) | Fixed in Round 3 — upgrade | Errors are now `Jiuwen: 未找到 skill` without quotes |
| Mid-turn `TRANSPORT: Gateway WebSocket closed` | Gateway restarted or socket dropped | In-flight answer is lost (upstream); send the next message — it reconnects. `/jiuwen continue-queued` only helps when Jiuwen actually queued something |
| Inspect what was sent | — | `JIUWEN_TRACE_FILE=/tmp/jw.jsonl` |

## FAQ

- **Do I need dsh?** No. Any Cordis host that exposes `ctx.llm.registerAdapter` works — see `test/generic-host.test.js`.
- **Who runs tools?** Jiuwen, by default. The host sees activity in the reasoning block (or markers); finish is `stop`, so the host agent-loop does not re-execute tools.
- **How do sessions persist?** Host `sessionId` → stable Jiuwen `session_id` (`dsh-<hex>`), stored at `mappingPath`. History/memory live on Jiuwen.
- **Images / files?** Data URLs or readable paths become `media_items`. Device-only / offline attachments degrade to a text placeholder.
- **History / models / MCP?** `ctx.jiuwenAdapter.gateway.historyGet` / `historyMessages` / `modelsList` / `mcpList` / … — see [gateway.md](./gateway.md).
- **Are secrets committed?** No. `.gitignore` excludes `.env*`, cookie/token files, session maps, and example evidence dirs. The adapter never passes `api_key` through slash commands.
- **Deletes?** Destructive `/jiuwen` actions need a trailing `confirm` (`delete`, `mcp-reset`, `cron delete`, `heartbeat delete`, `permissions rule delete`, `media discard`). `unmap` is local-only and confirm-free.
