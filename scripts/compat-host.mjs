#!/usr/bin/env node
/**
 * Real-host compatibility probe: a Cordis Context with every real dsh plugin we can load
 * (DSH_NM, default: the dev harness node_modules), run with and without the jiuwen adapter
 * and print a JSON report. Usage: node scripts/compat-host.mjs [--jiuwen] [--order=before|after]
 * [--gateway=ws://…] [--two] [--down]
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const keepAlive = setInterval(() => {}, 1000)
const trace = (...a) => process.env.COMPAT_TRACE && console.error('[trace]', ...a)
const args = new Set(process.argv.slice(2))
const opt = k => [...args].find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const WITH = args.has('--jiuwen')
const ORDER = opt('order') || 'after'
const GW = args.has('--down') ? 'ws://127.0.0.1:1/ws' : (opt('gateway') || process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws')
const NM = process.env.DSH_NM || '/workspace/fb-busyack3/core/dev/harness/node_modules'
const ROOT = new URL('..', import.meta.url).pathname
const PLUGINS = ['dsh-llm', 'dsh-commands', 'dsh-user-questions', 'dsh-user-approval', 'dsh-attachment', 'dsh-session', 'dsh-compaction', 'dsh-compaction-basic', 'dsh-token-meter', 'dsh-plan-mode', 'dsh-goal', 'dsh-command-goal', 'dsh-command-compact', 'dsh-tools', 'dsh-tool-ask-user', 'dsh-tool-todo', 'dsh-workflow', 'dsh-llm-retry', 'dsh-llm-pi-ai', 'dsh-session-title', 'dsh-mcp-client']

const unhandled = []
process.on('unhandledRejection', e => unhandled.push(String(e?.message || e)))
process.on('uncaughtException', e => unhandled.push(`uncaught:${e?.message || e}`))

const protoNames = () => Object.fromEntries([Object, Array, Function, String, Promise, Map, Set, Error, EventTarget, globalThis.WebSocket].filter(Boolean)
  .map(C => [C.name, Object.getOwnPropertyNames(C.prototype).sort().join(',')]))
const procListeners = () => Object.fromEntries(process.eventNames().map(n => [String(n), process.listenerCount(n)]))
const resources = () => process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap').reduce((o, r) => (o[r] = (o[r] || 0) + 1, o), {})
const h = v => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms))

const before = { globals: Object.getOwnPropertyNames(globalThis).sort(), protos: protoNames(), env: h(process.env), proc: procListeners() }

const { Context } = await import(pathToFileURL(join(NM, '@deepseek-ai/cordis/lib/index.js')).href)
// Event tap (harness only): record every emit name.
const emitted = []
for (const k of ['emit', 'parallel', 'serial', 'bail']) {
  const orig = Context.prototype[k]
  if (typeof orig === 'function') Context.prototype[k] = function (...a) { const n = typeof a[0] === 'string' ? a[0] : typeof a[1] === 'string' ? a[1] : undefined; if (typeof n === 'string') emitted.push(n); return orig.apply(this, a) }
}
const LlmBase = (await import(pathToFileURL(join(NM, '@deepseek-ai/dsh-llm/lib/index.js')).href)).LlmAdapter
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${label}`)), ms))])
const ctx = new Context()
const loaded = [], failed = []
async function loadOthers() {
  for (const n of PLUGINS) {
    try { const m = await import(pathToFileURL(join(NM, '@deepseek-ai', n, 'lib/index.js')).href); const f = ctx.plugin(m.default || m, {}); Promise.resolve(f).catch(e => failed.push(`${n}: ${String(e?.message || e).slice(0, 80)}`)); loaded.push(n) } catch (e) { failed.push(`${n}: ${String(e?.message || e).slice(0, 80)}`) }
  }
  await tick(500)
}
// Deterministic non-jiuwen provider + command + tool for A/B diffing.
const fakeCalls = []
async function loadFake() {
  const pf = ctx.plugin({ name: 'compat-fake', inject: ['llm'], apply(c) {
    class Fake extends LlmBase {
      listModels() { return Promise.resolve([{ provider: 'fake', id: 'fake-1', name: 'Fake' }]) }
      async *stream(req) { fakeCalls.push(req.sessionId); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: `fake:${req.messages?.length}` }; yield { type: 'block-end', index: 0, block: { type: 'text', text: `fake:${req.messages?.length}` } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
    try { c.llm.registerAdapter(['fake'], new Fake()) } catch (e) { trace('fake reg', e.message) }
    trace('fake applied')
  } })
  Promise.resolve(pf).catch(e => trace('fake fail', e?.message)); trace('pf', typeof pf, Object.keys(pf||{}).slice(0,8))
  ctx.plugin({ name: 'compat-fake-cmd', inject: ['commands'], apply(c) { c.commands.register({ name: 'fakecmd', description: 'x', handler: async () => ({ kind: 'success', text: 'fake-cmd-ok' }) }) } })
  await tick(300)
}
const SVC = ['llm', 'commands', 'userQuestions', 'approval', 'attachments', 'sessions', 'compaction', 'tokenMeter', 'planMode', 'goals', 'tools', 'systemPrompt', 'sessionProjections', 'agents', 'workflows', 'mcp']
const svcRefs = () => Object.fromEntries(SVC.map(n => { let v; try { v = ctx.get?.(n) ?? ctx[n] } catch {} ; return [n, v === undefined ? '-' : Object.keys(v).sort().join(',') + '/' + Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}).sort().join(',')] }))

const dir = mkdtempSync(join(tmpdir(), 'jw-compat-'))
let jw = [], jwErr
async function loadJiuwen() {
  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  try {
    jw.push(ctx.plugin(plugin, { gatewayURL: GW, mappingPath: join(dir, 'a.json'), requestTimeoutMs: 15_000, mode: 'gateway' }))
    if (args.has('--two')) jw.push(ctx.plugin(plugin, { gatewayURL: GW, mappingPath: join(dir, 'b.json'), provider: 'jiuwen-b', commandName: 'jwb', serviceName: 'jiuwenAdapterB', mode: 'gateway' }))
  } catch (e) { jwErr = String(e?.message || e) }
  await tick(500)
}

const listCommands = () => { const c = ctx.get?.('commands') ?? ctx.commands; const l = c?.list?.() ?? c?.registry?.list?.() ?? [...(c?.commands?.keys?.() || [])]; return (Array.isArray(l) ? l : [...l]).map(x => (typeof x === 'string' ? x : x.name)).sort() }
async function scenario() {
  trace('get llm'); const llm = ctx.get?.('llm') ?? ctx.llm
  trace('got llm', typeof llm?.stream)
  const chunks = []
  await withTimeout((async () => { for await (const c of llm.stream({ provider: 'fake', model: 'fake-1', sessionId: 'nonjw-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(c) })(), 10_000, 'fake-stream').catch(e => chunks.push({ type: 'harness-error', e: e.message }))
  trace('streamed', chunks.map(c=>c.type).join(','))
  const providers = (llm.listProviders?.() ?? []).map(p => p.id || p).sort()
  const fakeModels = await withTimeout(Promise.resolve(llm.listModels?.('fake')), 3000, 'models').catch(e => e.message)
  trace('providers', providers)
  const cmds = listCommands()
  trace('cmds', cmds.length)
  let fakeCmd
  try { const c = ctx.get?.('commands') ?? ctx.commands; fakeCmd = c.execute ? await withTimeout(c.execute({ id: 'nonjw-1' }, '/fakecmd', [], new AbortController().signal), 5000, 'cmd') : 'no-execute' } catch (e) { fakeCmd = `ERR ${e.message}` }
  return { chunks, providers, fakeModels, cmds, fakeCmd: fakeCmd?.text ?? fakeCmd }
}

trace('start'); if (WITH && ORDER === 'before') await loadJiuwen()
await loadOthers(); await loadFake()
trace('others loaded', loaded.length); const refsBefore = svcRefs()
if (WITH && ORDER === 'after') await loadJiuwen()
const refsAfter = svcRefs()
const emittedBase = emitted.length
trace('scenario'); const run = await scenario()
const nonJwEvents = emitted.slice(emittedBase)
let jwTurn, jwCmd
const api = ctx.get?.('jiuwenAdapter') ?? ctx.jiuwenAdapter
if (WITH && api) {
  try { jwCmd = String(await api.command('jw-compat', 'status')).slice(0, 80) } catch (e) { jwCmd = `THROW ${e.message}` }
  try {
    const llm = ctx.get?.('llm') ?? ctx.llm; let t = ''
    for await (const c of llm.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'jw-compat', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: compat-ok' }] }] })) if (c.type === 'text-delta') t += c.text; else if (c.type !== 'block-start' && c.type !== 'block-end') t += `[${c.type}:${c.error?.code || c.reason?.kind || ''}]`
    jwTurn = t.slice(0, 80)
  } catch (e) { jwTurn = `THROW ${String(e.message).slice(0, 80)}` }
  if (!args.has('--down')) try { await api.command('jw-compat', 'delete confirm') } catch {}
}
const runAfter = await scenario() // non-jiuwen still identical after a jiuwen turn
// Dispose jiuwen only; host + others must keep working.
for (const f of jw) { try { f.dispose?.() ?? f.scope?.dispose?.() } catch (e) { jwErr = `dispose: ${e.message}` } }
await tick(300)
const runDisposed = await scenario()
const after = { globals: Object.getOwnPropertyNames(globalThis).sort(), protos: protoNames(), env: h(process.env), proc: procListeners() }
const strip = r => ({ ...r, cmds: r.cmds.filter(c => !/^(jiuwen|jwb)$/.test(c)), providers: r.providers.filter(p => !/^jiuwen/.test(p)) })
const report = {
  with: WITH, order: ORDER, two: args.has('--two'), down: args.has('--down'),
  loaded: loaded.length, failed,
  servicesUnchanged: SVC.every(n => refsBefore[n] === refsAfter[n]),
  nonJiuwen: h(strip(run)), nonJiuwenAfterJwTurn: h(strip(runAfter)), nonJiuwenAfterDispose: h(strip(runDisposed)),
  fakeCmd: run.fakeCmd, chunkTypes: run.chunks.map(c => c.type).join(','),
  providers: run.providers, cmds: run.cmds.filter(c => /jiuwen|jwb|fakecmd|goal|compact/.test(c)),
  providersAfterDispose: runDisposed.providers, cmdsAfterDispose: runDisposed.cmds.filter(c => /jiuwen|jwb/.test(c)),
  nonJwEvents: [...new Set(nonJwEvents)].sort(),
  foreignEventsFromJiuwen: [...new Set(emitted.filter(n => /jiuwen/i.test(n) && !n.startsWith('jiuwen/')))],
  jwEvents: [...new Set(emitted.filter(n => n.startsWith('jiuwen/')))].sort(),
  jwCmd, jwTurn, jwErr,
  globalsAdded: after.globals.filter(g => !before.globals.includes(g)),
  protosChanged: Object.keys(after.protos).filter(k => after.protos[k] !== before.protos[k]),
  envChanged: after.env !== before.env,
  procListenersDelta: Object.fromEntries(Object.entries(after.proc).filter(([k, v]) => v !== (before.proc[k] || 0))),
  resourcesAfterDispose: resources(),
  unhandled,
}
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(report))
setTimeout(() => process.exit(0), 50).unref()
await tick(400)
process.exit(0)
