# dsh integration / 与 dsh 扩展点的集成

How the adapter cooperates with other dsh (Cordis) plugins while JiuwenSwarm stays the agent brain.
Verified live on npm `@deepseek-ai/dsh@0.2.1-rc.2` + local JiuwenSwarm Gateway `ws://127.0.0.1:19000/ws` (2026-10-29).

## 1. ask_user → dsh user-questions (`ctx.userQuestions`)

- `supportsUserInteraction` (default **`auto`**): `supports_user_interaction=true` is sent on `chat.send` only when the host provides `ctx.userQuestions` (`@deepseek-ai/dsh-user-questions`). `true` / `false` force it (`JIUWEN_SUPPORTS_USER_INTERACTION=1|0`).
- On `chat.ask_user_question` the adapter calls `ctx.userQuestions.ask({ questions, agent, signal })` (agent = `ctx.agents.get(sessionId)`), so any dsh answerer UI (web `dsh-client-ui-user-questions`, ACP, a custom plugin hooking the `user-questions/request` waterfall) shows its native card.
- The answer is mapped back (option label → Jiuwen option `value`) and sent on the **same socket**: sources `ask_user_interrupt` / `confirm_interrupt` / `permission_interrupt` / `evolution_interrupt` resume with `chat.send {query:'', request_id, answers, source}` (as Jiuwen's own CLI does); other sources use `chat.user_answer`. The dsh turn keeps streaming the resumed output.
- Fallback: no answerer (`NO_PROVIDER`, e.g. headless), error or `questionTimeoutMs` (default 600000) → Jiuwen is told `noUiAnswer` ("No interactive user is available…") so it never stays paused. With `supportsUserInteraction: false` the legacy behaviour remains (question printed as text, turn ends, `gateway.userAnswer()` available).
- Duplicate cards for an already-answered `request_id` are ignored.

中文：`supportsUserInteraction` 默认 `auto`——宿主有 `ctx.userQuestions` 时才告诉 Jiuwen 可交互；问题走 dsh 原生问答卡，答案在同一 WS 上回给 Jiuwen 并继续流式输出；无答题 UI/超时则回一个中性答复让 Jiuwen 自行继续。

## 2. Permission / plan approval → dsh user-approval (`ctx.approval`)

- Routed to `ctx.approval.request({ agent, toolName, reason, signal })` (`@deepseek-ai/dsh-user-approval`, i.e. the dsh approval card / `approval/request` waterfall / ACP permission):
  - `chat.ask_user_question` with `source: permission_interrupt` (Jiuwen tool permission card; `card_id` is echoed back),
  - `source: confirm_interrupt` (plan approval, `exit_plan_mode`),
  - `plan.approval_required`.
- Decision → Jiuwen option: `allowed-once` → option whose value/label is `allow_once`/`approve`/…; anything else → `reject`/`deny`/…, then resumed with `chat.send {request_id, answers, source}`.
- **Safe default = deny**: no `ctx.approval`, no live agent, `rejected`/`cancelled`/`unavailable`, error, abort or `approvalTimeoutMs` (default 300000) → reject. Approvals never fail open. dsh approval policy `never` (auto-approve) is honoured because it is dsh's own decision.
- Live (dsh 0.2.1-rc.2, `JIUWEN_CHAT_MODE=code.plan`): rejected → Jiuwen did not execute the plan (file not created); `allowed-once` → plan executed (`/tmp/jwplan.txt` = `hi`).

中文：Jiuwen 的工具权限卡 / 计划审批统一交给 dsh `ctx.approval`；只有 `allowed-once` 才放行，其余（无 UI、超时、出错）一律拒绝。
