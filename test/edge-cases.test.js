// Edge cases: concurrency, rapid toggles, caps, unicode, delete during a turn, dispose, coexistence.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostSync } from '../src/host-sync.js'
import { SessionStore } from '../src/session-store.js'
import { applySystemInjection, SYSTEM_MAX_BYTES } from '../src/system-inject.js'
import { startMock, makeHost } from './helpers/mock-host.js'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))
const text = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')

function rig({ cfg = {}, services = {}, rpcImpl, delay = 0 } = {}) {
  const listeners = {}
  let offs = 0
  const calls = []
  const ctx = { on(n, fn) { (listeners[n] ||= []).push(fn); return () => { offs++; listeners[n] = listeners[n].filter(f => f !== fn) } } }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'edge-')), 'm.json'))
  const g = {
    rpc: async (m, p) => { calls.push([m, p]); if (delay) await tick(typeof delay === 'function' ? delay(m, p) : delay); return rpcImpl ? rpcImpl(m, p) : {} },
  }
  const config = () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }], ...cfg })
  const dispose = installHostSync({ ctx, config, sessions, gateway: () => g, logger: {}, services: () => services })
  const fire = (n, ...a) => { for (const fn of listeners[n] || []) fn(...a) }
  return { listeners, calls, sessions, fire, dispose, offs: () => offs }
}
const jw = (id) => ({ id, header: { config: { provider: 'jiuwen' } } })

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

test('concurrent turns in several sessions stay isolated (own answer, own Jiuwen session)', async () => {
  const h = makeHost(mock)
  const ids = ['c1', 'c2', 'c3', 'c4']
  const outs = await Promise.all(ids.map(id => h.run({ sessionId: id, messages: [{ role: 'user', content: `hello from ${id}` }] })))
  outs.forEach((cs, i) => {
    assert.equal(cs.find(c => c.type === 'finish')?.reason?.kind, 'stop')
    assert.match(text(cs), new RegExp(`hello from ${ids[i]}`))
    for (const other of ids.filter(x => x !== ids[i])) assert.doesNotMatch(text(cs), new RegExp(`hello from ${other}\\b`))
  })
  const jwIds = ids.map(id => h.api.sessions.get(id).jiuwenSessionId)
  assert.equal(new Set(jwIds).size, ids.length)
  assert.ok(ids.every(id => !h.api.sessions.isActive(id)), 'no turn left marked active')
})

test('rapid skill toggles are serialized and coalesced: final Jiuwen state matches the last host state', async () => {
  let host = []
  const services = { skills: { list: async () => host } }
  const r = rig({ services, delay: 15, rpcImpl: (m) => m === 'skills.list' ? { skills: [{ name: 'a' }, { name: 'b' }] } : {} })
  r.sessions.ensure('s1')
  const states = [['a'], ['a', 'b'], [], ['b'], ['a']]
  for (const st of states) { host = st.map(name => ({ name })); r.fire('skills/change') }
  await r.dispose.idle(); await tick(20)
  assert.deepEqual(r.sessions.get('s1').skills, ['a'])
  // Replaying the toggles must give the same final enabled set.
  const on = new Set()
  for (const [m, p] of r.calls) if (m === 'skills.toggle') p.enabled ? on.add(p.name) : on.delete(p.name)
  assert.deepEqual([...on], ['a'])
  assert.ok(r.calls.filter(c => c[0] === 'skills.list').length <= 3, `coalesced: ${r.calls.filter(c => c[0] === 'skills.list').length} runs`)
})

test('rapid permission preset changes: serialized, latest level wins, never interleaved', async () => {
  const r = rig({ delay: 10 })
  const s = jw('p1'); r.sessions.ensure('p1')
  const preset = (p) => r.fire('session/event', s, { type: 'permission/preset', data: { preset: p } })
  preset('workspace-write') // baseline (host default) → not forwarded
  preset('full-access'); preset('read-only'); preset('full-access'); preset('read-only')
  await r.dispose.idle(); await tick(20)
  const ups = r.calls.filter(c => c[0] === 'permissions.tools.update').map(c => c[1])
  assert.ok(ups.length >= 3 && ups.length % 3 === 0, String(ups.length))
  for (let i = 0; i < ups.length; i += 3) assert.equal(new Set(ups.slice(i, i + 3).map(u => u.level)).size, 1, 'one level per batch')
  assert.equal(ups.at(-1).level, 'deny')
})

test('very long persona (>8KB, multibyte) is capped to SYSTEM_MAX_BYTES without breaking characters', () => {
  const persona = 'You are 九问助手 🤖. '.repeat(2000)
  const opts = { messages: [{ role: 'system', content: `<identity>\n${persona}\n</identity>` }, { role: 'user', content: 'hi' }] }
  const r = applySystemInjection('hi', opts, { jiuwenSessionId: 'j' }, 'full')
  assert.ok(r?.query, 'injected')
  const body = r.query.slice(0, r.query.lastIndexOf('hi'))
  assert.ok(Buffer.byteLength(body) <= SYSTEM_MAX_BYTES + 1024, `${Buffer.byteLength(body)} bytes`)
  assert.ok(!r.query.includes('\uFFFD'), 'no broken UTF-8')
  assert.ok(r.query.endsWith('hi'))
})

test('unicode titles (CJK, emoji, RTL) are renamed verbatim; latest wins', async () => {
  const r = rig({ delay: 5 })
  const m = r.sessions.ensure('u1'); r.sessions.update('u1', { turns: 1 })
  const s = jw('u1')
  for (const t of ['第一个 标题', '🚀 Launch — ✓', 'مرحبا عالم']) r.fire('session/event', s, { type: 'session/title', data: { title: t } })
  await tick(80)
  const renames = r.calls.filter(c => c[0] === 'session.rename').map(c => c[1])
  assert.equal(renames.at(-1).title, 'مرحبا عالم')
  assert.equal(renames.at(-1).session_id, m.jiuwenSessionId)
  assert.equal(r.sessions.get('u1').title, 'مرحبا عالم')
})

test('session delete during an active first turn: interrupt, wait, then delete the Jiuwen session (no orphan)', async () => {
  const r = rig()
  const m = r.sessions.ensure('d1')
  const end = r.sessions.beginTurn('d1')
  r.fire('api-session/removed', 'd1')
  await tick(30)
  assert.deepEqual(r.calls.map(c => c[0]), ['chat.interrupt'], 'interrupt first, delete waits for the turn')
  r.sessions.recordTurn('d1', {})
  end()
  await tick(30)
  assert.deepEqual(r.calls.map(c => c[0]), ['chat.interrupt', 'session.delete'])
  assert.equal(r.calls[1][1].session_id, m.jiuwenSessionId)
  assert.equal(r.sessions.get('d1'), undefined)
})

test('dispose: removes every listener, drops queued sync work, leaves no timers', async () => {
  let n = 0
  const services = { skills: { list: async () => { n++; return [{ name: 'a' }] } } }
  const r = rig({ services, delay: 20, rpcImpl: (m) => m === 'skills.list' ? { skills: [{ name: 'a' }] } : {} })
  r.sessions.ensure('s1')
  const registered = Object.values(r.listeners).reduce((a, l) => a + l.length, 0)
  r.fire('skills/change'); r.fire('skills/change')
  r.dispose()
  assert.equal(r.offs(), registered)
  assert.equal(Object.values(r.listeners).reduce((a, l) => a + l.length, 0), 0)
  await r.dispose.idle()
  assert.ok(n <= 1, 'queued run skipped after dispose')
  const before = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length
  await tick(50)
  assert.ok(process.getActiveResourcesInfo().filter(x => x === 'Timeout').length <= before)
})

test('plugin dispose (fallback ctx.on dispose path) unregisters provider and is idempotent', async () => {
  const { apply } = await import('../index.js')
  let unregistered = 0
  const hooks = {}
  const ctx = {
    llm: { registerAdapter() { return () => { unregistered++ } } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    provide(n, v) { this[n] = v },
    on(n, fn) { (hooks[n] ||= []).push(fn); return () => {} },
  }
  apply(ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, `disp-${Math.random()}.json`) })
  for (const fn of hooks.dispose || []) fn()
  for (const fn of hooks.dispose || []) fn()
  assert.equal(unregistered, 1)
})

test('coexistence: non-jiuwen sessions get no Jiuwen RPCs for title/preset/delete/goal/skills', async () => {
  const services = { skills: { list: async () => [{ name: 'a' }] } }
  const r = rig({ services })
  const other = { id: 'ds1', header: { config: { provider: 'deepseek' } } }
  r.fire('session/created', other)
  r.fire('session/event', other, { type: 'session/title', data: { title: 'x' } })
  r.fire('session/event', other, { type: 'permission/preset', data: { preset: 'read-only' } })
  r.fire('session/event', other, { type: 'goal/change', data: { goal: { phase: 'active', objective: 'o' } } })
  r.fire('session/event', other, { type: 'request/header', data: { config: { provider: 'deepseek', model: 'deepseek-chat' } } })
  r.fire('api-session/removed', 'ds1')
  r.fire('skills/change')
  await r.dispose.idle(); await tick(30)
  assert.equal(r.sessions.get('ds1'), undefined)
  assert.deepEqual(r.calls, [])
})

test('resume: dsh goal resume → Jiuwen command.goal resume after our pause; set when Jiuwen goal was not paused by us', async () => {
  const r = rig()
  const s = jw('g1'); const m = r.sessions.ensure('g1')
  const goal = (operation, phase) => r.fire('session/event', s, { type: 'goal/change', data: { kind: 'goal/change', operation, goal: { objective: 'ship it', phase } } })
  goal('create', 'active'); await tick(5)
  goal('pause', 'paused'); await tick(5)
  goal('resume', 'active'); await tick(5)
  const acts = r.calls.filter(c => c[0] === 'command.goal').map(c => c[1].action)
  assert.deepEqual(acts, ['set', 'pause', 'resume'])
  assert.ok(r.calls.every(c => c[1].session_id === m.jiuwenSessionId))
  const r2 = rig(); const s2 = jw('g2'); r2.sessions.ensure('g2')
  r2.fire('session/event', s2, { type: 'goal/change', data: { operation: 'resume', goal: { objective: 'o', phase: 'active' } } }); await tick(5)
  assert.deepEqual(r2.calls.map(c => [c[0], c[1].action]), [['command.goal', 'set']])
})

test('/jiuwen rename mirrors the dsh title via sessionTitle.rename (no double Jiuwen rename); fork message is explicit', async () => {
  const live = { id: 'ext-s' }
  const renamed = []
  const h = makeHost(mock, {}, { services: { sessions: { get: id => (id === 'ext-s' ? live : undefined) }, sessionTitle: { rename: (s, t) => { renamed.push([s.id, t]) } } } })
  const out = await h.cmd('rename 标题 🚀')
  assert.match(out.text, /Renamed Jiuwen session .*"标题 🚀" \(dsh title updated\)/)
  assert.deepEqual(renamed, [['ext-s', '标题 🚀']])
  assert.equal(h.api.sessions.get('ext-s').title, '标题 🚀')
  const h2 = makeHost(mock)
  assert.doesNotMatch((await h2.cmd('rename plain')).text, /dsh title/, 'hosts without sessionTitle: Jiuwen rename only')
})

test('ask_user card: Jiuwen\'s synthetic trailing "Other / Custom input" option is dropped (dsh card has its own free-text row)', async () => {
  const { cardOptions, questionAnswers } = await import('../src/interaction.js')
  const opts = [{ label: 'red' }, { label: 'blue' }, { label: 'Other', description: 'Custom input' }]
  assert.deepEqual(cardOptions(opts).map(o => o.label), ['red', 'blue'])
  assert.deepEqual(cardOptions([{ label: 'Other', description: 'Custom input' }]).length, 1, 'a lone option is kept')
  assert.deepEqual(cardOptions([{ label: 'Other' }, { label: 'x' }]).map(o => o.label), ['Other', 'x'], 'a real "Other" is kept')
  const q = [{ question: 'Color?', options: opts }]
  assert.deepEqual(questionAnswers(q, [{ id: 'q1' }], [{ id: 'q1', selected: [], custom: 'green' }]), [{ selected_options: [], custom_input: 'green' }])
})
