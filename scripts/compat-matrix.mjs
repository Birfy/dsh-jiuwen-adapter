#!/usr/bin/env node
/**
 * Runs scripts/compat-runtime.mjs without the adapter and in each adapter variant, and prints a
 * feature × variant matrix of A/B identity. `--live` adds runs against the real Gateway
 * (JIUWEN_GATEWAY_URL or ws://127.0.0.1:19000/ws). Exit code 1 if any cell differs.
 */
import { execFileSync, spawn } from 'node:child_process'
const ROOT = new URL('..', import.meta.url).pathname
const LIVE = process.argv.includes('--live')
const GW = process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
const run = (...a) => JSON.parse(execFileSync(process.execPath, [`${ROOT}scripts/compat-runtime.mjs`, ...a], { encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'ignore'] }))
// Private mock Gateway (echoes the query) so a jiuwen agent's prompt is checked without a live Gateway.
const MOCK_PORT = 20000 + Math.floor(Math.random() * 20000)
const mock = spawn(process.execPath, [`${ROOT}bin/mock-gateway.mjs`], { env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'ignore'] })
await new Promise(r => mock.stdout.on('data', d => /listening/.test(String(d)) && r()))
process.on('exit', () => mock.kill('SIGKILL'))
const runAsync = (...a) => new Promise((res, rej) => { const c = spawn(process.execPath, [`${ROOT}scripts/compat-runtime.mjs`, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }); let o = ''; c.stdout.on('data', d => o += d); c.on('exit', () => { try { res(JSON.parse(o)) } catch (e) { rej(e) } }) })
const VARIANTS = [
  ['mock/mixed', ['--jiuwen', `--gateway=ws://127.0.0.1:${MOCK_PORT}/ws`, '--mixed']],
  ['down/after', ['--jiuwen', '--down']], ['down/before', ['--jiuwen', '--down', '--order=before']],
  ['down/two', ['--jiuwen', '--down', '--two']], ['down/mixed', ['--jiuwen', '--down', '--mixed']],
  ...(LIVE ? [['live/after', ['--jiuwen', `--gateway=${GW}`]], ['live/mixed', ['--jiuwen', `--gateway=${GW}`, '--mixed']], ['live/two+before+mixed', ['--jiuwen', `--gateway=${GW}`, '--two', '--order=before', '--mixed']]] : []),
]
const strip = l => l.filter(x => !/^(jiuwen|jwb)/.test(x))
const FEATURES = {
  'session events (normalized)': r => r.eventsHash,
  'approval approve+deny': r => r.approvals,
  'tool calls (todo/guarded/ask/mcp)': r => r.results.filter(x => x.startsWith('say:CALL')),
  'ask-user answers': r => r.questions,
  'commands.execute results': r => r.results.filter(x => x.startsWith('/')),
  'tool list (agent view)': r => strip(r.tools),
  'command list (agent view)': r => strip(r.cmds),
  'session title': r => r.title,
  'token meter': r => r.tokens,
  'host event names': r => r.hostEvents,
  'host event counts': r => r.hostEventCounts,
  'providers after dispose': r => r.afterDispose.providers,
  'globals/env/proto/process': r => r.globals,
  'unhandled rejections': r => r.unhandled,
  'plugin load failures': r => r.failed,
}
const base = run()
const rows = [], extra = {}
let ok = true
const results = []
for (const [name, args] of VARIANTS) results.push([name, name.startsWith('mock/') ? await runAsync(...args) : run(...args)])
for (const [feat, f] of Object.entries(FEATURES)) {
  const cells = results.map(([, r]) => JSON.stringify(f(r)) === JSON.stringify(f(base)))
  if (cells.includes(false)) ok = false
  rows.push([feat, ...cells.map(c => (c ? 'identical' : 'DIFF'))])
}
for (const [name, r] of results) extra[name] = { jwOut: r.jwOut, nonNamespaced: r.nonNamespacedFromJiuwen, serviceAfterDispose: r.afterDispose.service }
const out = { baseline: { events: base.eventCount, types: base.types.length, deepseek: base.deepseek }, header: ['feature', ...VARIANTS.map(v => v[0])], rows, extra, ok }
console.log(JSON.stringify(out, null, 1))
if (process.argv.includes('--diff') && !ok) for (const [name, r] of results) for (const [feat, f] of Object.entries(FEATURES)) if (JSON.stringify(f(r)) !== JSON.stringify(f(base))) console.error(`[${name}] ${feat}\n  base: ${JSON.stringify(f(base)).slice(0, 600)}\n  this: ${JSON.stringify(f(r)).slice(0, 600)}`)
process.exit(ok ? 0 : 1)
