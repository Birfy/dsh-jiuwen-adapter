// Regressions from a real plain dsh web profile (base + web-app bundles, no FlyBot), 2026-10-31.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostSync } from '../src/host-sync.js'
import { createPlanBridge, scopedService } from '../src/bridges.js'
import { SessionStore } from '../src/session-store.js'

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))
function rig(services = {}, rpcImpl) {
  const listeners = {}; const calls = []
  const ctx = { on(n, fn) { (listeners[n] ||= []).push(fn); return () => {} } }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pdw-')), 'm.json'))
  const g = {
    rpc: async (m, p) => { calls.push([m, p]); return rpcImpl ? rpcImpl(m, p) : {} },
    heartbeatConf: async () => ({ every: 3600, target: 'web' }),
    sessionFork: async (id) => { await tick(80); calls.push(['session.fork', { session_id: id }]); return { session_id: 'fork_' + id } },
    sessionDelete: async (id) => { calls.push(['session.delete', { session_id: id }]) },
    skillsList: async () => ({ skills: [] }),
  }
  const hs = installHostSync({ ctx, config: () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }] }), sessions, gateway: () => g, logger: {}, services: () => services })
  const fire = (n, ...a) => { for (const fn of listeners[n] || []) fn(...a) }
  return { calls, sessions, fire, hs }
}
const jw = (id, extra = {}) => ({ id, header: { config: { provider: 'jiuwen' }, ...extra } })

test('api-session/removed (= session/disposed in dsh) never deletes a session still in persistence', async () => {
  const stored = new Set(['kept'])
  const r = rig({ sessionPersistence: { stat: async id => (stored.has(id) ? { header: {} } : undefined) } })
  for (const id of ['kept', 'gone']) { r.sessions.ensure(id); r.sessions.update(id, { turns: 2 }) }
  r.fire('api-session/removed', 'kept'); r.fire('api-session/removed', 'gone'); await tick(60)
  assert.equal(r.calls.filter(c => c[0] === 'session.delete').length, 1, 'only the session gone from persistence')
  assert.ok(r.sessions.get('kept'), 'mapping kept'); assert.equal(r.sessions.get('gone'), undefined)
  const e = rig({ sessionPersistence: { stat: async () => { throw new Error('io') } } })
  e.sessions.ensure('s'); e.sessions.update('s', { turns: 1 }); e.fire('api-session/removed', 's'); await tick(60)
  assert.equal(e.calls.length, 0, 'stat error: fail safe, keep'); assert.ok(e.sessions.get('s'))
  const n = rig({}) // no persistence (ephemeral host): previous behaviour
  n.sessions.ensure('s'); n.sessions.update('s', { turns: 1 }); n.fire('api-session/removed', 's'); await tick(60)
  assert.equal(n.calls.filter(c => c[0] === 'session.delete').length, 1)
})

test('agent-preset scoped skills: serviceFor(agent, "skills") with scope; global registry fallback', async () => {
  const agent = { id: 'a1', session: { header: { cwd: '/w' } } }
  const seen = []
  const scoped = { list: async (o) => { seen.push(o); return [{ name: 'preset-skill', invocation: { modelInvocable: true } }] }, get: async (n, o) => { seen.push(['get', n, o]); return { content: 'BODY' } } }
  const r = rig({ agents: { get: id => (id === 'a1' ? agent : undefined) }, agentPresets: { serviceFor: (a, n) => (a === agent && n === 'skills' ? scoped : undefined) }, skills: { list: async () => [] } })
  r.sessions.ensure('a1')
  r.fire('session/event', jw('a1', { cwd: '/w' }), { type: 'request/header' })
  await r.hs.pendingFor('a1')
  assert.equal(seen[0].scope, agent); assert.equal(seen[0].cwd, '/w')
  assert.deepEqual(r.sessions.get('a1').skillBodies, [{ name: 'preset-skill', content: 'BODY' }])
  assert.equal(r.sessions.get('a1').projectDir, '/w', 'cwd seeded on first jiuwen header')
  assert.equal(scopedService({ x: 'g' }, undefined, 'x'), 'g')
  assert.equal(scopedService({ x: 'g', agentPresets: { serviceFor: () => { throw new Error('no') } } }, {}, 'x'), 'g')
})

test('payload-less schedule/changed reads dsh-schedule list() of jiuwen sessions → heartbeat', async () => {
  const r = rig({ schedule: { list: async ({ sessionId }) => (sessionId === 'j' ? [{ kind: 'every', everySeconds: 7200, id: 's1' }] : []) } })
  r.sessions.ensure('j')
  r.fire('schedule/changed'); await tick(60)
  const set = r.calls.find(c => c[0] === 'heartbeat.set_conf')
  assert.equal(set?.[1].every, 7200); assert.equal(set?.[1].target, 'web')
  const n = rig({ schedule: { list: async () => [] } }); n.sessions.ensure('j'); n.fire('schedule/changed'); await tick(60)
  assert.equal(n.calls.length, 0)
})

test('fork remap is awaitable (pendingFor) so the first fork turn uses the Jiuwen fork', async () => {
  const r = rig({})
  r.sessions.ensure('p'); r.sessions.update('p', { turns: 3 })
  r.fire('session/created', jw('c', { parentSession: 'p' }))
  assert.ok(r.hs.pendingFor('c'))
  await r.hs.pendingFor('c')
  assert.equal(r.sessions.get('c').jiuwenSessionId, 'fork_' + r.sessions.get('p').jiuwenSessionId)
  assert.equal(r.hs.pendingFor('zzz'), undefined)
})

test('plan bridge uses the agent preset planMode (dsh web isolates it)', async () => {
  const agent = { id: 'd' }; const sets = []
  const pm = { get: () => ({ active: false }), set: (a, v) => sets.push([a, v]) }
  const sessions = { get: () => ({ jiuwenSessionId: 'j' }) }
  const onEvent = createPlanBridge({ services: () => ({ agents: { get: () => agent }, agentPresets: { serviceFor: (a, n) => (n === 'planMode' ? pm : undefined) } }), gateway: () => ({ planStatus: async () => ({ in_plan: true }) }), sessions, logger: {}, debounceMs: 1 })
  onEvent({ dshSessionId: 'd', type: 'turn_end' }); await tick(60)
  assert.deepEqual(sets, [[agent, true]])
})
