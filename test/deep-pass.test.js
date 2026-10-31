// Deep pass (sections A–M, L) against mock-gateway's stand-in emulation; mirrors scripts/live-deep.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())
const u = q => [{ role: 'user', content: q }]
async function run(h, sessionId, messages, extra = {}) {
  const cs = []; const t0 = Date.now(); let threw
  try { for await (const c of h.adapter.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId, messages, ...extra })) cs.push(c) } catch (e) { threw = e }
  return { threw, cs, ms: Date.now() - t0, text: cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''), reasoning: cs.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), fin: cs.findLast(c => c.type === 'finish')?.reason }
}
const sent = async (h, sid) => (await mock.rpc('debug.state')).last[h.api.sessions.get(sid).jiuwenSessionId]?.content || ''

test('A long session: 12 turns, full history, turns counted', async () => {
  const h = makeHost(mock); const convo = []; let ok = 0
  for (let i = 1; i <= 12; i++) {
    convo.push({ role: 'user', content: `TAG:a${i} turn ${i}` })
    const r = await run(h, 'deepA', [...convo]); if (r.fin?.kind === 'stop' && r.text.startsWith(`stand-in reply a${i} n=${i}`)) ok++
    convo.push({ role: 'assistant', content: r.text })
  }
  assert.equal(ok, 12); assert.equal(h.api.sessions.get('deepA').turns, 12)
  const hist = (await mock.rpc('debug.state')).history[h.api.sessions.get('deepA').jiuwenSessionId]
  assert.equal(hist.length, 24)
})

test('B reasoning → reasoning-delta, C tool call → events + answer quotes tool output', async () => {
  const h = makeHost(mock)
  const b = await run(h, 'deepB', u('TAG:b REASON think'))
  assert.match(b.reasoning, /thinking about b/); assert.match(b.text, /stand-in reply b/)
  const ev = []; const off = h.api.onEvent(e => ev.push(e))
  const c = await run(h, 'deepC', u('TAG:c TOOL:bash:{"command":"echo deep-$((6*7))"}')); off()
  assert.ok(ev.some(e => e.type === 'tool_call' && /bash/.test(e.name)) && ev.some(e => e.type === 'tool_result'))
  assert.match(c.text, /deep-42/); assert.match(c.reasoning, /bash/)
})

test('D huge (~200KB) answer intact; E model 500 → error finish; F mid-stream drop → finish, next turn ok', async () => {
  const h = makeHost(mock)
  const d = await run(h, 'deepD', u('TAG:d HUGE300'))
  assert.equal(d.fin?.kind, 'stop'); assert.ok(d.text.length > 190_000); assert.ok(d.text.trimEnd().endsWith('END-HUGE')); assert.ok(d.text.includes(' w7919 w15838 '))
  const e = await run(h, 'deepE', u('TAG:e ERR500'))
  assert.ok(!e.threw); assert.equal(e.fin?.kind, 'error')
  const f = await run(h, 'deepF', u('TAG:f ERRMID HUGE20'))
  assert.ok(!f.threw && f.fin)
  const f2 = await run(h, 'deepF', u('TAG:f2 after'))
  assert.equal(f2.fin?.kind, 'stop'); assert.match(f2.text, /stand-in reply f2/)
})

test('G cancel: abort mid-stream is quick; next turn in the same session ok', async () => {
  const h = makeHost(mock); const ac = new AbortController(); setTimeout(() => ac.abort(), 400)
  const g = await run(h, 'deepG', u('TAG:g SLOW8000'), { signal: ac.signal })
  assert.equal(g.fin?.kind, 'aborted'); assert.ok(g.ms < 4000, `${g.ms}ms`)
  assert.ok((await mock.rpc('debug.state')).interrupts.length >= 1)
  const g2 = await run(h, 'deepG', u('TAG:g2 next'))
  assert.equal(g2.fin?.kind, 'stop'); assert.match(g2.text, /stand-in reply g2/)
})

test('J persona: sent once, not resent unchanged, resent on change; non-persona sections dropped; full mode forwards plain prompts', async () => {
  const h = makeHost(mock); const P = n => `# Your identity\nYou are Deep Persona ${n}.\n\n# Tools\nhost tool rules`
  const m = (p, q) => [{ role: 'system', content: p }, { role: 'user', content: q }]
  await run(h, 'deepJ', m(P('One'), 'TAG:j1 hi')); const s1 = await sent(h, 'deepJ')
  await run(h, 'deepJ', m(P('One'), 'TAG:j2 hi')); const s2 = await sent(h, 'deepJ')
  await run(h, 'deepJ', m(P('Two'), 'TAG:j3 hi')); const s3 = await sent(h, 'deepJ')
  assert.match(s1, /Deep Persona One/); assert.doesNotMatch(s1, /host tool rules/)
  assert.doesNotMatch(s2, /Deep Persona/); assert.match(s3, /Deep Persona Two/)
  const hf = makeHost(mock, { injectSystem: 'full' })
  await run(hf, 'deepJf', m('Plain dsh persona: you are Deep Persona Full.', 'TAG:jf hi'))
  assert.match(await sent(hf, 'deepJf'), /Deep Persona Full/)
})

test('K 6 concurrent slow sessions stay isolated', async () => {
  const h = makeHost(mock)
  const K = await Promise.all([...Array(6)].map((_, i) => run(h, `deepK${i}`, u(`TAG:k${i} SLOW600 hi`))))
  K.forEach((r, i) => { assert.equal(r.fin?.kind, 'stop'); assert.ok(r.text.startsWith(`stand-in reply k${i} `)) })
  assert.equal(new Set(K.map((_, i) => h.api.sessions.get(`deepK${i}`).jiuwenSessionId)).size, 6)
})

test('M bad config: bad port / invalid URL → soft error fast; feature switches off still answer', async () => {
  const m1 = await run(makeHost({ ...mock, url: 'ws://127.0.0.1:1/ws' }), 'deepM', u('hi'))
  assert.ok(!m1.threw); assert.equal(m1.fin?.kind, 'error'); assert.ok(m1.ms < 5000)
  const m2 = await run(makeHost({ ...mock, url: 'not a url' }), 'deepM2', u('hi'))
  assert.ok(!m2.threw); assert.equal(m2.fin?.kind, 'error')
  const off = makeHost(mock, { hostSync: false, injectSystem: 'off', trajectoryDetail: 'summary' })
  const m3 = await run(off, 'deepM3', [{ role: 'system', content: '<identity>You are Deep Persona One.</identity>' }, ...u('TAG:m3 TOOL:bash:{"command":"echo m3-ok"}')])
  assert.equal(m3.fin?.kind, 'stop'); assert.match(m3.text, /m3-ok/); assert.doesNotMatch(await sent(off, 'deepM3'), /Deep Persona/)
  for (const td of ['off', 'full', 'bogus']) {
    const r = await run(makeHost(mock, { trajectoryDetail: td }), `deepT${td}`, u(`TAG:t${td} TOOL:bash:{"command":"echo td-${td}"}`))
    assert.equal(r.fin?.kind, 'stop'); assert.ok(r.text.includes(`td-${td}`))
  }
})

test('L 200-turn leak check: all ok, no handle/listener growth, bounded heap', async () => {
  const h = makeHost(mock, { finalGraceMs: 20 })
  for (let i = 0; i < 5; i++) await run(h, `deepL${i % 4}`, u(`TAG:lw${i} x`))
  const snap = () => ({ heap: process.memoryUsage().heapUsed, res: process.getActiveResourcesInfo().length, exit: process.listenerCount('exit') })
  globalThis.gc?.(); const b = snap(); let ok = 0
  for (let i = 0; i < 200; i++) if ((await run(h, `deepL${i % 4}`, u(`TAG:l${i} x`))).fin?.kind === 'stop') ok++
  await new Promise(r => setTimeout(r, 300)); globalThis.gc?.(); const a = snap()
  assert.equal(ok, 200); assert.ok(a.res <= b.res + 2, `resources ${b.res}→${a.res}`); assert.equal(a.exit, b.exit)
  assert.ok(a.heap - b.heap < 60e6, `heap +${((a.heap - b.heap) / 1e6).toFixed(1)}MB`)
})

test('reload: 3× apply → turn → dispose leaves no exit listeners, handles or registered adapters', async () => {
  const { apply } = await import('../index.js')
  const { join } = await import('node:path')
  const base = { exit: process.listenerCount('exit'), res: process.getActiveResourcesInfo().length }
  let live = 0
  for (let i = 0; i < 3; i++) {
    const hooks = {}; let a
    const ctx = { llm: { registerAdapter(ids, ad) { a = ad; live++; return () => { live-- } } }, logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, get() {}, on(n, fn) { (hooks[n] ||= []).push(fn); return () => {} } }
    apply(ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, `reload-${i}.json`), finalGraceMs: 50 })
    const cs = []; for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: `rl${i}`, messages: u(`TAG:rl${i} x`) })) cs.push(c)
    assert.equal(cs.at(-1).reason.kind, 'stop')
    for (const fn of hooks.dispose || []) await fn()
  }
  await new Promise(r => setTimeout(r, 300))
  assert.equal(live, 0); assert.equal(process.listenerCount('exit'), base.exit)
  assert.ok(process.getActiveResourcesInfo().length <= base.res + 2)
})
