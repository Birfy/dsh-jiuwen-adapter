# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **Default change:** `injectSystem` now defaults to `persona` (was `off`) and `trajectoryDetail` to `full` (was `summary`). Set `injectSystem: off` / `trajectoryDetail: summary` (or `JIUWEN_INJECT_SYSTEM=off` / `JIUWEN_TRAJECTORY_DETAIL=summary`) to restore the old behavior. Injection remains Jiuwen-session-only and fail-soft.

### Added
- `injectSystem` (`off` | `persona` default | `full`): forward the host system prompt to Jiuwen once per mapped session as a `[System instructions from host]` prefix, hash-gated (stored in the session mapping), 8 KB cap, fail-soft.
- `trajectoryDetail` (`summary` | `full` default): structured Markdown steps (tool, args, result, subtasks, todos, `trace.*`) in the reasoning block, 4 KB per item.

### Fixed
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
