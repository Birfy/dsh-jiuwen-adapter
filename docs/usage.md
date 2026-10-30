# Using the adapter

[← README](../README.md)

## Usage with any Cordis plugin

```js
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'   // or any llm service with registerAdapter()
import * as jiuwen from '@dsh-jiuwen/adapter'

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(jiuwen, { gatewayURL: 'ws://127.0.0.1:19000/ws' })

for await (const c of ctx.llm.stream({
  provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'user-42',
  messages: [{ role: 'user', content: 'hello' }],
})) {
  if (c.type === 'text-delta') process.stdout.write(c.text)
  if (c.type === 'finish') console.log('\n', c.reason)
}
```

- **Tools**: gateway mode strips host `tools`; Jiuwen runs its own; activity appears in the reasoning block (`eventDisplay: markers` for legacy text markers), finish `stop`. `mode: 'openai', allowDshAgentLoop: true` forwards tools and returns `tool-call-delta` chunks, finish `tool-calls`.
- **Multimodal**: image/file parts (data URL or readable path) → `media_items`.
- **Sessions**: host `sessionId` → stable Jiuwen `session_id`, persisted at `mappingPath`.
- **E2A helpers**: `ctx.jiuwenAdapter.gateway.{historyGet, modelsList, mcpList, memoryList, filesList, chatCancel, workflows, sessionRename, sessionPin, goal, btw, recap, planStatus, skillsToggle, skillsInstalled, teamList, …}`.
- **Slash command**: `/jiuwen …` (session, turn control, models/mode, skills/agents, config/policy including cron/heartbeat create·update·delete confirm, mcp-reset confirm, help — see `/jiuwen help`) (when the host has `ctx.commands`).

## Gateway features (primary mode)

Structured Jiuwen activity (reasoning, 🔧 tool calls, ✓ results, subtasks) streams as a standard `reasoning` block plus structured events (`ctx.jiuwenAdapter.onEvent`, `providerOptions.jiuwen.onEvent`, Cordis `jiuwen/event`); `usage` chunks; `processing_status` filtered; session continuity (only new user text after turn 1, host runtime-context stripped); abort → `chat.interrupt cancel`; agent/team/model/skills selection via config, catalog entries or `providerOptions.jiuwen`; images/files as `base64Data` (host `attachments` service supported); local session titles; extra RPCs (sessions, skills, agents, team templates, commands, interrupt, userAnswer, compact, generic `rpc`). Full list: [docs/gateway.md](./gateway.md). Cooperation with other dsh plugins (user-questions, approval, SwarmFlow human turns, opt-in dsh-tool passthrough via MCP, local compaction, `/jiuwen` slash command with config/memory/cron/heartbeat/permission-rule/team/template/group/git subcommands, typed `jiuwen/event`): [docs/dsh-integration.md](./dsh-integration.md). Opt-in bridges, all **off** by default: `modelDiscovery`, `sessionSync`, `planBridge`, `typedEvents`, `documentPersist` ([docs/configuration.md](./configuration.md)). Gateway coverage: 172/334 `/ws` methods (73.2 % of the safe surface) — [docs/coverage.md](./coverage.md). dsh field report: [docs/bare-dsh.md](./bare-dsh.md) (`npm run bare-dsh`).
