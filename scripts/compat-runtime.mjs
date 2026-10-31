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
    if (process.env.COMPAT_SYSDUMP) { const sys = msgs.filter(m => m.role === 'system').map(m => textOf(m) || (typeof m.content === 'string' ? m.content : '')).join('\n<<<MSG>>>\n'); if (sys) (await import('node:fs')).writeFileSync(process.env.COMPAT_SYSDUMP, sys) }
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
if (has('--sync2')) {
  // Skills from a temp filesystem root (custom skill unknown to Jiuwen), plus permission presets.
  const sk = join(home, 'skills', 'jw-probe-skill'); mkdirSync(sk, { recursive: true })
  ;(await import('node:fs')).writeFileSync(join(sk, 'SKILL.md'), '---\nname: jw-probe-skill\ndescription: probe skill for the jiuwen sync test\n---\nMARKSKILLBODY follow the probe.\n')
  await load('dsh-skill')
  await load('dsh-skill-filesystem', { dshHome: join(home, 'dsh'), agentsHome: join(home, 'agents'), customSkillDirs: [join(home, 'skills')], bundledSkillDir: join(home, 'bundled') })
}
if (!has('--no-deepseek')) await loadDeepseek()
// --providers: other dsh provider plugins beside deepseek (pi-ai twin, deepseek-account); no keys, never called.
const extraProviders = {}
if (has('--providers')) {
  const one = async (n, cfg) => { try { const m = await imp(n); await Promise.race([Promise.resolve(ctx.plugin(m.default || m, cfg)), tick(1500)]); extraProviders[n] = 'loaded' } catch (e) { extraProviders[n] = `fail: ${String(e?.message || e).slice(0, 80)}` } }
  await one('dsh-llm-pi-ai', { providers: { 'pi-compat': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'JIUWEN_COMPAT_NO_SUCH_KEY', displayName: 'Pi compat', models: [{ id: 'pi-m1' }] } } })
  await one('dsh-llm-deepseek-account', {})
}
await tick(1500)
await loadHarnessPlugins()
if (WITH && ORDER === 'after') await loadJiuwen()
trace('loaded; failed:', failed)
if (process.env.COMPAT_SCHEMAS) { for (const t of ctx.tools.schemas()) if (/exit_plan|update_goal|subagent|bash|create_goal/.test(t.name)) console.error('[schema]', t.name, JSON.stringify(t.parameters).slice(0, 700)); console.error('[services]', ['shell', 'shellEnv', 'workingDirectory', 'subagents', 'sandbox', 'subprocess'].map(n => `${n}:${ctx.get(n) !== undefined}`).join(' ')) }

const api = ctx.get('jiuwenAdapter')
const providersBefore = ctx.llm.listProviders().map(p => p.id).sort()
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
// --sync: real dsh services drive host→Jiuwen sync on a live jiuwen agent; every path is read back from Jiuwen.
let syncOut
if (WITH && has('--sync') && api && !GW.includes(':1/')) syncOut = await (async () => {
  const res = []
  const ok = (name, pass, detail = '') => res.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
  const sid = `jw-sync-${Date.now().toString(36)}`
  JW_SIDS.add(sid)
  const wait = async (fn, ms = 8000) => { const t = Date.now() + ms; let v; while (Date.now() < t) { try { v = await fn(); if (v) return v } catch { /* retry */ } await tick(200) } return v }
  const jwRow = async () => (await api.gateway.rpc('session.list', { limit: 500 }))?.sessions?.find(x => x.session_id === api.sessions.get(sid)?.jiuwenSessionId)
  const goalOf = async () => (await api.gateway.rpc('command.goal', { session_id: api.sessions.get(sid).jiuwenSessionId, action: 'get' }))?.goal
  let jh
  try {
    jh = await ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'jiuwen', model: 'jiuwen-default' } })
    const agent = jh.agent
    const say = async (text) => { agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } }); await Promise.race([agent.whenIdle(), tick(60_000)]) }
    const lastReply = () => agent.session.snapshotEvents().filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).at(-1) || ''
    await say('TAG:sync1 hello')
    ok('turn 1 via dsh-agent-loop', /stand-in reply sync1/.test(lastReply()), lastReply())
    ok('mapping created on first header', (api.sessions.get(sid)?.turns || 0) >= 1, JSON.stringify(api.sessions.get(sid)).slice(0, 120))
    // title: dsh sessionTitle.rename → Jiuwen session.rename
    ctx.get('sessionTitle').rename(agent.session, '同步 Title ✓')
    const t1 = await wait(async () => (await jwRow())?.title === '同步 Title ✓')
    ok('title: dsh rename → Jiuwen title', t1, (await jwRow())?.title)
    // /jiuwen rename → Jiuwen + dsh title, no echo loop
    const r = await api.command(sid, 'rename From Jiuwen Cmd')
    const t2 = await wait(async () => (await jwRow())?.title === 'From Jiuwen Cmd')
    ok('/jiuwen rename → Jiuwen title', t2, r)
    ok('/jiuwen rename → dsh title', ctx.get('sessionTitle').get(agent.session)?.title === 'From Jiuwen Cmd', JSON.stringify(ctx.get('sessionTitle').get(agent.session)))
    // plan mode
    ctx.get('planMode').set(agent, true); await tick(300)
    ok('plan mode on → chatMode agent.plan', api.sessions.get(sid)?.chatMode === 'agent.plan', api.sessions.get(sid)?.chatMode)
    ctx.get('planMode').set(agent, false); await tick(300)
    ok('plan mode off → chatMode cleared', api.sessions.get(sid)?.chatMode !== 'agent.plan', api.sessions.get(sid)?.chatMode)
    // working directory
    const wd = join(SANDBOX, 'wd-sync'); (await import('node:fs')).mkdirSync(wd, { recursive: true })
    try { await ctx.get('workingDirectory').set(agent, wd) } catch (e) { ok('workdir set', false, e.message) }
    const pd = await wait(() => api.sessions.get(sid)?.projectDir === wd, 3000)
    ok('workdir → mapping.projectDir', pd, api.sessions.get(sid)?.projectDir)
    // goal lifecycle (read back from Jiuwen command.goal get)
    const goals = ctx.get('goals')
    const created = goals.create(agent, { objective: 'sync goal objective', maxGoalRounds: 5 })
    const g1 = await wait(async () => (await goalOf())?.objective === 'sync goal objective' && (await goalOf()))
    ok('goal create → Jiuwen goal set', !!g1, JSON.stringify(g1)?.slice(0, 120))
    await tick(300)
    let snap = created
    const ref = () => { const g = snap?.goal ?? snap; return { id: g.id, revision: g.revision } }
    try { snap = goals.pause(agent, ref()) } catch (e) { ok('goal pause (dsh)', false, e.message) }
    const g2 = await wait(async () => (await goalOf())?.status === 'paused')
    ok('goal pause → Jiuwen paused', g2, (await goalOf())?.status)
    const before = (await goalOf())?.goal_id
    try { snap = goals.resume(agent, ref()) } catch (e) { ok('goal resume (dsh)', false, e.message) }
    const g3 = await wait(async () => (await goalOf())?.status === 'active')
    ok('goal resume → Jiuwen active, same goal', g3 && (await goalOf())?.goal_id === before, `${(await goalOf())?.status} ${(await goalOf())?.goal_id}/${before}`)
    try { goals.clear(agent, ref()) } catch (e) { ok('goal clear (dsh)', false, e.message) }
    const g4 = await wait(async () => !(await goalOf()))
    ok('goal clear → Jiuwen no goal', g4)
    await Promise.race([agent.whenIdle(), tick(30_000)])
    // persona change → reinjected; second turn still on the same Jiuwen session
    const jw1 = api.sessions.get(sid)?.jiuwenSessionId
    await say('TAG:sync2 again')
    ok('turn 2 same Jiuwen session', api.sessions.get(sid)?.jiuwenSessionId === jw1 && /stand-in reply sync2/.test(lastReply()), lastReply())
    const hist = await api.gateway.historyMessages?.(sid).catch(() => undefined)
    ok('history read-back has both user turns', !hist || (hist.messages || []).filter(m => m.role === 'user').length >= 2, (hist?.messages || []).length)
  } catch (e) { ok('sync scenario', false, e.stack?.split('\n').slice(0, 2).join(' ')) }
  try { await api.command(sid, 'delete confirm') } catch { /* ignore */ }
  try { await jh?.dispose() } catch { /* ignore */ }
  return res
})()
// --sync2: skills body, permission baseline, fork, delete (idle + mid-turn), persona/group reinject,
// schedule → heartbeat (global conf restored), MCP passthrough — each read back from Jiuwen / the model input.
let sync2Out
if (WITH && has('--sync2') && api && !GW.includes(':1/')) sync2Out = await (async () => {
  const res = []
  const ok = (name, pass, detail = '') => res.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
  const fs = await import('node:fs')
  const SLOG = process.env.STANDIN_LOG || '/tmp/standin.jsonl'
  const slog = () => { try { return fs.readFileSync(SLOG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } }
  const byTag = tag => slog().filter(x => x.tag === tag)
  const wait = async (fn, ms = 8000) => { const t = Date.now() + ms; let v; while (Date.now() < t) { try { v = await fn(); if (v) return v } catch { /* retry */ } await tick(200) } return v }
  const rows = async () => (await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []
  const hasRow = async jwId => (await rows()).some(x => x.session_id === jwId)
  const mk = async (sid) => { JW_SIDS.add(sid); return ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'jiuwen', model: 'jiuwen-default' } }) }
  const sayOn = async (agent, text, ms = 60_000) => { agent.followup({ id: `m-${Math.random().toString(36).slice(2)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }); await Promise.race([agent.whenIdle(), tick(ms)]) }
  const stamp = Date.now().toString(36)
  const handles = []
  try {
    // ── persona (generic fallback) + group reinject ──
    const sidP = `jw-s2p-${stamp}`; const hp = await mk(sidP); handles.push(hp)
    await sayOn(hp.agent, `TAG:p1${stamp} hi`)
    const p1 = byTag(`p1${stamp}`).at(-1)
    ok('persona: plain dsh personaPrefix forwarded (generic), no boilerplate', p1?.persona && p1?.testAgent && !p1?.boiler, JSON.stringify(p1 || {}).slice(0, 140))
    await sayOn(hp.agent, `TAG:p2${stamp} again`)
    const p2 = byTag(`p2${stamp}`).at(-1)
    ok('persona: not re-sent when unchanged (hash gate)', p2 && !p2.persona, JSON.stringify(p2 || {}).slice(0, 100))
    try { hp.agent.session.append('group/members', { members: ['a', 'b'] }) } catch (e) { ok('group/members append', false, e.message) }
    await sayOn(hp.agent, `TAG:p3${stamp} after group change`)
    const p3 = byTag(`p3${stamp}`).at(-1)
    ok('group roster change → persona reinjected next turn', p3?.persona && p3?.testAgent, JSON.stringify(p3 || {}).slice(0, 100))

    // ── skills: dsh custom skill unknown to Jiuwen → body soft-injected (no global skills.toggle) ──
    const skills = ctx.get('skills')
    if (!skills?.list) ok('skills service loaded', false, 'dsh-skill not available')
    else {
      const listed = await skills.list({}).catch(e => `ERR ${e.message}`)
      const mine = Array.isArray(listed) && listed.find(s => s.name === 'jw-probe-skill')
      ok('skills: dsh lists the probe skill', !!mine, Array.isArray(listed) ? listed.map(s => s.name).join(',') : listed)
      ctx.emit('skills/change')
      await api.flushSync?.()
      await tick(1500)
      const m = api.sessions.get(sidP)
      ok('skills: body queued on mapping (unknown to Jiuwen)', (m?.skillBodies || []).some(b => b.name === 'jw-probe-skill'), JSON.stringify(m?.skillBodies || []).slice(0, 100))
      await sayOn(hp.agent, `TAG:k1${stamp} use skill`)
      const k1 = byTag(`k1${stamp}`).at(-1)
      ok('skills: body reached the model input (first turn after sync)', [byTag(`p1${stamp}`).at(-1), k1].some(x => (x?.marks || []).includes('MARKSKILLBODY')), JSON.stringify(k1?.marks || []))
    }

    // ── permission preset: seeded baseline is recorded, never flips Jiuwen global levels ──
    const permBefore = JSON.stringify(await api.gateway.rpc('permissions.tools.get', {}).catch(e => `ERR ${e.message}`))
    try { hp.agent.session.append('permission/preset', { preset: 'workspace-write' }) } catch (e) { ok('permission/preset append', false, e.message) }
    await api.flushSync?.(); await tick(800)
    const permAfter = JSON.stringify(await api.gateway.rpc('permissions.tools.get', {}).catch(e => `ERR ${e.message}`))
    ok('permissions: first preset = baseline, Jiuwen levels unchanged', permBefore === permAfter && api.sessions.get(sidP)?.permissionPreset === 'workspace-write', `${api.sessions.get(sidP)?.permissionPreset} same=${permBefore === permAfter}`)

    // ── fork: dsh sessions.fork → mapped Jiuwen session.fork with parent history ──
    const parentJw = api.sessions.get(sidP)?.jiuwenSessionId
    const childId = `jw-s2f-${stamp}`; JW_SIDS.add(childId)
    let child
    try { child = ctx.get('sessions').fork(hp.agent.session, undefined, childId) } catch (e) { ok('dsh fork', false, e.message) }
    if (child) {
      const fm = await wait(() => { const m = api.sessions.get(childId); return m?.forkedFrom === parentJw && m.jiuwenSessionId !== parentJw && m }, 10_000)
      ok('fork: child mapped to a new Jiuwen fork of the parent', !!fm, JSON.stringify(api.sessions.get(childId) || {}).slice(0, 140))
      ok('fork: Jiuwen lists the forked session', fm && await wait(() => hasRow(fm.jiuwenSessionId)), fm?.jiuwenSessionId)
      if (fm) {
        const h = await api.gateway.historyMessages?.(childId).catch(e => ({ err: e.message }))
        ok('fork: forked Jiuwen session holds parent history', (h?.messages || []).filter(m => m.role === 'user').length >= 2, (h?.messages || []).length ?? h?.err)
        ctx.emit('api-session/removed', childId)
        await tick(1500)
        { const st = await ctx.get('sessionPersistence')?.stat?.(childId).catch(() => 'ERR')
          // dsh has no delete: a disposed fork that was never persisted is gone from dsh, so its Jiuwen fork goes too; a persisted one is kept.
          ok('fork: dispose → Jiuwen fork kept iff the dsh fork is persisted; parent always kept', (st ? await hasRow(fm.jiuwenSessionId) : !(await hasRow(fm.jiuwenSessionId))) && await hasRow(parentJw), JSON.stringify({ persisted: !!st })) }

        try { await api.command(childId, 'delete confirm') } catch { /* ignore */ }
      }
    }

    // ── schedule → heartbeat (Jiuwen global conf; restored exactly) ──
    const hb0 = await api.gateway.heartbeatConf?.().catch(() => undefined)
    try {
      hp.agent.session.append('schedule/change', { version: 1, operation: 'create', schedule: { id: `s-${stamp}`, kind: 'every', title: 'probe', prompt: 'ping', everySeconds: 7200, scheduledAt: Date.now() + 7200_000 } })
      const hb1 = await wait(async () => { const c = await api.gateway.heartbeatConf(); return Number(c?.every) === 7200 && c })
      ok('schedule every 7200s → Jiuwen heartbeat every=7200 (was 3600)', !!hb1, JSON.stringify(hb1 || await api.gateway.heartbeatConf().catch(() => null)).slice(0, 120))
    } catch (e) { ok('schedule/change append', false, e.message) }
    finally {
      if (hb0 && typeof hb0 === 'object') {
        try { await api.gateway.rpc('heartbeat.set_conf', hb0) } catch (e) { res.push(`WARN heartbeat restore ${e.message}`) }
        const hb2 = await api.gateway.heartbeatConf().catch(() => null)
        ok('heartbeat conf restored', JSON.stringify(hb2) === JSON.stringify(hb0), `${JSON.stringify(hb0)} → ${JSON.stringify(hb2)}`.slice(0, 160))
      }
    }

    // ── MCP passthrough: dsh-tools server registered in Jiuwen + model can call a dsh tool ──
    const v = await api.mcpVerify?.().catch(e => ({ error: e.message }))
    ok('mcp: dsh-tools server resolvable via mcp.show', v && !v.error && (v.ok ?? v.found ?? true), JSON.stringify(v).slice(0, 140))
    const mcpLine = String(await api.command(sidP, 'mcp').catch(e => e.message))
    ok('/jiuwen mcp shows passthrough line', /dsh-tools/.test(mcpLine), mcpLine.split('\n').find(l => /dsh-tools/.test(l)))

    // ── delete idle + delete during a turn ──
    const jwP = api.sessions.get(sidP)?.jiuwenSessionId
    ctx.emit('api-session/removed', sidP)
    await tick(1500)
    ok('dispose (idle, still persisted): Jiuwen session + mapping kept', await hasRow(jwP) && !!api.sessions.get(sidP), jwP)
    try { await api.command(sidP, 'delete confirm') } catch { /* ignore */ }
    ok('/jiuwen delete confirm removes it explicitly', await wait(async () => !(await hasRow(jwP)), 10_000), jwP)
    const sidD = `jw-s2d-${stamp}`; const hd = await mk(sidD); handles.push(hd)
    hd.agent.followup({ id: `m-d1${stamp}`, role: 'user', content: [{ type: 'text', text: `TAG:d1${stamp} SLOW6000 first turn` }], source: { kind: 'user' } })
    await wait(() => api.sessions.get(sidD)?.jiuwenSessionId && byTag(`d1${stamp}`).length, 8000)
    const jwD = api.sessions.get(sidD)?.jiuwenSessionId
    ctx.emit('api-session/removed', sidD)
    await Promise.race([hd.agent.whenIdle(), tick(30_000)])
    await tick(1500)
    ok('dispose mid first turn (persisted): turn settles, Jiuwen session kept', !!api.sessions.get(sidD), jwD)
    try { await api.command(sidD, 'delete confirm') } catch { /* ignore */ }
  } catch (e) { ok('sync2 scenario', false, e.stack?.split('\n').slice(0, 2).join(' ')) }
  for (const h of handles) { try { await h.dispose() } catch { /* ignore */ } }
  return res
})()
// --reload: dispose + re-plugin the adapter 3× in the live runtime (hot update); provider/service/command
// come back exactly once, a jiuwen turn works after each reload, and process listeners do not grow.
let reloadOut
if (WITH && has('--reload') && !GW.includes(':1/')) reloadOut = await (async () => {
  const res = []
  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  const snapL = () => process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).sort().join()
  let l0
  for (let i = 1; i <= 3; i++) {
    for (const f of jw.splice(0)) { try { await f.dispose?.() } catch (e) { res.push(`FAIL dispose ${e.message}`) } }
    await tick(300)
    if (i === 1) l0 = snapL() // baseline: no adapter loaded
    const gone = !ctx.llm.listProviders().some(p => p.id === 'jiuwen') && ctx.get('jiuwenAdapter') === undefined
    jw.push(ctx.plugin(plugin, { gatewayURL: GW, mappingPath: join(home, 'jw-a.json'), requestTimeoutMs: 60_000, mode: 'gateway' }))
    await tick(500)
    const back = ctx.llm.listProviders().filter(p => p.id === 'jiuwen').length === 1 && ctx.get('jiuwenAdapter') !== undefined
    const sid = `jw-reload-${i}-${Date.now().toString(36)}`; JW_SIDS.add(sid)
    const jh = await ctx.agents.create({ sessionId: sid, agentOptions: { provider: 'jiuwen', model: 'jiuwen-default' } })
    const cmds = ctx.commands.list(jh.agent).filter(c => c.name === 'jiuwen').length
    jh.agent.followup({ content: [{ type: 'text', text: `TAG:reload${i} hi` }], source: { kind: 'user' } })
    await Promise.race([jh.agent.whenIdle(), tick(60_000)])
    const reply = jh.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).join('|')
    res.push(`${gone && back && cmds === 1 && new RegExp(`stand-in reply reload${i}`).test(reply) ? 'PASS' : 'FAIL'} reload ${i}: gone=${gone} back=${back} commands=${cmds} reply=${reply.slice(0, 40)}`)
    try { await ctx.get('jiuwenAdapter').command(sid, 'delete confirm') } catch { /* ignore */ }
    await jh.dispose()
  }
  for (const f of jw.splice(0)) { try { await f.dispose?.() } catch { /* ignore */ } }
  await tick(300)
  const l1 = snapL()
  res.push(`${l0 === l1 ? 'PASS' : 'FAIL'} process listeners back to the no-adapter baseline after reloads + dispose — ${l0} → ${l1}`)
  return res
})()
const scenarioEvents = emitted.slice(base)
// Durability checkpoints: dsh-session also flushes on goal-round-driver idle timers, so their
// count depends on scheduling, not on the plugins loaded. Presence is still compared.
const TIMING_EVENTS = new Set(['session/flush'])
const norm = normalizer()
const ev = norm(rep.events)
for (const f of jw) { try { f.dispose?.() } catch (e) { failed.push(`dispose ${e.message}`) } }
await tick(500)
const g1 = snapGlobals()
const out = {
  with: WITH, order: ORDER, two: TWO, mixed: MIXED, gateway: GW, deepseek, failed, extraProviders, providersBefore,
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
  hostEventCountsRaw: scenarioEvents.filter(n => !n.startsWith('jiuwen/') && !/^internal\//.test(n) && !TIMING_EVENTS.has(n)).reduce((o, n) => (o[n] = (o[n] || 0) + 1, o), {}),
  hostEventCounts: createHash('sha1').update(JSON.stringify(scenarioEvents.filter(n => !n.startsWith('jiuwen/') && !/^internal\//.test(n) && !TIMING_EVENTS.has(n)).reduce((o, n) => (o[n] = (o[n] || 0) + 1, o), {}))).digest('hex').slice(0, 12),
  flushCheckpoints: scenarioEvents.filter(n => n === 'session/flush').length > 0,
  nonNamespacedFromJiuwen: [...new Set(scenarioEvents.filter(n => /jiuwen/i.test(n) && !n.startsWith('jiuwen/')))],
  jwOut,
  ...(syncOut ? { sync: syncOut } : {}),
  ...(reloadOut ? { reload: reloadOut } : {}),
  ...(sync2Out ? { sync2: sync2Out } : {}),
  afterDispose: { providers: ctx.llm.listProviders().map(p => p.id).sort(), service: ctx.get('jiuwenAdapter') === undefined ? 'gone' : 'present' },
  globals: { added: g1.g.filter(x => !g0.g.includes(x)), envSame: g0.env === g1.env, protoSame: g0.p === g1.p, procListeners: g1.l },
  unhandled,
}
if (process.env.COMPAT_DUMP) (await import('node:fs')).writeFileSync(process.env.COMPAT_DUMP, JSON.stringify(ev, null, 1))
console.log(JSON.stringify(out))
rmSync(home, { recursive: true, force: true })
clearInterval(keepAlive)
setTimeout(() => process.exit(0), 100)
