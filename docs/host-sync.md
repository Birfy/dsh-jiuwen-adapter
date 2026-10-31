# Host → Jiuwen sync

Everything the dsh / FlyBot frontend can change is forwarded to JiuwenSwarm for **jiuwen-provider sessions only**. Non-jiuwen providers are never touched. Every path is fail-soft and Gateway methods are feature-detected.

Master switch: `hostSync` (default **on**). `hostSync: false` or `JIUWEN_HOST_SYNC=0` disables all sync children. Per-feature `sync*` flags default to the master.

## What syncs by default

| Host change | Jiuwen | Flag |
|---|---|---|
| Skills enable/disable (`skills/change`) | `skills.toggle` (only names Jiuwen has; off only for names we synced) + `chat.send` `skills` (= Jiuwen `skills_to_use`, Jiuwen-known names only) | `syncSkills` |
| Skill body only (not in Jiuwen) | Body loaded with `skills.get()` and soft-injected once as host instructions (re-injected when it changes) | `syncSkillInstall` |
| MCP / connectors | Installed/connected `mcp.list` servers only (never the hub catalog) + `toolPassthrough: mcp` (allowlist `*`, approval `dsh`) | `syncMcp` |
| Model picker (`model/selection`, `request/header`) | `model_name` via session map; picking the catalog default clears a synced model (not a `/jiuwen model` pin) | `syncModel` |
| Plan mode (`plan/mode`) | `chatMode: agent.plan` ↔ Jiuwen `planBridge` | `syncPlanMode` / `planBridge` |
| Working directory | `project_dir` / `cwd` on next `chat.send` | `syncWorkDir` |
| Manual title (`session/title`) | `session.rename` | `syncTitle` |
| Session delete (`api-session/removed`) | `session.delete` when the mapping had turns, then unmap. During an active turn: `chat.interrupt`, wait (≤15 s), then delete | `syncDelete` |
| Goal create/pause/resume/clear | `command.goal` (dsh `resume` → `resume` after our `pause`, else `set`) | `syncGoal` |
| Host pause (`workspace/session-stop`) | `chat.interrupt` cancel | `syncPause` |
| Permission preset (safe map) | `permissions.tools.update` on `bash`/`write_file`/`edit_file` — never `set-all`. The session's first (seeded default) preset is a baseline and is not forwarded; only later changes are | `syncPermissions` |
| Session fork (`header.parentSession`) | `session.fork` + remap child (turns/options copied; subagent children are not forked) | `syncFork` |
| Group member change | Clears `systemHash` so persona reinjects on next turn | `syncGroup` |
| Schedule change (session `schedule/change`, `every`) | `heartbeat.set_conf` merged onto the current conf (global; Jiuwen has no per-session interval) | `syncSchedule` |

Skill and permission syncs are serialized and latest-wins, so rapid toggles cannot land out of order. Skill sync makes no Gateway call when no jiuwen session exists.

Provider detection uses the real dsh `Session.requestHeader()` fold, so a brand-new session becomes a jiuwen session on its first request header; the memory probe and MCP name sync run then.

Also default on with `hostSync`: `sessionSync` (mapping upkeep), `planBridge` (Jiuwen → dsh plan mirror).

## Hard gaps (documented)

| Area | Gap |
|---|---|
| **Memory** | Jiuwen `memory.*` is often unrouted on Gateway 0.2.7. Sync probes once and sets `mapping.memoryBridge` to `rpc` or `gap`. No automatic memory write-through. |
| **Skill install** | Jiuwen cannot install arbitrary dsh skill packages. Matching names are toggled; unknown bodies are injected as instructions only (`syncSkillInstall`). |
| **schedule.*** | Live 0.2.7 `/ws` answers `unknown method`. Feature-detected; heartbeat conf is the soft fallback. |
| **Plugins / capabilities** | Host plugin enablement is not mirrored 1:1 onto Jiuwen `plugins.*` (different catalogs). Use `/jiuwen plugins` for Jiuwen-side plugins. |
| **MCP visibility** | 0.2.7 `mcp.list` returns only the hub catalog; custom servers (our `dsh-tools` passthrough) are absent. `mcp.show {name}` does resolve them (state + tools): use `/jiuwen mcp` or `ctx.jiuwenAdapter.mcpVerify()`. |
| **Resume** | dsh rc.5 has no session resume event (`agent/resumed` is not emitted; host stop = cancel, next message continues). Only goal `resume` maps (see table). |
| **Gateway restart** | Turns are one socket each: a drop mid-turn ends that turn with `TRANSPORT` (after a short history-recovery window); the next turn reconnects with the same mapping. Global Jiuwen state (skills, permissions) is persisted by Jiuwen; per-turn overrides are resent every `chat.send`. |
| **Dispose vs delete** | `session/disposed` only clears runtime state (mapping kept). `api-session/removed` deletes the Jiuwen session when it had turns. |

## Config

See [configuration.md](./configuration.md). Env: `JIUWEN_HOST_SYNC`, `JIUWEN_SYNC_SKILLS`, `JIUWEN_SYNC_MCP`, …
