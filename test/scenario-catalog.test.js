// Traceability: every scenario from the 2026-10-31 test rounds maps to an automated test that exists.
// unit = in `npm test`; live = test/live/*.mjs (`npm run test:live` / `test:plain-dsh`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const SCENARIOS = [
  ['drop/reconnect: mid-stream drop recovered from history', 'drop-recovery', 'mid-stream drop: the answer is recovered'],
  ['drop/reconnect: unary RPC fails fast on drop', 'gateway-drop-rpc', 'unary RPC fails fast'],
  ['drop/reconnect: real Gateway kill/restart', 'live', 'live-drop-recovery'],
  ['MCP verify: mcp.show resolves passthrough server', 'mcp-bridge', 'verify: mcp.show'],
  ['MCP invocation: tools/call approval + execute', 'mcp-bridge', 'tools/call: approval allowed-once'],
  ['MCP invocation: Jiuwen tool_search → dsh tool (real)', 'live', 'live-deep'],
  ['edge: concurrent isolated sessions', 'edge-cases', 'concurrent turns in several sessions'],
  ['edge: rapid skill / permission toggles', 'edge-cases', 'rapid skill toggles'],
  ['edge: delete during first turn', 'edge-cases', 'session delete during an active first turn'],
  ['resume: goal resume', 'edge-cases', 'resume: dsh goal resume'],
  ['browser-found rename: /jiuwen rename mirrors dsh title', 'edge-cases', '/jiuwen rename mirrors the dsh title'],
  ['browser-found fork: fork child title waits for remap', 'host-sync-fixes', 'title: a fork child title waits'],
  ['deep A long session', 'deep-pass', 'A long session'],
  ['deep B reasoning / C tool calls', 'deep-pass', 'B reasoning'],
  ['deep D huge output / E model 500 / F mid-stream drop', 'deep-pass', 'D huge'],
  ['deep G cancel', 'deep-pass', 'G cancel'],
  ['deep H ask_user card + no-UI', 'gateway-features', 'ask'],
  ['ask_user Other-option strip', 'edge-cases', 'synthetic trailing "Other / Custom input"'],
  ['ask_user picked option not echoed into custom_input', 'host-sync-fixes', 'ask_user answers'],
  ['persona once/resend/sections + full mode', 'deep-pass', 'J persona'],
  ['persona generic (plain dsh / minimal preset)', 'persona-generic', 'generic persona: forwarded only when'],
  ['persona {{model}} interpolation + shipped default skipped', 'persona-generic', 'interpolated {{vars}}'],
  ['concurrency: 6 slow sessions', 'deep-pass', 'K 6 concurrent'],
  ['bad config: port / URL / switches', 'deep-pass', 'M bad config'],
  ['200-turn leak', 'deep-pass', 'L 200-turn leak'],
  ['reload: apply/dispose cycles', 'deep-pass', 'reload: 3×'],
  ['fuzz: adversarial frames', 'fuzz-gateway', 'fuzz: malformed'],
  ['sync2: skills/permissions/fork/delete/persona/schedule/MCP in a real dsh runtime', 'live', 'compat-runtime'],
  ['plugin compat matrix, 12 areas × 2 load orders (in-process)', 'plugin-compat-matrix', "for (const order of ['adapter-last', 'adapter-first'])"],
  ['plugin compat matrix in a real plain dsh web profile', 'live', 'plain-dsh'],
  ['fix 1 dispose/archive keeps persisted Jiuwen session', 'plain-dsh-web', 'never deletes a session still in persistence'],
  ['fix 2 preset-scoped skills', 'plain-dsh-web', 'agent-preset scoped skills'],
  ['fix 3 cwd seeded on first header', 'plain-dsh-web', 'agent-preset scoped skills'],
  ['fix 4 payload-less schedule/changed', 'plain-dsh-web', 'payload-less schedule/changed'],
  ['fix 5 fork turn waits for remap', 'plain-dsh-web', 'fork remap is awaitable'],
  ['fix 6 preset-scoped plan bridge', 'plain-dsh-web', 'plan bridge uses the agent preset'],
  ['fix 7 {{var}} personas', 'persona-generic', 'interpolated {{vars}}'],
  ['fix 8 single session.delete', 'plain-dsh-web', 'single session.delete (no double call)'],
  ['memory: AGENTS.md (dsh-agent-instructions) + session-reference context reach Jiuwen with the prompt', 'memory-plugins', 'forwarded to Jiuwen with the prompt'],
  ['memory: no resend of memory context on later Jiuwen turns', 'memory-plugins', 'only the new trailing messages'],
  ['memory: session-query tools skip the passthrough approval gate (fix)', 'mcp-bridge', 'memory plugins: read-only session-query tools'],
  ['memory: plugin compat matrix row', 'plugin-compat-matrix', 'memory: agent-instructions, session-reference, session-search'],
  ['memory: real plain dsh profiles, both load orders, non-jiuwen + jiuwen', 'live-plain-dsh', 'memoryChecks'],
]

test('scenario catalog: every scenario points at an existing test', () => {
  const missing = []
  for (const [name, file, needle] of SCENARIOS) {
    const src = file === 'live' ? readFileSync(new URL('./live/run.mjs', import.meta.url), 'utf8') : file === 'live-plain-dsh' ? readFileSync(new URL('./live/plain-dsh.mjs', import.meta.url), 'utf8') : readFileSync(new URL(`./${file}.test.js`, import.meta.url), 'utf8')
    if (!src.includes(needle)) missing.push(`${name} → ${file}: ${needle}`)
  }
  assert.deepEqual(missing, [])
})
