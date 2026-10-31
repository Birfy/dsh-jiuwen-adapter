import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'
import { typedEventFor, sessionUsesProvider } from '../src/bridges.js'
import { resolveConfig } from '../src/config.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())
const user = t => [{ role: 'user', content: t }]

test('P3/hostSync defaults: sync ON, discovery/typed/document still opt-in', () => {
  const c = resolveConfig({}, { env: {} })
  assert.equal(c.hostSync, true)
  assert.equal(c.sessionSync, true)
  assert.equal(c.planBridge, true)
  assert.deepEqual([c.modelDiscovery, c.typedEvents, c.documentPersist], [false, false, false])
  const off = resolveConfig({ hostSync: false }, { env: {} })
  assert.equal(off.sessionSync, false)
  assert.equal(off.planBridge, false)
})

test('typedEventFor classifies into namespaced events', () => {
  assert.equal(typedEventFor({ type: 'tool_call', name: 'bash' })[0], 'jiuwen/tool')
  assert.equal(typedEventFor({ type: 'interaction_answered', kind: 'approval' })[0], 'jiuwen/approval')
  assert.equal(typedEventFor({ type: 'raw', event: 'plan.approval_required' })[0], 'jiuwen/plan')
  const sw = typedEventFor({ type: 'raw', event: 'swarmflow.run_started', raw: { run_id: 'r1' } })
  assert.deepEqual([sw[0], sw[1].runId], ['jiuwen/swarm', 'r1'])
  assert.equal(typedEventFor({ type: 'usage' }), null)
})

test('typedEvents: off → only jiuwen/event; on → also jiuwen/tool & jiuwen/swarm', async () => {
  const off = makeHost(mock)
  await off.run({ sessionId: 'te-off', messages: user('ping') })
  assert.ok(off.emitted.length > 0)
  assert.ok(off.emitted.every(([n]) => n === 'jiuwen/event'))
  const on = makeHost(mock, { typedEvents: true })
  await on.run({ sessionId: 'te-on', messages: user('ping') })
  const names = new Set(on.emitted.map(([n]) => n))
  assert.ok(names.has('jiuwen/tool'))
  assert.ok(names.has('jiuwen/swarm')) // chat.subtask_update
  assert.ok([...names].every(n => n.startsWith('jiuwen/')))
})

test('modelDiscovery: off → static catalog; on → unique jiuwen-model:<name> ids routed as model_name', async () => {
  const off = makeHost(mock)
  assert.deepEqual((await off.adapter.listModels('jiuwen')).map(m => m.id), ['jiuwen-default', 'jiuwen-swarm'])
  const regs = []
  const on = makeHost(mock, { modelDiscovery: true }, { services: { llm: { registerModelDiscovery(ns, fn) { regs.push([ns, fn]); return () => {} } } } })
  const ids = (await on.adapter.listModels('jiuwen')).map(m => m.id)
  assert.deepEqual(ids, ['jiuwen-default', 'jiuwen-swarm', 'jiuwen-model:jiuwen-default', 'jiuwen-model:jiuwen-swarm'])
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(regs[0][0], 'jiuwen')
  assert.deepEqual((await regs[0][1]({ provider: 'deepseek' })), [])
  assert.equal((await regs[0][1]({})).length, 2)
  const cs = await on.run({ sessionId: 'md', model: 'jiuwen-model:jiuwen-swarm', messages: user('echo-params m') })
  assert.match(cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /model=jiuwen-swarm /)
})

test('sessionSync: only jiuwen sessions; created → mapping, disposed → runtime cleared, mapping kept', async () => {
  const listeners = {}
  const h = makeHost(mock, { sessionSync: true }, { listeners })
  for (const fn of listeners['session/created']) fn({ id: 'ds-other', header: { config: { provider: 'deepseek' } } })
  assert.equal(h.api.sessions.get('ds-other'), undefined)
  for (const fn of listeners['session/created']) fn({ id: 'ds-jw', header: { config: { provider: 'jiuwen' } } })
  assert.ok(h.api.sessions.get('ds-jw'))
  h.api.sessions.update('ds-jw', { swarmRunId: 'r1', pendingQuestion: { requestId: 'q' } })
  for (const fn of listeners['session/disposed']) fn({ id: 'ds-jw' })
  const m = h.api.sessions.get('ds-jw')
  assert.ok(m)
  assert.equal(m.swarmRunId, undefined)
  assert.equal(m.pendingQuestion, undefined)
  assert.doesNotThrow(() => { for (const fn of listeners['session/created']) fn(null) })
  // flag off → no listeners
  const l2 = {}
  makeHost(mock, { sessionSync: false, hostSync: false }, { listeners: l2 })
  assert.equal(l2['session/created'], undefined)
  assert.equal(sessionUsesProvider({ id: 'x' }, 'jiuwen', { get: () => undefined }), false)
})

test('planBridge: Jiuwen in_plan → ctx.planMode.set for jiuwen sessions; off → untouched', async () => {
  const calls = []
  const agent = { id: 'pb' }
  const planMode = { get: () => ({ active: false }), set: (a, v) => { calls.push([a.id, v]); return 'committed' } }
  const services = { planMode, agents: { get: id => (id === 'pb' ? agent : undefined) } }
  const off = makeHost(mock, { planBridge: false, hostSync: false }, { services })
  await off.run({ sessionId: 'pb', messages: user('plan-on please') })
  await new Promise(r => setTimeout(r, 400))
  assert.equal(calls.length, 0)
  const on = makeHost(mock, { planBridge: true }, { services })
  await on.run({ sessionId: 'pb', messages: user('plan-on please') })
  await new Promise(r => setTimeout(r, 500))
  assert.deepEqual(calls, [['pb', true]])
})
