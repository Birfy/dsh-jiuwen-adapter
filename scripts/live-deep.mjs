#!/usr/bin/env node
/**
 * Deep live pass against a real Gateway backed by the scripted stand-in model (scripts are in the
 * query: TAG/SLOW/REASON/HUGE/ERR500/ERRMID/TOOL:/MCP:). Generic host, no dsh. Skips when offline.
 *   STANDIN_LOG=/tmp/standin.jsonl  LEAK_TURNS=200
 */
import { connect } from 'node:net'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const url = new URL(process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws')
const up = await new Promise(r => { const s = connect(Number(url.port), url.hostname, () => { s.end(); r(true) }); s.on('error', () => r(false)) })
if (!up) { console.log('SKIP gateway offline'); process.exit(0) }
const LOG = process.env.STANDIN_LOG || '/tmp/standin.jsonl'
const standin = (tag) => readFileSync(LOG, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return {} } }).filter(x => x.tag === tag)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'jw-deep-'))
const results = []
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const want = k => !ONLY || ONLY.has(k)

function host(config = {}, services = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    provide(n, v) { this[n] = v }, get: n => services[n], on() { return () => {} },
  }
  plugin.apply(ctx, { gatewayURL: url.href, mappingPath: join(dir, `m-${Math.random()}.json`), requestTimeoutMs: 120_000, ...config })
  const a = adapters.get('jiuwen')
  const run = async (sid, messages, extra = {}) => {
    const cs = []; const t0 = Date.now()
    try { for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages, ...extra })) cs.push(c) } catch (e) { return { threw: e, cs, ms: Date.now() - t0 } }
    return { cs, ms: Date.now() - t0, text: cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''), reasoning: cs.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), fin: cs.findLast(c => c.type === 'finish')?.reason }
  }
  return { ctx, a, api: ctx.jiuwenAdapter, run }
}
const u = q => [{ role: 'user', content: q }]
const ts = Date.now().toString(36)
const hosts = []
const H = (...a) => { const x = host(...a); hosts.push(x); return x }

try {
  const h = H()
  if (want('A')) {
    const sidA = `deepA-${ts}`; const convo = []
    let okTurns = 0
    for (let i = 1; i <= 12; i++) {
      convo.push({ role: 'user', content: `TAG:a${i} turn ${i}` })
      const r = await h.run(sidA, [...convo])
      if (r.fin?.kind === 'stop' && r.text.includes(`stand-in reply a${i}`)) okTurns++
      convo.push({ role: 'assistant', content: r.text || '' })
    }
    check('A 12-turn session all ok', okTurns === 12, `${okTurns}/12`)
    const seen = standin('a12').at(-1)?.users
    check('A model sees full history on turn 12', seen >= 12, `users=${seen}`)
    const jwA = h.api.sessions.get(sidA).jiuwenSessionId
    const list = await h.api.gateway.rpc('session.list', { limit: 500 })
    const row = (list?.sessions || []).find(s => s.session_id === jwA)
    check('A Jiuwen message_count consistent (>=24)', row && row.message_count >= 24, `message_count=${row?.message_count}`)
    const page = await h.api.gateway.historyGet(sidA).catch(e => ({ err: e.message }))
    check('A history read-back via adapter', !page?.err, JSON.stringify(page).slice(0, 160))
    check('A mapping turns == 12', h.api.sessions.get(sidA).turns === 12, h.api.sessions.get(sidA).turns)
  }
  if (want('B')) {
    const b = await h.run(`deepB-${ts}`, u('TAG:b REASON think'))
    check('B reasoning_content → reasoning-delta', /thinking about b/.test(b.reasoning) && /stand-in reply b/.test(b.text), JSON.stringify(b.reasoning.slice(0, 80)))
  }
  if (want('C')) {
    const ev = []; const off = h.api.onEvent(e => ev.push(e))
    const c = await h.run(`deepC-${ts}`, u('TAG:c TOOL:bash:{"command":"echo deep-$((6*7))","description":"echo"}'))
    off()
    check('C tool_call + tool_result events', ev.some(e => e.type === 'tool_call' && /bash/.test(e.name)) && ev.some(e => e.type === 'tool_result'), [...new Set(ev.map(e => e.type))].join(','))
    check('C final answer quotes tool output', /deep-42/.test(c.text), JSON.stringify(c.text.slice(0, 120)))
    check('C tool shown in reasoning trajectory', /bash/.test(c.reasoning), JSON.stringify(c.reasoning.slice(0, 120)))
  }
  if (want('D')) {
    const d = await h.run(`deepD-${ts}`, u('TAG:d HUGE300'))
    check('D ~200KB answer intact (start+end)', d.fin?.kind === 'stop' && d.text.length > 190_000 && d.text.trimEnd().endsWith('END-HUGE') && d.text.includes(' w7919 w15838 '), `${d.text.length} chars, ${d.ms}ms, fin=${JSON.stringify(d.fin).slice(0, 300)}`)
  }
  if (want('E')) {
    const e = await h.run(`deepE-${ts}`, u('TAG:e ERR500'))
    check('E provider 500 → error finish, no throw', !e.threw && e.fin?.kind === 'error', `${e.ms}ms ${JSON.stringify(e.fin).slice(0, 150)}`)
  }
  if (want('F')) {
    const f = await h.run(`deepF-${ts}`, u('TAG:f ERRMID HUGE20'))
    check('F provider drop mid-stream → finish (no throw, no hang)', !f.threw && !!f.fin, `${f.fin?.kind} ${f.ms}ms text=${f.text?.length}`)
    const f2 = await h.run(`deepF-${ts}`, u('TAG:f2 after'))
    check('F next turn in same session ok', f2.fin?.kind === 'stop' && /stand-in reply f2/.test(f2.text), JSON.stringify(f2.text))
  }
  if (want('G')) {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 2500)
    const g = await h.run(`deepG-${ts}`, u('TAG:g SLOW15000'), { signal: ac.signal })
    check('G abort → aborted quickly', g.fin?.kind === 'aborted' && g.ms < 8000, `${g.ms}ms ${g.fin?.kind}`)
    const g2 = await h.run(`deepG-${ts}`, u('TAG:g2 next'))
    check('G turn after abort ok', g2.fin?.kind === 'stop' && /stand-in reply g2/.test(g2.text), `${g2.ms}ms ${JSON.stringify(g2.text)}`)
  }
  if (want('H')) {
    // ask_user card answered through a dsh-style userQuestions service (the card path), then the
    // no-UI path (no service: the adapter tells Jiuwen to proceed).
    const asked = []
    const hq = H({}, { userQuestions: { ask: async ({ questions }) => { asked.push(questions); return { answers: [{ id: questions[0].id, selected: ['blue'] }] } } } })
    const ask = 'TAG:h TOOL:ask_user:{"query":"Pick a color","questions":[{"question":"Color?","header":"color","options":[{"label":"red","description":"r"},{"label":"blue","description":"b"}]}]}'
    const h1 = await hq.run(`deepH-${ts}`, u(ask))
    check('H card shown with question + options', asked[0]?.[0]?.question === 'Color?' && asked[0][0].options?.map(o => o.label).join() === 'red,blue', JSON.stringify(asked[0]))
    check('H answer resumes the same turn; Jiuwen gets the choice', h1.fin?.kind === 'stop' && /tool-result h/.test(h1.text) && /blue/.test(h1.text), JSON.stringify(h1.text.slice(0, 200)))
    check('H no pending question left', !hq.api.sessions.get(`deepH-${ts}`)?.pendingQuestion)
    const h2 = await h.run(`deepH2-${ts}`, u(ask.replace('TAG:h', 'TAG:h2')))
    check('H no-UI host: ask_user not offered to the model, turn completes', h2.fin?.kind === 'stop' && /stand-in reply h2/.test(h2.text), JSON.stringify(h2.text.slice(0, 120)))
  }
  if (want('I')) {
    const calls = []
    const services = {
      tools: { get: n => n === 'deep_echo' ? { execute: async (args) => { calls.push(args); return { content: [{ type: 'text', text: `echoed:${args.text}` }] } } } : undefined },
      approval: { request: async () => 'allowed-once' }, agents: { get: () => ({ id: 'deep-agent' }) },
    }
    const hm = H({ toolPassthrough: 'mcp', toolApproval: 'dsh' }, services)
    const tool = { name: 'deep_echo', description: 'Echo text back (deep test)', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
    const i1 = await hm.run(`deepI-${ts}`, u('TAG:i MCP:deep_echo:{"text":"mcp-ok-77"}'), { tools: [tool] })
    const picked = standin('i').find(x => x.picked)?.picked
    check('I Jiuwen found the dsh tool via tool_search', !!picked, `picked=${picked} names=${JSON.stringify(standin('i').find(x => x.searchNames)?.searchNames)}`)
    check('I dsh tool executed with args', calls.some(x => x.text === 'mcp-ok-77'), JSON.stringify(calls))
    check('I result returned in Jiuwen answer', /echoed:mcp-ok-77/.test(i1.text || ''), JSON.stringify((i1.text || '').slice(0, 160)))
  }
  if (want('J')) {
    const sidJ = `deepJ-${ts}`; const P1 = '# Your identity\nYou are Deep Persona One.\n\n# Tools\nhost tool rules'
    const msgs = (p, q) => [{ role: 'system', content: p }, { role: 'user', content: q }]
    await h.run(sidJ, msgs(P1, 'TAG:j1 hi'))
    await h.run(sidJ, msgs(P1, 'TAG:j2 hi'))
    await h.run(sidJ, msgs('# Your identity\nYou are Deep Persona Two.', 'TAG:j3 hi'))
    const has = t => standin(t).at(-1)?.persona === true
    check('J persona once, not resent unchanged, resent on change', has('j1') && !has('j2') && has('j3'), `${has('j1')},${has('j2')},${has('j3')}`)
    check('J persona mode drops non-persona sections', standin('j1').at(-1)?.personaText === 'Deep Persona One' && !/host tool rules/.test(standin('j1').at(-1)?.last || ''))
    const hf = H({ injectSystem: 'full' })
    await hf.run(`deepJf-${ts}`, [{ role: 'system', content: 'Plain dsh persona: you are Deep Persona Full.' }, ...u('TAG:jf hi')])
    check('J injectSystem full forwards an unmarked (plain dsh) system prompt', standin('jf').at(-1)?.personaText === 'Deep Persona Full')
  }
  if (want('K')) {
    const K = await Promise.all([...Array(6)].map((_, i) => h.run(`deepK${i}-${ts}`, u(`TAG:k${i} SLOW1500 hello`))))
    check('K 6 concurrent sessions isolated', K.every((r, i) => r.fin?.kind === 'stop' && r.text.includes(`stand-in reply k${i} `)), K.map(r => r.fin?.kind).join(','))
  }
  if (want('M')) {
    const bad = H({ gatewayURL: 'ws://127.0.0.1:1/ws' })
    const m1 = await bad.run(`deepM-${ts}`, u('hi'))
    check('M bad port → soft error fast', !m1.threw && m1.fin?.kind === 'error' && m1.ms < 5000, `${m1.ms}ms`)
    let m2
    try { const inv = H({ gatewayURL: 'not a url' }); m2 = await inv.run(`deepM2-${ts}`, u('hi')) } catch (err) { m2 = { threw: err } }
    check('M invalid URL → soft error, no throw', !m2.threw && m2.fin?.kind === 'error', m2.threw?.message || JSON.stringify(m2.fin).slice(0, 120))
    const P1 = '<identity>You are Deep Persona One.</identity>'
    const off2 = H({ hostSync: false, injectSystem: 'off', trajectoryDetail: 'summary' })
    const m3 = await off2.run(`deepM3-${ts}`, [{ role: 'system', content: P1 }, ...u('TAG:m3 TOOL:bash:{"command":"echo m3-ok","description":"e"}')])
    check('M hostSync off + injectSystem off + summary trajectory', m3.fin?.kind === 'stop' && /m3-ok/.test(m3.text) && standin('m3').every(x => x.persona !== true), JSON.stringify(m3.text.slice(0, 80)))
    for (const td of ['off', 'full', 'bogus']) {
      const ht = H({ trajectoryDetail: td })
      const r = await ht.run(`deepT${td}-${ts}`, u(`TAG:t${td} TOOL:bash:{"command":"echo td-${td}","description":"e"}`))
      check(`M trajectoryDetail=${td} ok`, r.fin?.kind === 'stop' && r.text.includes(`td-${td}`), `reasoning=${r.reasoning?.length}`)
    }
  }
  if (want('L')) {
    const N = Number(process.env.LEAK_TURNS || 200)
    for (let i = 0; i < 5; i++) await h.run(`deepL${i % 4}-${ts}`, u(`TAG:lw${i} x`)) // warm-up
    globalThis.gc?.(); await sleep(500)
    const snap = () => ({ rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, res: process.getActiveResourcesInfo().length, exit: process.listenerCount('exit') })
    const before = snap()
    let okL = 0
    for (let i = 0; i < N; i++) { const r = await h.run(`deepL${i % 4}-${ts}`, u(`TAG:l${i} x`)); if (r.fin?.kind === 'stop') okL++ }
    await sleep(1500); globalThis.gc?.(); await sleep(200)
    const after = snap()
    check(`L ${N} turns all ok`, okL === N, `${okL}/${N}`)
    check('L no handle/listener growth', after.res <= before.res + 2 && after.exit === before.exit, `resources ${before.res}→${after.res}, exit listeners ${before.exit}→${after.exit}`)
    check('L heap growth bounded (<30MB)', after.heap - before.heap < 30e6, `heap +${((after.heap - before.heap) / 1e6).toFixed(1)}MB rss ${(before.rss / 1e6).toFixed(0)}→${(after.rss / 1e6).toFixed(0)}MB`)
  }
} finally {
  // cleanup every Jiuwen session our mappings point at
  const ids = new Set(hosts.flatMap(x => { try { return x.api.sessions.list().map(m => m.jiuwenSessionId) } catch { return [] } }))
  let del = 0
  for (const id of ids) { try { await hosts[0].api.gateway.rpc('session.delete', { session_id: id }); del++ } catch { /* never created */ } }
  console.log(`cleanup: deleted ${del}/${ids.size} Jiuwen sessions`)
  rmSync(dir, { recursive: true, force: true })
}
const pass = results.filter(r => r[1]).length
console.log(`\nlive deep: ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
