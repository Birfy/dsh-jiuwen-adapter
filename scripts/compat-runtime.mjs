#!/usr/bin/env node
/**
 * Full-agent-runtime compatibility probe. Composes a real dsh agent runtime (dsh-agent + dsh-agent-loop
 * + session/persistence/system-prompt/tools/approval/questions/compaction/goal/plan/title/token-meter/
 * llm-retry/todo/ask-user/mcp-client, rows modelled on the shipped sdk-minimal and base bundles) with a
 * deterministic scripted provider `fake`, drives one NON-jiuwen agent through a fixed scenario and prints
 * a normalized, byte-comparable report. Run with and without the jiuwen adapter and diff.
 *
 *   node scripts/compat-runtime.mjs [--jiuwen] [--order=before|after] [--two] [--mixed]
 *        [--gateway=ws://…|--down] [--no-deepseek]
 * --mixed runs a jiuwen session concurrently with the non-jiuwen scenario.
 * DSH_NM points at a node_modules tree holding @deepseek-ai/* (read-only use).
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const keepAlive = setInterval(() => {}, 1000)
const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const opt = k => argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const WITH = has('--jiuwen'), ORDER = opt('order') || 'after', MIXED = has('--mixed'), TWO = has('--two')
const GW = has('--down') || !opt('gateway') ? 'ws://127.0.0.1:1/ws' : opt('gateway')
const NM = join(process.env.DSH_NM || '/workspace/fb-busyack3/core/dev/harness/node_modules', '@deepseek-ai')
const ROOT = new URL('..', import.meta.url).pathname
const tick = ms => new Promise(r => setTimeout(r, ms))
const imp = n => import(pathToFileURL(join(NM, n, 'lib/index.js')).href)
const trace = (...a) => process.env.COMPAT_TRACE && console.error('[trace]', ...a)
const unhandled = []
process.on('unhandledRejection', e => unhandled.push(String(e?.message || e)))

const snapGlobals = () => ({ g: Object.getOwnPropertyNames(globalThis).sort(), env: createHash('sha1').update(JSON.stringify(process.env)).digest('hex'), p: [Object, Array, Function, String, Promise, Map, Set, Error, EventTarget].map(C => Object.getOwnPropertyNames(C.prototype).sort().join()).join('|'), l: process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).sort().join() })
const g0 = snapGlobals()

const { Context } = await imp('cordis')
const emitted = []
const ctx = new Context()
// Attribute each dispatch to the jiuwen side when it belongs to a jiuwen provider call or to the
// concurrent jiuwen agent/session, so the non-jiuwen agent's own host traffic can be compared alone.
const JW_SIDS = new Set(['jw-mixed'])
const sidOf = x => { try { return x?.sessionId ?? x?.session?.id ?? x?.agent?.session?.id ?? x?.agent?.id ?? (typeof x?.id === 'string' ? x.id : undefined) } catch { return undefined } }
ctx.on('internal/dispatch', (_type, name, args) => {
  if (typeof name !== 'string') return
  const a = Array.isArray(args) ? args : []
  const jwSide = a.some(x => { const p = x?.provider ?? x?.request?.provider; return (typeof p === 'string' && /^jiuwen/.test(p)) || JW_SIDS.has(sidOf(x)) })
  emitted.push(jwSide ? `jiuwen/<host:${name}>` : name)
})
const home = mkdtempSync(join(tmpdir(), 'jw-rt-'))
const failed = []
const SANDBOX = join(home, 'sandbox')
mkdirSync(SANDBOX, { recursive: true })
const load = async (n, cfg = {}) => { try { const m = await imp(n); Promise.resolve(ctx.plugin(m.default || m, cfg)).catch(e => failed.push(`${n}: ${String(e?.message || e).slice(0, 100)}`)) } catch (e) { failed.push(`${n}: import ${String(e?.message || e).slice(0, 100)}`) } }
const ROWS = [
  ['cordis-plugin-timer'], ['dsh-llm'], ['dsh-session'], ['dsh-session-projection'],
  ['dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' }],
  ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'You are a test agent.' }],
  ['dsh-tools'], ['dsh-agent'], ['dsh-llm-retry'], ['dsh-agent-loop', { agents: [] }],
  ['dsh-token-meter'], ['dsh-compaction-basic', { modelPolicies: [{ provider: 'fake', model: 'fake-small', thresholdRatio: 0.5, headroomTokens: 0, retainTokens: 200, maxTokens: 256 }] }], ['dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }],
  ['dsh-commands'], ['dsh-command-compact'], ['dsh-goal'], ['dsh-goal-round-driver'], ['dsh-command-goal'], ['dsh-tool-goal'],
  ['dsh-plan-mode', { section: 'You are in plan mode.' }],
  ['dsh-user-approval', { policy: 'ask' }], ['dsh-user-questions'], ['dsh-tool-todo', { allowParallelInProgress: true }], ['dsh-tool-ask-user'],
  ['dsh-attachment'],
  ['dsh-mcp-client', { transport: 'stdio', serverName: 'echo', command: process.execPath, args: [join(ROOT, 'scripts/fixtures/mcp-echo.mjs')] }],
  // Bash inside a temp sandbox dir, and in-process subagents (rows from the shipped base bundle).
  ['dsh-subprocess-local'], ['dsh-sandbox-local'], ['dsh-fs-local'],
  ['dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: SANDBOX }],
  ['dsh-working-directory'], ['dsh-shell-env'], ['dsh-bash-local'], ['dsh-tool-bash'],
  ['dsh-subagent'], ['dsh-subagent-spawn-in-process', { providerName: 'spawn' }], ['dsh-tool-subagent', { provider: 'spawn', toolName: 'subagent' }],
]
let deepseek = 'skipped'
async function loadDeepseek() {
  // dsh-llm-deepseek is a library (adapter classes), not a Cordis plugin; the plugin is dsh-llm-deepseek-api-key.
  try {
    const m = await imp('dsh-llm-deepseek-api-key')
    await new Promise(res => { Promise.resolve(ctx.plugin(m.default || m, { apiKeyEnv: 'JIUWEN_COMPAT_NO_SUCH_KEY', defaultContextWindow: 100000 })).then(() => res(), e => { deepseek = `fail: ${String(e?.message || e).slice(0, 80)}`; res() }); setTimeout(res, 800) })
    if (deepseek === 'skipped') deepseek = 'loaded'
  } catch (e) { deepseek = `import fail: ${String(e?.message || e).slice(0, 80)}` }
}

// ---- deterministic scripted provider -------------------------------------------------
const { LlmAdapter, LlmError, resolveRetryPolicy } = await imp('dsh-llm')
const { defineTool } = await imp('dsh-tools')
let flaky = 0
const textOf = m => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
class Scripted extends LlmAdapter {
  listModels() { return Promise.resolve([{ provider: 'fake', id: 'fake-1', name: 'Fake', contextWindow: 100000 }, { provider: 'fake', id: 'fake-small', name: 'Fake small window', contextWindow: 1500, maxTokens: 200 }]) }
  resolveModel(p, m) { return Promise.resolve({ provider: p, id: m, name: m, context: { contextWindow: m === 'fake-small' ? 1500 : 100000 }, defaultMaxTokens: m === 'fake-small' ? 200 : 4096 }) }
  providerRetryPolicy() { try { return resolveRetryPolicy?.({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 2 } }) } catch { return undefined } }
  async *stream(o) {
    const msgs = o.messages || []
    if (process.env.COMPAT_MSGS) process.stderr.write('[msgs] ' + JSON.stringify(msgs.map(m => [m.role, m.source?.kind, m.type, textOf(m).slice(0, 50)])) + '\n')
    const last = msgs[msgs.length - 1]
    // Realistic usage (~4 chars/token over the whole request) so token pressure is real for the small-window model.
    const inTok = Math.ceil(JSON.stringify(msgs.map(x => x.content)).length / 4)
    const text = textOf(last)
    const isUser = last?.source?.kind === 'user' || (last?.role === 'user' && last?.source?.kind !== 'goal')
    if (isUser && text === 'FLAKY' && flaky++ === 0) throw new LlmError('scripted transient failure', 'SERVER')
    let m = isUser && /^CALL (\S+) (.*)$/s.exec(text)
    if (process.env.COMPAT_MSGS) process.stderr.write('[last] ' + JSON.stringify([last?.role, last?.source?.kind, text.slice(0, 120)]) + '\n')
    // get_goal answers {"goal":{"id","revision",...}}: complete it (a deterministic one-round goal).
    const goalHit = last?.role === 'tool' && /^\{"goal":\{"id":"([^"]+)","revision":(\d+)/.exec(text)
    if (!m && goalHit) m = [null, 'update_goal', JSON.stringify({ goal_id: goalHit[1], revision: Number(goalHit[2]), action: 'complete' })]
    if (!m && last?.source?.kind === 'goal' && /<goal_round>/.test(text)) m = [null, 'get_goal', '{}']
    let out
    if (m) {
      const id = `call-${msgs.length}`
      lastCalls.push({ name: m[1], arguments: m[2] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: m[1], argumentsDelta: m[2] }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: m[1], arguments: m[2] } }
      yield { type: 'usage', usage: { inputTokens: inTok, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    out = `reply#${msgs.length}:${(isUser ? text : JSON.stringify(last?.content ?? '')).slice(0, 60)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: out }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: out } }
    yield { type: 'usage', usage: { inputTokens: inTok, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const approvals = [], questions = [], lastCalls = []
async function loadHarnessPlugins() {
  ctx.plugin({ name: 'compat-fake-provider', inject: ['llm'], apply(c) { c.llm.registerAdapter(['fake'], new Scripted()) } })
  ctx.plugin({ name: 'compat-guarded-tool', inject: ['tools'], apply(c) {
    c.tools.register(defineTool({ name: 'guarded', description: 'A tool that needs approval.', parameters: { decision: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, async execute(args) { return `guarded-ran:${args.decision}` } }))
    c.on('tools/pre-execute', (exec, next) => exec.name === 'guarded' ? { kind: 'ask', reason: 'guarded needs approval' } : next())
    c.on('user-questions/request', (req) => { questions.push(req.questions.map(q => `${q.id}${q.intent ? `:${q.intent.kind}` : ''}`).join()); return { answers: req.questions.map(q => ({ id: q.id, selected: [q.intent?.approve ?? q.options?.[0]?.label ?? 'yes'] })) } })
  } })
  await tick(300)
}

// ---- jiuwen adapter ----------------------------------------------------------------------
const jw = []
async function loadJiuwen() {
  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  jw.push(ctx.plugin(plugin, { gatewayURL: GW, mappingPath: join(home, 'jw-a.json'), requestTimeoutMs: 60_000, mode: 'gateway' }))
  if (TWO) jw.push(ctx.plugin(plugin, { gatewayURL: GW, mappingPath: join(home, 'jw-b.json'), provider: 'jiuwen-b', commandName: 'jwb', serviceName: 'jiuwenAdapterB', mode: 'gateway' }))
  await tick(500)
}

// ---- normalization ------------------------------------------------------------------------
const DROP = new Set(['time', 'time0', 'dt', 'delayMs', 'durationMs', 'elapsedMs', 'startedAt', 'endedAt', 'createdAt', 'updatedAt', 'ts', 'firstTokenMs', 'latencyMs'])
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function normalizer() {
  const ids = new Map()
  const tok = s => { if (!ids.has(s)) ids.set(s, `<id${ids.size}>`); return ids.get(s) }
  const walk = v => {
    if (typeof v === 'string') return v.replace(UUID, tok).replace(/\b[0-9a-f]{8}-[0-9a-f]{1,4}(-[0-9a-f]{0,12})*/gi, '<uuid-prefix>').replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<home>')
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k) && !/At$/.test(k)).map(([k, x]) => [k, (/(^id$|Id$)/.test(k) && typeof x === 'string') ? tok(x) : walk(x)]))
    if (typeof v === 'number' && v > 1.6e12 && v < 2.2e12) return '<epoch>'
    return v
  }
  return walk
}

// ---- scenario ------------------------------------------------------------------------------
const SCRIPT = [
  ['say', 'hello world'],
  ['say', 'CALL todo_write {"todos":[{"content":"write tests","status":"in_progress"},{"content":"ship","status":"pending"}]}'],
  ['say', 'CALL guarded {"decision":"allow"}'],
  ['say', 'CALL guarded {"decision":"deny"}'],
  ['say', 'CALL ask_user_question {"questions":[{"id":"q1","question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]}]}'],
  ['say', 'CALL mcp__echo__echo {"text":"ping"}'],
  ['say', 'FLAKY'],
  ['cmd', '/goal Ship the compat suite'],
  ['cmd', '/goal'],
  ['cmd', '/goal pause'],
  ['cmd', '/plan'],
  ['say', 'plan something'],
  ['cmd', '/plan off'],
  ['cmd', '/compact'],
  ['say', 'after compact'],
  ['cmd', '/goal clear'],
  ['cmd', '/nosuchcommand'],
  ['say', `CALL bash ${JSON.stringify({ description: 'Write and read a file', command: 'echo sandboxed > a.txt && cat a.txt && ls', workdir: SANDBOX })}`],
  ['say', 'CALL subagent {"description":"child task","prompt":"child: say hi"}'],
  ['wait-subagent', 'settled'],
  ['cmd', '/plan'],
  ['say', 'CALL exit_plan_mode {"plan":"# Compat plan\\n- step one\\n- step two"}'],
  ['say', 'after plan approval'],
  ['cmd', '/goal Finish the scripted goal'],
  ['say', 'start working on the goal'],
  ['wait-goal', 'complete'],
]
/** A second agent on a 1.5k-token window: long turns must trigger automatic compaction. */
const SMALL = Array.from({ length: 6 }, (_, i) => ['say', `long turn ${i}: ${'lorem ipsum dolor sit amet '.repeat(40)}`])
async function runScenario(sid, script = SCRIPT, model = 'fake-1') {
  const h = await ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'fake', model }, setup: (agentCtx) => {
    // Terminal approval answerer, agent-scoped as dsh-user-approval requires. Decision comes from the call's args.
    agentCtx.on('approval/request', (req) => {
      const call = [...lastCalls].reverse().find(c => c.name === req.toolName || c.name === req.tool) ?? {}
      const out = /"decision"\s*:\s*"allow"/.test(call.arguments ?? '') ? 'allowed-once' : 'rejected'
      approvals.push(`${req.toolName ?? req.tool}:${out}`); return out
    })
  } })
  const a = h.agent
  const results = []
  for (const [kind, text] of script) {
    if (kind === 'wait-subagent') {
      // The background child reports back as a 'subagent-settled' message; wait for it so ordering is fixed.
      const until = Date.now() + 15_000
      const done = () => a.session.snapshotEvents().some(e => e.type === 'user/message' && e.data?.source?.kind === 'subagent-settled')
      while (!done() && Date.now() < until) { await tick(50); await a.whenIdle() }
      await a.whenIdle()
      results.push(`wait-subagent:${done() ? 'settled' : 'timeout'}`)
      continue
    }
    if (kind === 'wait-goal') {
      // Goal rounds start only at whole-agent idle: wait for the scripted round to complete the goal.
      const until = Date.now() + 15_000
      const done = () => a.session.snapshotEvents().some(e => e.type === 'goal/change' && /complete/.test(JSON.stringify(e.data)))
      while (!done() && Date.now() < until) { await tick(100); await a.whenIdle() }
      results.push(`wait-goal:${done() ? 'complete' : 'timeout'}`)
      continue
    }
    if (kind === 'say') { a.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } }); await a.whenIdle(); results.push(`say:${text.slice(0, 20)}`) } else {
      try { const r = await ctx.commands.execute(a, text, [], new AbortController().signal); results.push(r ? `${text} => ${r.result.kind}: ${String(r.result.text ?? '').slice(0, 120)}` : `${text} => (unresolved)`) } catch (e) { results.push(`${text} => THROW ${e.message}`) }
      await a.whenIdle()
    }
  }
  const tools = ctx.tools.schemas(a).map(s => s.name).sort()
  const cmds = ctx.commands.list(a).map(c => c.name).sort()
  const tokens = (() => { try { const hdr = [...a.session.snapshotEvents()].reverse().find(e => e.type === 'request/header')?.data?.header; return ctx.get('tokenMeter')?.measure?.(a.session, hdr) ?? null } catch (e) { return `ERR ${e.message}` } })()
  const events = a.session.snapshotEvents()
  const report = { events, results, tools, cmds, tokens, title: events.filter(e => e.type === 'session/title').map(e => e.data.title), types: events.map(e => e.type) }
  await h.dispose()
  return report
}

if (WITH && ORDER === 'before') await loadJiuwen()
for (const [n, c] of ROWS) await load(n, c)
if (!has('--no-deepseek')) await loadDeepseek()
await tick(1500)
await loadHarnessPlugins()
if (WITH && ORDER === 'after') await loadJiuwen()
trace('loaded; failed:', failed)
if (process.env.COMPAT_SCHEMAS) { for (const t of ctx.tools.schemas()) if (/exit_plan|update_goal|subagent|bash|create_goal/.test(t.name)) console.error('[schema]', t.name, JSON.stringify(t.parameters).slice(0, 700)); console.error('[services]', ['shell', 'shellEnv', 'workingDirectory', 'subagents', 'sandbox', 'subprocess'].map(n => `${n}:${ctx.get(n) !== undefined}`).join(' ')) }

const api = ctx.get('jiuwenAdapter')
let jwSide
const base = emitted.length
const scenario = runScenario('nonjw-main')
if (WITH && MIXED && api) {
  jwSide = (async () => {
    const out = []
    try { out.push(String(await api.command('jw-mixed', 'status')).slice(0, 60)) } catch (e) { out.push(`THROW ${e.message}`) }
    try {
      // A real dsh agent on the jiuwen provider, driven by dsh-agent-loop concurrently with the non-jiuwen agent.
      const jh = await ctx.agents.create({ sessionId: 'jw-mixed', agentOptions: { provider: 'jiuwen', model: 'jiuwen-default' } })
      jh.agent.followup({ content: [{ type: 'text', text: 'Reply with exactly: mixed-ok' }], source: { kind: 'user' } })
      await Promise.race([jh.agent.whenIdle(), tick(90_000)])
      const evs = jh.agent.session.snapshotEvents()
      const txt = evs.filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).join('|')
      const errs = evs.filter(e => /error|failed|retry/.test(e.type) || e.data?.reason?.kind === 'error').map(e => e.type)
      out.push(`agent:${txt.slice(0, 80)}${errs.length ? ` [${[...new Set(errs)].join(',')}]` : ''}`)
      out.push(`jiuwenInAgentView:cmd=${ctx.commands.list(jh.agent).some(c => c.name === 'jiuwen')}`)
      await jh.dispose()
    } catch (e) { out.push(`THROW ${String(e.message).slice(0, 80)}`) }
    if (!GW.includes(':1/')) try { await api.command('jw-mixed', 'delete confirm') } catch {}
    return out
  })()
}
const rep = await scenario
const small = await runScenario('nonjw-small', SMALL, 'fake-small')
rep.events = [...rep.events, ...small.events]; rep.types = [...rep.types, ...small.types]; rep.results = [...rep.results, ...small.results.map(r => `small:${r}`)]
const jwOut = await jwSide
const scenarioEvents = emitted.slice(base)
const norm = normalizer()
const ev = norm(rep.events)
for (const f of jw) { try { f.dispose?.() } catch (e) { failed.push(`dispose ${e.message}`) } }
await tick(500)
const g1 = snapGlobals()
const out = {
  with: WITH, order: ORDER, two: TWO, mixed: MIXED, gateway: GW, deepseek, failed,
  eventsHash: createHash('sha1').update(JSON.stringify(ev)).digest('hex').slice(0, 16),
  eventCount: rep.events.length, types: [...new Set(rep.types)].sort(),
  scenarios: {
    planExit: ev.filter(e => e.type === 'tool/result' && /Plan approved/.test(JSON.stringify(e.data))).length,
    goalOps: ev.filter(e => e.type === 'goal/change').map(e => e.data.operation),
    goalRounds: ev.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'goal').length,
    autoCompactions: ev.filter(e => e.type === 'compaction/start' && !e.data.sourceCommandId).length,
    manualCompactions: ev.filter(e => e.type === 'compaction/start' && e.data.sourceCommandId).length,
    subagent: ev.filter(e => e.type === 'user/message' && e.data?.source?.kind === 'subagent-settled').length,
    bash: ev.filter(e => e.type === 'tool/result' && /sandboxed\\na\.txt/.test(JSON.stringify(e.data))).length,
  },
  results: rep.results, tools: rep.tools, cmds: rep.cmds, title: rep.title, tokens: norm(rep.tokens),
  approvals, questions,
  hostEvents: [...new Set(scenarioEvents.filter(n => !n.startsWith('jiuwen/')))].sort(),
  hostEventCountsRaw: scenarioEvents.filter(n => !n.startsWith('jiuwen/') && !/^internal\//.test(n)).reduce((o, n) => (o[n] = (o[n] || 0) + 1, o), {}),
  hostEventCounts: createHash('sha1').update(JSON.stringify(scenarioEvents.filter(n => !n.startsWith('jiuwen/') && !/^internal\//.test(n)).reduce((o, n) => (o[n] = (o[n] || 0) + 1, o), {}))).digest('hex').slice(0, 12),
  nonNamespacedFromJiuwen: [...new Set(scenarioEvents.filter(n => /jiuwen/i.test(n) && !n.startsWith('jiuwen/')))],
  jwOut,
  afterDispose: { providers: ctx.llm.listProviders().map(p => p.id).sort(), service: ctx.get('jiuwenAdapter') === undefined ? 'gone' : 'present' },
  globals: { added: g1.g.filter(x => !g0.g.includes(x)), envSame: g0.env === g1.env, protoSame: g0.p === g1.p, procListeners: g1.l },
  unhandled,
}
if (process.env.COMPAT_DUMP) (await import('node:fs')).writeFileSync(process.env.COMPAT_DUMP, JSON.stringify(ev, null, 1))
console.log(JSON.stringify(out))
rmSync(home, { recursive: true, force: true })
clearInterval(keepAlive)
setTimeout(() => process.exit(0), 100)
