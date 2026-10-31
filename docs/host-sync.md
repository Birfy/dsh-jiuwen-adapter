# Host → Jiuwen sync

Everything the dsh / FlyBot frontend can change is forwarded to JiuwenSwarm for **jiuwen-provider sessions only**. Non-jiuwen providers are never touched. Every path is fail-soft and Gateway methods are feature-detected.

Master switch: `hostSync` (default **on**). `hostSync: false` or `JIUWEN_HOST_SYNC=0` disables all sync children. Per-feature `sync*` flags default to the master.

## What syncs by default

| Host change | Jiuwen | Flag |
|---|---|---|
| Skills enable/disable (`skills/change`) | `skills.toggle` + `chat.send` `skills` | `syncSkills` |
| Skill body only (not in Jiuwen) | Soft-inject as host instructions (not installed) | `syncSkillInstall` |
| MCP / connectors | `mcp.list` + session `mcp` names; `toolPassthrough: mcp` (allowlist `*`, approval `dsh`) | `syncMcp` |
| Model picker (`request/header`) | `model_name` via session map | `syncModel` |
| Plan mode (`plan/mode`) | `chatMode: agent.plan` ↔ Jiuwen `planBridge` | `syncPlanMode` / `planBridge` |
| Working directory | `project_dir` / `cwd` on next `chat.send` | `syncWorkDir` |
| Manual title (`session/title`) | `session.rename` | `syncTitle` |
| Session delete (`api-session/removed`) | `session.delete` when the mapping had turns, then unmap | `syncDelete` |
| Goal create/pause/clear | `command.goal` | `syncGoal` |
| Host pause (`workspace/session-stop`) | `chat.interrupt` cancel | `syncPause` |
| Permission preset (safe map) | `permissions.tools.update` on a small tool set — never `set-all` | `syncPermissions` |
| Session fork (`header.parentSession`) | `session.fork` + remap child | `syncFork` |
| Group member change | Clears `systemHash` so persona reinjects on next turn | `syncGroup` |
| Schedule change | `heartbeat.set_conf` when routed | `syncSchedule` |

Also default on with `hostSync`: `sessionSync` (mapping upkeep), `planBridge` (Jiuwen → dsh plan mirror).

## Hard gaps (documented)

| Area | Gap |
|---|---|
| **Memory** | Jiuwen `memory.*` is often unrouted on Gateway 0.2.7. Sync probes once and sets `mapping.memoryBridge` to `rpc` or `gap`. No automatic memory write-through. |
| **Skill install** | Jiuwen cannot install arbitrary dsh skill packages. Matching names are toggled; unknown bodies are injected as instructions only (`syncSkillInstall`). |
| **schedule.*** | Live 0.2.7 `/ws` answers `unknown method`. Feature-detected; heartbeat conf is the soft fallback. |
| **Plugins / capabilities** | Host plugin enablement is not mirrored 1:1 onto Jiuwen `plugins.*` (different catalogs). Use `/jiuwen plugins` for Jiuwen-side plugins. |
| **Dispose vs delete** | `session/disposed` only clears runtime state (mapping kept). `api-session/removed` deletes the Jiuwen session when it had turns. |

## Config

See [configuration.md](./configuration.md). Env: `JIUWEN_HOST_SYNC`, `JIUWEN_SYNC_SKILLS`, `JIUWEN_SYNC_MCP`, …
