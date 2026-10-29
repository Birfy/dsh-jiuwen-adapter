# JiuwenSwarm Gateway 能力与适配器集成 / Gateway capabilities

来源：本机 `/workspace/jiuwenswarm` 源码（`jiuwenswarm/common/schema/chat_send.py`、`jiuwenswarm/common/schema/message.py` 的 `EventType`、`gateway/channel_manager/web/app_web_handlers.py` 的 `register_method`），以及对 `ws://127.0.0.1:19000/ws` 的实测抓包（2026-10-29）。

## 1. 协议

- WebSocket 帧：请求 `{type:'req', id, method, params}` → 响应 `{type:'res', id, ok, payload}`；事件 `{type:'event', event, payload}`。
- **实测**：事件名在 `frame.event`；`payload.event_type` 在 `chat.delta/chat.final/chat.reasoning` 上**不存在**，在 tool/usage/status 上存在。
- 一轮的真正结束是 `chat.processing_status {is_processing:false, is_complete:true}`；之前会有 `chat.final`（`final_mode: patch_segment`，带全文）、`chat.usage_summary`、第二个空 `chat.final`、`task.global_running`。Gateway **不发** `stream.end`。

## 2. `chat.send` 参数（ChatSendParams）

| 字段 | 含义 | 适配器 |
|---|---|---|
| `content` / `query`(deprecated) | 用户消息 | ✅ 两者都发 |
| `session_id` | Jiuwen 会话 | ✅ 由会话映射生成 |
| `mode` | `agent` / `agent.plan` / `agent.fast` / `agent.work.normal` / `agent.code.normal` / `team` / `team.work.normal` / `team.code.plan` / `team.design` … | ✅ `chatMode`（默认=`workMode`=`agent`；`jiuwen-swarm` 模型 → `team.work.normal`） |
| `model_name` | Jiuwen 模型 | ✅ 仅在显式指定（目录 `modelName` / 非目录模型 id / 请求 `modelName`）时发送 |
| `agent_template_name` | 专家（"" 卸载） | ✅ `agentTemplateName` |
| `agent_group_name` | 专家团（首次 Team 构建） | ✅ `agentGroupName` |
| `skills` | 选中的 skill | ✅ `skills` |
| `plugin_names` | 会话插件全集 | ✅ 请求级 `pluginNames` |
| `metadata` | 请求元数据 | ✅ 请求级 `metadata` |
| `media_items` / `attachments` / `files` | 附件（图片 `base64Data`+`mimeType`+`filename`，文档同） | ✅ 见 §5 |
| `project_dir` / `cwd` / `workspace_dir` / `trusted_dirs` | 工作目录 | ✅ `projectDir` |
| `supports_user_interaction` | 客户端能否回答 ask_user | ✅ 默认 `auto`：宿主有 `ctx.userQuestions` 时为 true（见 dsh-integration.md） |
| `answers` / `request_id` / `source` / `is_supplement` | 中断续答 / 补充 | ⚪ 未自动使用；可用 `gateway.userAnswer` / `rpc` |
| `plan_entry_source`, `group_members`, `eternal_conversation_enabled` | UI 内部 | ⚪ 不使用 |

## 3. 事件（EventType）

| 事件 | 适配器映射（默认 `eventDisplay: reasoning`） |
|---|---|
| `chat.delta` | `text-delta` |
| `chat.reasoning` | `reasoning-delta`（`forwardReasoning`） |
| `chat.tool_call`（`payload.tool_call.{name,arguments,tool_call_id}`） | 推理块中的 `🔧 name args` + 结构化事件 `tool_call` |
| `chat.tool_update`（`tool_name,status`） | 结构化事件 `tool_update` |
| `chat.tool_result`（`tool_name,rendered_result,success`） | `✓/✗ name: result` + 事件 `tool_result` |
| `chat.subtask_update` / `chat.subagent_activity` / `todo.updated` / `team.task` / `team.member` / `team.message` | `• kind: summary` + 事件 |
| `chat.processing_status` | **默认过滤**（`showProcessingStatus`），仅作为结束信号 + 事件 |
| `chat.usage_metadata` / `chat.usage_summary` | 标准 `usage` chunk（`inputTokens/outputTokens/totalTokens/cacheReadTokens`） |
| `chat.media` / `chat.file` | 文本 `[jiuwen-media:name]` + 事件 |
| `chat.ask_user_question` | 渲染问题文本，`finish: stop`，记录 `pendingQuestion`，可用 `gateway.userAnswer` 回答 |
| `chat.error` | `finish: error`，`code: JIUWEN_ERROR`（**不可重试**，避免宿主重发重复消息） |
| `chat.interrupt_result` | `finish: stop/aborted` |
| `chat.final` | 补齐未见文本，进入 `finalGraceMs` 宽限 |
| `context.usage`, `chat.output_phase`, `task.global_running`, `chat.retract`, `chat.message_updated`, `goal.*`, `plan.approval_required`, `workflow.updated`, `designer.*`, `chat.symphony_status`, `chat.evolution_status` … | 事件 `raw`（不进入流） |

`eventDisplay: markers` 恢复旧行为（文本 marker）；`none` 隐藏活动。

结构化事件订阅：`ctx.jiuwenAdapter.onEvent(fn)`、请求级 `providerOptions.jiuwen.onEvent`、或 Cordis 事件 `jiuwen/event`（宿主有 `ctx.emit` 时）。

## 4. 方法（Gateway web 通道注册的 RPC，节选）

- **会话**：`session.list/create/get_metadata/rename/pin/fork/switch/delete/plan_status/message.continue_queued`
- **对话控制**：`chat.send`、`chat.interrupt`（`intent: cancel|pause|resume|supplement`）、`chat.resume`、`chat.user_answer`、`chat.swarmflow_reply`
- **历史**：`history.get`（结果以 `history.message` 事件返回）
- **能力目录**：`skills.list/installed/get/toggle/install/...`（含 marketplace/clawhub/skillnet）、`agents.list`、`team.templates.list`、`team.list`、`commands.list`、`models.list/get/upsert/defaults`、`mcp.*`
- **命令**：`command.compact`、`command.goal`、`command.workflows`、`command.mcp`、`command.btw`、`command.recap`
- **文件/媒体**：`file.upload_chunk`、`media.persist/discard`、`document.persist/formats`
- **项目/Git、cron、heartbeat、channel.*、permissions、memory.compute、hooks.list、updater.*、path.*** 等

适配器 `ctx.jiuwenAdapter.gateway` 封装：`sessionList/sessionCreate/sessionDelete/sessionFork/sessionMetadata`、`historyGet/historyListTurns`、`skillsList/agentsList/teamTemplatesList/commandsList/modelsList/mcpList`、`memoryList/memoryStatus/filesList`、`interrupt(sid, intent)/chatCancel/chatResume/userAnswer`、`compact`、`workflows`，以及通用 `rpc(method, params)`。会话参数可传宿主 sessionId（自动映射）或 Jiuwen session_id。

实测（live :19000）：`session.list`、`skills.list`、`team.templates.list`、`models.list`、`commands.list`、`agents.list`、`session.create`、`chat.interrupt` 均 ok；`memory.list` 返回 ok=false（该版本未开放）。

## 5. 多模态

- 内联 data URL / base64 / 可读本地路径（≤10 MB）→ `media_items[]`：`{type:'image'|'document', base64Data, mimeType, filename, ...}`（Gateway 会上传到会话 uploads）。
- 宿主若有 Cordis `attachments` 服务（DSH AttachmentStore：`readImageRequest` / `fileHostPath`），内容寻址附件（`attachmentId`）会被解析为字节（图片长边 ≤2048、≤4 MB）。
- 注意：Jiuwen 端模型须支持视觉，否则模型只能看到不可读的数据（实测 doubao-seed-2.0-mini 会试图"读 base64"并触发重复输出保护）。

## 6. 会话连续性 / 取消 / 辅助调用

- `historyMode: gateway`（默认）：首轮发最新用户消息（宿主已有历史则发简短 transcript）；之后**只发最后一条 assistant 之后的用户消息**，Jiuwen 自己保有历史与记忆。`transcript` 则每轮发近 8 条。
- `ignoreMessagePatterns`（默认 `^Current runtime context\.`）：宿主注入的运行时上下文块（DSH 的文件/审批策略，对 Jiuwen 无意义）不转发。
- 取消：宿主 `AbortSignal` → 同一 WS 上发 `chat.interrupt {intent:'cancel'}` → `finish: aborted`（`interruptOnAbort`）。被取消的一轮仍计入会话轮次。
- `purpose: session-title` → 默认本地即时生成标题（`titleMode: local`；可从 JSON 包装的标题 prompt 中取出原文），不占用 Jiuwen 一轮、不污染会话；`compaction` 等辅助调用走一次性 Jiuwen 会话。
