# Using npm dsh (field guide)

## Install (one command)

```bash
cd /path/to/dsh-jiuwen-adapter
BARE=$HOME/bare-dsh npm run bare-dsh      # = scripts/bare-dsh.sh
export DSH_HOME=$HOME/bare-dsh/home PATH=$HOME/bare-dsh/prefix/bin:$PATH
```

What the script does: `npm i -g --prefix $BARE/prefix @deepseek-ai/dsh`; for both `headless` and `web` profiles runs `dsh plugin --profile <p> add <adapter>` (loads the package `cordis.patch.yml` as a bundle layer); writes into each profile’s `cordis.patch.yml`:

```yaml
- id: agent-default-model
  config: { provider: jiuwen, model: jiuwen-default }
```

Mac: `brew install dsh` also works (needs ≥ 0.2), then `dsh plugin --profile web add …` as above.

## Usage

```bash
dsh --profile headless "Reply with exactly: pong"                 # single turn
dsh --profile headless --json "Use bash to run date"               # NDJSON events
dsh --profile headless --session-id session-… "continue"           # multi-turn (same Jiuwen session)
dsh --profile web --no-open --port 3291                            # Web UI → http://127.0.0.1:3291/?token=…
```

Check the Gateway: `ss -ltn | grep 19000`. If down: `jiuwenswarm-start app` (or the project `.venv` binaries). Debug: `JIUWEN_TRACE_FILE=/tmp/jw.jsonl dsh …` records each turn’s query and events.

## Field notes (2026-10-29 — dsh 0.2.1-rc.2, JiuwenSwarm :19000, model doubao-seed-2.0-mini)

| Scenario | Result |
|---|---|
| headless single turn | OK ~6 s |
| headless multi-turn (`--session-id`) memory | OK — turn 2 sends only the new question; Jiuwen keeps context |
| headless tool task (Jiuwen runs bash) | OK ~18 s; tool activity in `thinking`; usage reaches the step |
| headless Ctrl-C cancel | OK — sends `chat.interrupt cancel`, exit 130 |
| web UI start (bare profile) | OK — `dsh web: http://127.0.0.1:3291/?token=…` |
| web multi-turn / tools / Stop / continue after cancel | OK (after Stop, the next turn still remembers the cancelled request) |
| web image upload | Bytes reach Jiuwen via `attachments`, but a non-vision model fails with `chat.error` (not retried by dsh) |

### Fixes already in the adapter

1. **First turn ~3 min** — dsh `session-title` was treated as a full Jiuwen turn (and polluted the session). → local titles.
2. **Sidebar titles were the JSON prompt** — title prompt wrapped the dialog in JSON. → unpack.
3. **Jiuwen answered dsh runtime context** — host appended “Current runtime context…”; old logic took the last message only. → take all user text after the last assistant and strip runtime context.
4. **`processing_status` JSON leaked into replies** → filtered by default.
5. **Tool name showed as `tool`** — live payload uses `tool_call.name`. → fixed.
6. **After cancel, next turn resent the whole transcript** → cancel counts as a turn; transcript also strips runtime context.
7. **`chat.error` retried as TRANSPORT** → classified `JIUWEN_ERROR` (non-retryable).

### UX notes

- dsh’s context % uses the adapter’s declared `contextWindow` (128k) and Jiuwen-reported tokens; Jiuwen’s ~23k system prompt per turn makes the % look high — advisory only.
- Jiuwen answers in its configured language (English prompts may still get Chinese replies).
- dsh “Workspace Write” / approval policy only constrains dsh’s own tools; Jiuwen tools follow Jiuwen permissions.
- The reasoning block mixes Jiuwen thinking and tool activity (🔧/✓), collapsed under “Completed in Ns” in the web UI.
