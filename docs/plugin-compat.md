# Plugin compatibility (plain dsh)

Tested with dsh 0.2.1-rc.5, a plain web profile (`dsh-base` + `dsh-web-app`, no FlyBot), with and without `dsh-llm-jiuwen`, and with the adapter loaded first or last. A small driver plugin (`test/live/plain-dsh/driver`, run by `npm run test:plain-dsh`; in-process: `test/plugin-compat-matrix.test.js`) runs the scenario through host services (`sessionController`, `schedule`, …).

- **Non-jiuwen:** the normalized event stream, fork events, schedules, skills and preset are the same with and without the adapter.
- **Jiuwen:** what the plugin does reaches Jiuwen (checked by reading it back), or the adapter leaves the session unchanged without errors.
- **Hygiene:** no errors and no unhandled rejections. Results are the same in either load order. The adapter adds one `process.exit` listener, lazily, and removes it on dispose.

| Plugin | Non-jiuwen identical | In jiuwen sessions | Result |
|---|---|---|---|
| session-controller (create/selectModel/prompt) | ✓ | turns reach Jiuwen | PASS |
| session-title (rename) | ✓ | title → Jiuwen | PASS |
| working-directory | ✓ | cwd → projectDir (also when the model is selected after create) | PASS |
| dsh-schedule (`every`) | ✓ | → Jiuwen heartbeat; restored on delete | PASS |
| dsh-permission-presets | ✓ | read-only → bash/write/edit deny; restored | PASS |
| fork (controller) | ✓ | Jiuwen fork; fork turn goes to the fork | PASS |
| dsh-plan-mode (preset-scoped) | ✓ | on/off → Jiuwen chat mode | PASS |
| dsh-goal | ✓ | clear → Jiuwen goal cleared | PASS |
| dsh-skill / skill-filesystem (preset-scoped) | ✓ | skill body reaches the model | PASS |
| agent-presets persona (`minimal`) | ✓ | persona forwarded; shipped `{{model}}` default skipped | PASS |
| workspace archive / agent dispose | ✓ | Jiuwen session kept while dsh still stores it | PASS |
| mcp-resources, subagent, todo, compaction, approval, web tools | ✓ | not mirrored; unchanged | PASS (graceful) |

## Memory-module plugins

dsh has no plugin literally named "memory". Its memory and recall layer is three plugins. Each was tested in real profiles in both load orders with the stand-in model (`npm run test:plain-dsh`).

| Plugin | Non-jiuwen | Jiuwen sessions | Verdict |
|---|---|---|---|
| dsh-agent-instructions (AGENTS.md / CLAUDE.md, in dsh-base) | unchanged | the AGENTS.md reminder is forwarded with the first prompt, and Jiuwen keeps it in history (not resent) | works |
| dsh-session-reference (`dsh-session:<id>` mentions, in dsh-web-app) | unchanged | the referenced-session snapshot is forwarded with the citing prompt; later turns are not resent | works |
| dsh-experimental-session-search (+ session-query-sqlite, tool-session-query; opt-in) | unchanged | the `session_*` tools reach Jiuwen as `mcp_dsh-tools_session_*` and return dsh's session index | works (after the fix below) |

- **Jiuwen's own memory:** no conflict. Jiuwen keeps its `coding_memory_*` tools and its history. dsh tools are prefixed, and dsh context is sent once per turn, never duplicated.
- **Fix:** the passthrough asked for dsh approval on every call. dsh never asks for the read-only session-query tools, so a Jiuwen session would hang until approval timed out (300 s). These tools are now in `toolApprovalExempt` (see the configuration docs). All other tools are still gated.
- **Limit:** Jiuwen-side memory is not mirrored into dsh's session index. `session_search` sees the dsh transcripts of Jiuwen sessions, not Jiuwen's internal memory.

**Gaps:** opt-in and experimental plugins outside `dsh-base`/`dsh-web-app` were not loaded: mcp-client, time-context, session-search, ralph, terminal, worktree, auto-review. dsh has no session delete, so the Jiuwen session is deleted only after dsh has dropped it.
