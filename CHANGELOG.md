# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `injectSystem: persona` also forwards plain dsh personas: the `deployment:persona-prefix/suffix` sections (dsh-system-prompt `personaPrefix/Suffix`, dsh-persona rows), observed read-only on the public `system-prompt/assemble` waterfall. FlyBot markers still win; dsh boilerplate is never sent. Off with `hostSync: false` or `injectSystem` ≠ `persona`.
- `compat-runtime.mjs --sync2` (skills body, permission baseline, fork, delete idle/mid-turn, persona/group reinject, schedule→heartbeat with restore, MCP passthrough; read back from Jiuwen) and `--providers` (pi-ai + deepseek-account in the compat matrix).
- `test/fuzz-gateway.test.js`: malformed/out-of-order/duplicate frames, unicode in tool args, rapid send/cancel, slow ack, id collisions.
- **Host → Jiuwen sync** (`hostSync`, default on): forwards dsh/FlyBot frontend changes (skills, MCP, model, plan mode, workDir, title, session delete, goal, pause/resume, safe permission presets, fork remap, schedule→heartbeat, group persona reinject) to Jiuwen for jiuwen-provider sessions only. See `docs/host-sync.md`.
- dsh goal `resume` → Jiuwen `command.goal resume` (keeps the Jiuwen goal) when we paused it; else `set`.
- `mcpVerify()` helper and `/jiuwen mcp` line for the dsh-tools passthrough (`mcp.show`; 0.2.7 `mcp.list` omits custom servers).
- `scripts/live-deep.mjs` and `compat-runtime.mjs --sync/--reload` (live deep + real-runtime sync read-back).
- `scripts/live-drop-recovery.mjs`: live Gateway kill/restart check.
- Per-path `sync*` flags; skill body soft-inject when Jiuwen cannot install the equivalent (`syncSkillInstall`).

### Changed
- **Default change:** `hostSync` / `sessionSync` / `planBridge` default **on**. `toolPassthrough` defaults to `mcp` with allowlist `*` when `hostSync` is on (approval still `dsh`). Set `hostSync: false` or `JIUWEN_HOST_SYNC=0` for the previous opt-in-off behaviour.
- **Default change:** `injectSystem` now defaults to `persona` (was `off`) and `trajectoryDetail` to `full` (was `summary`). Set `injectSystem: off` / `trajectoryDetail: summary` (or `JIUWEN_INJECT_SYSTEM=off` / `JIUWEN_TRAJECTORY_DETAIL=summary`) to restore the old behavior. Injection remains Jiuwen-session-only and fail-soft.

### Fixed
- A malformed or non-object Gateway frame (bad JSON, `null`, a number) no longer ends the turn with an error; it is dropped and reported as a `malformed-frame` raw event. `null` frames in RPC/ack replies no longer throw in the socket listener.
- `eventDisplay: markers`: a final-only answer after tool markers is no longer dropped.
- Activity/trajectory truncation never splits a surrogate pair (emoji in tool args).
- ask_user cards no longer show Jiuwen's synthetic trailing "Other / Custom input" option (the dsh card has its own free-text row).
- `/jiuwen rename` also sets the dsh title (public `sessionTitle.rename`) so the sidebar updates; no duplicate Jiuwen rename.
- `/jiuwen fork` says plainly that only Jiuwen was forked and points to the dsh Fork action (which forks and maps both).
- Gateway drop mid-RPC / before `connection.ack` now fails at once (was: waited the full RPC timeout); WebSocket connect has a timeout (half-open Gateway no longer hangs a turn); a dropped RPC is not cached by feature detection.
- Rapid skill / permission-preset toggles are serialized (latest wins); concurrent RPCs could land out of order.
- Session delete during an active turn interrupts the turn, waits for it, then deletes the Jiuwen session (the first turn's session was orphaned).
- Plugin dispose (both Cordis `effect` and `dispose` paths) releases host-sync queues, MCP bridge and event listeners; idempotent.
- Skill sync makes no Gateway call when no jiuwen session exists.
- Card answer text no longer doubles when Jiuwen re-streams the pre-question text after an `ask_user` resume; a resumed final with no deltas is no longer dropped.


## [0.2.0] - 2026-10-30

### Added
- **Mid-stream drop recovery.** When the Gateway socket drops mid-turn, the adapter looks for the turn's answer in Jiuwen history (`history.get`). If it finds it, it emits the answer marked `[Recovered from Jiuwen history after the Gateway connection dropped]`; otherwise it keeps the clear error. Configured with `recoverOnDrop` (default `true`) and `recoverWindowMs` (default `15000`).
- **Config validation at load.** Unknown keys (with a "did you mean" suggestion), deprecated keys and values (`apiKey`, `compactionMode: jiuwen`), and wrong types produce warnings through the host logger. Validation never throws.
- `JiuwenAdapterConfig` type in `index.d.ts`, covering every accepted key.
- **Compatibility test suites**:
  - Real-host A/B probe with 21 dsh plugins (`scripts/compat-host.mjs`).
  - Full agent-runtime A/B matrix (`scripts/compat-runtime.mjs`, `scripts/compat-matrix.mjs`). It covers approvals, tools, MCP, ask-user, retry, `/goal`, goal rounds, `/plan` and `exit_plan_mode`, `/compact`, automatic compaction, subagents, bash in a sandbox, title and token meter.
  - Stress probe (`scripts/stress.mjs`).
- **CI** (GitHub Actions): unit tests on Node 22 and 24; full suite and compat matrix against dsh `0.2.1-rc.2` and `0.2.1-rc.5`.
- Marketplace metadata: `dsh.manifestVersion`, `engines.dsh`, an icon, and `market/index.json`, a ready-to-host plugin market index.
- About 60 new `/jiuwen` subcommands (rounds 4–5). See `docs/coverage.md`.

### Fixed
- In the real dsh agent loop, user messages arrive without `role`. The adapter now infers roles, so Jiuwen receives the user's text instead of the system prompt.
- The opt-in MCP bridge leaked one `process` `exit` listener per prepare/dispose cycle.
- `permissions.tools.set` replaces the user overlay, so `/jiuwen permissions set-all` now requires `confirm`.

### Changed
- `peerDependencies` narrowed to the tested range: `@deepseek-ai/cordis ^4.0.5` and `@deepseek-ai/dsh-llm >=0.2.1-rc.2 <0.3.0`. Both stay optional, so generic Cordis hosts still load the adapter.

## [0.1.0] - 2026-10-29

### Added
- Initial release: the `jiuwen` provider for `ctx.llm` (Gateway and OpenAI-compatible modes), the `/jiuwen` command, session mapping, typed `jiuwen/*` events, and opt-in plan, approval and MCP bridges.
