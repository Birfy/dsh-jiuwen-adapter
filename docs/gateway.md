# JiuwenSwarm Gateway capabilities

Source: JiuwenSwarm schemas (`chat_send.py`, `EventType` in `message.py`, web `register_method` tables) plus live captures against `ws://127.0.0.1:19000/ws` (2026-10-29 / 2026-10-30).

## 1. Protocol

- WebSocket frames: request `{type:'req', id, method, params}` → response `{type:'res', id, ok, payload}`; events `{type:'event', event, payload}`.
- **Live:** the event name is on `frame.event`. `payload.event_type` is absent on `chat.delta` / `chat.final` / `chat.reasoning`, and present on tool/usage/status events.
- A turn truly ends on `chat.processing_status {is_processing:false, is_complete:true}`. Before that you usually see `chat.final` (`final_mode: patch_segment`, full text), `chat.usage_summary`, a second empty `chat.final`, and `task.global_running`. The Gateway does **not** send `stream.end`.

## 2. `chat.send` params (`ChatSendParams`)

| Field | Meaning | Adapter |
|---|---|---|
| `content` / `query` (deprecated) | User message | Both sent |
| `session_id` | Jiuwen session | From the session mapping |
| `mode` | `agent` / `agent.plan` / `agent.work.normal` / `agent.code.normal` / `team.work.normal` / … | `chatMode` (default = `workMode` = `agent`; model `jiuwen-swarm` → `team.work.normal`) |
| `model_name` | Jiuwen model | Only when explicitly set (catalog `modelName` / non-catalog id / request `modelName`) |
| `agent_template_name` | Expert (`""` unloads) | `agentTemplateName` |
| `agent_group_name` | Expert group (first Team build) | `agentGroupName` |
| `skills` | Selected skills | `skills` |
| `plugin_names` | Session plugin set | Request-level `pluginNames` |
| `metadata` | Request metadata | Request-level `metadata` |
| `media_items` / `attachments` / `files` | Attachments (image `base64Data`+`mimeType`+`filename`, documents likewise) | See §5 |
| `project_dir` / `cwd` / `workspace_dir` / `trusted_dirs` | Working dirs | `projectDir` |
| `supports_user_interaction` | Can the client answer ask_user? | Default `auto` — true when the host has `ctx.userQuestions` (see [dsh-integration.md](./dsh-integration.md)) |
| `answers` / `request_id` / `source` / `is_supplement` | Interrupt resume / supplement | Not auto; use `gateway.userAnswer` / `rpc` |
| `plan_entry_source`, `group_members`, `eternal_conversation_enabled` | UI internals | Unused |

## 3. Events (`EventType`)

| Event | Adapter mapping (default `eventDisplay: reasoning`) |
|---|---|
| `chat.delta` | `text-delta` |
| `chat.reasoning` | `reasoning-delta` (`forwardReasoning`) |
| `chat.tool_call` (`payload.tool_call.{name,arguments,tool_call_id}`) | `🔧 name args` in the reasoning block + structured `tool_call` |
| `chat.tool_update` | Structured `tool_update` |
| `chat.tool_result` (`tool_name,rendered_result,success`) | `✓/✗ name: result` + `tool_result` |
| `chat.subtask_update` / `chat.subagent_activity` / `todo.updated` / `team.*` | `• kind: summary` + event |
| `chat.processing_status` | **Filtered by default** (`showProcessingStatus`); end signal + event only |
| `chat.usage_metadata` / `chat.usage_summary` | Standard `usage` chunk |
| `chat.media` / `chat.file` | Text `[jiuwen-media:name]` + event |
| `chat.ask_user_question` | Rendered question text, `finish: stop`, `pendingQuestion`; answer via `gateway.userAnswer` |
| `chat.error` | `finish: error`, `code: JIUWEN_ERROR` (**non-retryable** — avoids duplicate host resends) |
| `chat.interrupt_result` | `finish: stop/aborted` |
| `chat.final` | Append unseen text; enter `finalGraceMs` idle grace |
| Other (`context.usage`, `goal.*`, `plan.approval_required`, `workflow.updated`, …) | Event `raw` (not streamed as text) |

`eventDisplay: markers` restores legacy text markers; `none` hides activity.

Subscribe: `ctx.jiuwenAdapter.onEvent(fn)`, per-request `providerOptions.jiuwen.onEvent`, or Cordis `jiuwen/event` when the host has `ctx.emit`.

## 4. Methods (web-channel RPCs, selected)

- **Sessions:** `session.list/create/get_metadata/rename/pin/fork/switch/delete/plan_status/message.continue_queued`
- **Turn control:** `chat.send`, `chat.interrupt` (`intent: cancel|pause|resume|supplement`), `chat.resume`, `chat.user_answer`, `chat.swarmflow_reply`
- **History:** `history.get` (page streamed as `history.message` events on ≥0.2.7)
- **Catalogs:** `skills.*`, `agents.list`, `team.templates.list`, `team.list` / `team.bindings.list`, `commands.list`, `models.list`, `mcp.*`
- **Commands:** `command.compact`, `command.goal`, `command.workflows`, `command.btw` (`command.recap` is unknown on /ws in 0.2.7)
- **Files/media:** `media.persist/discard`, `document.persist/formats`
- Plus project/git, cron, heartbeat, permissions, plugins, updater, path, locale, …

`ctx.jiuwenAdapter.gateway` wraps the helpers used by `/jiuwen` (including `historyMessages`, permission/cron/heartbeat writers, and generic `rpc(method, params)`). Session args accept a host session id (auto-mapped) or a raw Jiuwen id. Per-session `chatMode` / `skills` / `agentTemplateName` overrides: [dsh-integration.md](./dsh-integration.md).

Live probes on :19000 and the methods that stay `unknown method` on /ws are documented in [known-issues.md](./known-issues.md).

## 5. Multimodal

- Inline data URL / base64 / readable local path (≤10 MB) → `media_items[]`: `{type:'image'|'document', base64Data, mimeType, filename, …}` (Gateway uploads into the session uploads dir).
- Hosts with a Cordis `attachments` service (DSH AttachmentStore: `readImageRequest` / `fileHostPath`) resolve content-addressed `attachmentId`s to bytes (images: long edge ≤2048, ≤4 MB).
- The Jiuwen model must support vision; otherwise it may try to “read” base64 and trip duplicate-output guards.

## 6. Continuity / cancel / helper calls

- `historyMode: gateway` (default): after turn 1, only the latest user text after the last assistant is sent; Jiuwen keeps history/memory. `transcript` sends ~8 recent messages each turn.
- `ignoreMessagePatterns` (default `^Current runtime context\.`): host-injected runtime context is not forwarded.
- Cancel: host `AbortSignal` → same-socket `chat.interrupt {intent:'cancel'}` → `finish: aborted` (`interruptOnAbort`). Cancelled turns still increment the session turn count.
- Mid-stream Gateway close → `TRANSPORT` with a clear “in-flight answer lost; send your next message to reconnect” message (Round 3). Jiuwen does not resume the interrupted turn.
- `purpose: session-title` → local title by default (`titleMode: local`) plus fire-and-forget `session.rename`. `compaction` uses local digest; `local+jiuwen` also calls `command.compact` when the session has turns.
