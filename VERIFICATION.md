# Verification

Last verified: 2026-10-29 (Linux box; Node 22.21, dsh 0.2.1-rc.2 from npm, workswarm/JiuwenSwarm gateway on ws://127.0.0.1:19000/ws).

| Check | Command | Result |
|---|---|---|
| Unit + generic host + gateway features (mock gateway) | `npm test` | 35/35 pass |
| Mock smoke (openai fallback + gateway) | `npm run smoke` | pass |
| Real Cordis `Context` + `LlmRuntime` load, openai + gateway streams | `npm run smoke:cordis` | pass |
| Live gateway (chat, memory, tool use, usage, cancel, RPCs) | `npm run smoke:live` | 13/13 pass |
| Fresh Quickstart (new temp dir, `npm i -g @deepseek-ai/dsh`, clone from GitHub, plugin add, headless + web chat) | [docs/quickstart.md](./docs/quickstart.md) | real replies (see quickstart) |

dsh field notes (multi-turn, tools, cancel, attachments, UX): [docs/bare-dsh.md](./docs/bare-dsh.md).
