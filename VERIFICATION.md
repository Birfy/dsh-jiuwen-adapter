# Verification log

Updated: 2026-10-28 23:35 Asia/Shanghai (box-local).

## Architecture addendum (enforced)

**JiuwenSwarm owns** chat loop, tools, memory, sessions, models.  
**DSH owns** Cordis plugin ABI / FlyBot shell only.  
Default `mode=gateway`. DSH tools are stripped on the wire; Gateway never emits DSH `tool-call` chunks. See ARCHITECTURE.md.

## Commands

```bash
cd /workspace/dsh-jiuwen-adapter
npm test                 # expect 20/20
npm run smoke            # gateway brain + openai fallback
npm run smoke:cordis     # Cordis register + stream
npm run verify:flybot    # FlyBot plugins + gateway brain (needs apps/cli/lib/bin.js)
# live (optional): JIUWEN_GATEWAY_URL=ws://127.0.0.1:19000/ws node … see examples/live-gateway/
```

## Results (全补 close-out)

| Check | Result |
|-------|--------|
| unit tests (auth, multimodal, e2a-rpc, brain strip, gateway/openai, session-store) | **PASS** 20/20 |
| smoke openai-fallback | **PASS** |
| smoke gateway-brain (tool/subtask markers + finish:stop) | **PASS** |
| smoke session mapping | **PASS** |
| Cordis `registerAdapter` + stream | **PASS** |
| FlyBot verify: present CLI + dump-config (jiuwen/ds-bot/social/tree) | **PASS** |
| FlyBot verify: gateway brain chat + openai fallback | **PASS** |
| `dsh web` UI boot | **SKIPPED** — client bundles incomplete (`pnpm run build:lib` / client face fails; see blockers) |
| live Gateway `models.list` / `history.get` / `mcp.list` | **PASS** against `ws://127.0.0.1:19000/ws` |
| live Gateway `chat.send` via adapter | **PASS** — `doubao-seed-2.0-mini` via Coding Plan `.../api/coding/v3`; reply `hi` (2026-10-29 Asia/Shanghai). |

Evidence: `examples/smoke-home/`, `examples/flybot-verify-home/`, `examples/live-gateway/live-result.json`.

## Implemented gaps (code)

| Gap | Status |
|-----|--------|
| E2A surface in adapter | **DONE** — `src/e2a-methods.js` + unary RPCs + event markers; tools stay on Jiuwen |
| Auth cookie/session headers | **DONE** — `src/auth.js` |
| Multimodal beyond placeholders | **DONE** for data URL / base64 / path → `media_items`; offloaded-only = text marker |
| Docs | **DONE** — README.zh / ARCHITECTURE / this file refreshed |

## Blockers (honest)

1. **deepseek-harness full `pnpm run build:lib`**
   - Host face: tsdown `UNRESOLVED_ENTRY` for packages lacking `lib/types/*.js` after `tsc` (client-primary packages). Targeted fix used: `tsc -b apps/cli && tsdown` in `apps/cli` → `apps/cli/lib/bin.js` (**works**; dump-config + verify hard path green).
   - Client face: fails on missing `onboarding-config.js` under `packages/client/ui-settings-models` (`.d.ts` present, `.js` not emitted). Full `dsh web` UI remains skipped.
   - **Do not** re-run root `tsdown --env.DSH_BUILD_FACE host` after building CLI — workspace clean deletes `apps/cli/lib/bin.js`.

2. **Live chat completion** — **DONE** 2026-10-29: Gateway AgentServer `18092` + WS `19000`/`19001`; Coding Plan model `doubao-seed-2.0-mini`; adapter `chat.send` PASS.

3. **Jiuwen web UI static** — `jiuwenswarm/channels/web/frontend/dist` missing; `jiuwenswarm-start web` exits 1. Backend/WS path used for live smoke does not need it.

## Infra notes

- Inodes: ~87% used after `uv sync` (~271k free). Freed carefully: `uv cache prune` (negligible). Did **not** delete unrelated user repos.
- Jiuwen install: `cd /workspace/jiuwenswarm && UV_LINK_MODE=copy uv sync --no-dev` → **PASS**; `.venv` present.
- Start: `uv run jiuwenswarm-start app` (or `.venv/bin/jiuwenswarm-start app`).
