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

**Gaps:** opt-in and experimental plugins outside `dsh-base`/`dsh-web-app` were not loaded: mcp-client, time-context, session-search, ralph, terminal, worktree, auto-review. dsh has no session delete, so the Jiuwen session is deleted only after dsh has dropped it.
