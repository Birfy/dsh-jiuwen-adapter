// Plain-dsh plugin compatibility matrix (docs/plugin-compat.md), in-process: 12 plugin areas × 2 load orders.
// (a) non-jiuwen sessions: no Jiuwen RPC, no mapping. (b) jiuwen sessions: the effect reaches Jiuwen or degrades softly.
// (c) no throw; dispose leaves no listeners. Order: host services ready at install vs provided after install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostSync } from '../src/host-sync.js'
import { createPlanBridge } from '../src/bridges.js'
import { SessionStore } from '../src/session-store.js'

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms))
const header = (provider, extra = {}) => ({ config: { provider, model: provider === 'jiuwen' ? 'jiuwen-default' : 'm1' }, cwd: '/w', ...extra })
const sess = (id, provider, extra) => ({ id, header: header(provider, extra) })

function services(agentOf) {
  const planSets = []
  const skillsSvc = { list: async () => [{ name: 'probe-skill', invocation: { modelInvocable: true } }], get: async () => ({ content: 'MARKSKILLBODY' }) }
  return {
    planSets,
    svc: {
      agents: { get: id => agentOf(id) },
      agentPresets: { serviceFor: (a, n) => (n === 'skills' ? skillsSvc : n === 'planMode' ? { get: () => ({ active: false }), set: (ag, v) => planSets.push(v) } : undefined) },
      skills: { list: async () => [] },
      schedule: { list: async ({ sessionId }) => [{ kind: 'every', everySeconds: 7200, id: 'x-' + sessionId }] },
      sessionPersistence: { stat: async id => (id.startsWith('stored') ? { header: {} } : undefined) },
    },
  }
}

function rig(order) {
  const listeners = {}; const calls = []; let live = {}
  const ctx = { on(n, fn) { (listeners[n] ||= []).push(fn); return () => { listeners[n] = listeners[n].filter(f => f !== fn) } } }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'pcm-')), 'm.json'))
  const agents = new Map()
  const S = services(id => agents.get(id))
  const g = {
    rpc: async (m, p) => { calls.push([m, p]); return m === 'plan.status' ? { in_plan: true } : {} },
    heartbeatConf: async () => ({ every: 3600, target: 'web' }),
    sessionFork: async id => { calls.push(['session.fork', { session_id: id }]); return { session_id: 'fork_' + id } },
    sessionDelete: async id => { calls.push(['session.delete', { session_id: id }]) },
    skillsList: async () => ({ skills: [] }),
    planStatus: async () => ({ in_plan: true }),
  }
  if (order === 'adapter-last') live = S.svc
  const hs = installHostSync({ ctx, config: () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }] }), sessions, gateway: () => g, logger: {}, services: () => live })
  const plan = createPlanBridge({ services: () => live, gateway: () => g, sessions, logger: {}, debounceMs: 1 })
  if (order === 'adapter-first') live = S.svc
  const fire = (n, ...a) => { for (const fn of [...(listeners[n] || [])]) fn(...a) }
  return { calls, sessions, fire, hs, plan, agents, planSets: S.planSets, listeners }
}

// Each area: drive(r, session) fires the host plugin's events; expect(calls, r, id) checks the jiuwen read-back.
const AREAS = {
  'session-controller (create/selectModel/prompt)': { drive: (r, s) => { r.fire('session/created', s); r.fire('session/event', s, { type: 'request/header', data: { header: s.header } }) }, expect: (c, r, id) => assert.ok(r.sessions.get(id)) },
  'session-title': { drive: (r, s) => { r.fire('session/event', s, { type: 'turn/end', data: { turn: 1 } }); r.fire('session/event', s, { type: 'session/title', data: { title: 'T 标题' } }) }, expect: c => assert.ok(c.some(([m, p]) => m === 'session.rename' && /标题/.test(JSON.stringify(p)))) },
  'working-directory': { drive: (r, s) => r.fire('session/event', s, { type: 'working-directory/change', data: { cwd: '/w2', path: '/w2' } }), expect: (c, r, id) => assert.match(String(r.sessions.get(id).projectDir), /\/w/) },
  'dsh-schedule': { drive: (r, s) => r.fire('schedule/changed'), expect: c => assert.equal(c.find(x => x[0] === 'heartbeat.set_conf')?.[1].every, 7200) },
  'dsh-permission-presets': { drive: (r, s) => { r.fire('session/event', s, { type: 'permission/preset', data: { preset: 'workspace-write' } }); r.fire('session/event', s, { type: 'permission/preset', data: { preset: 'read-only' } }) }, expect: c => assert.ok(c.some(([m]) => /permission/.test(m))) },
  fork: { drive: (r, s) => { if (r.sessions.get(s.id)) r.sessions.update(s.id, { turns: 2 }); r.fire('session/created', { id: s.id + '-kid', header: { ...s.header, parentSession: s.id } }) }, expect: async (c, r, id) => { await r.hs.pendingFor(id + '-kid'); assert.match(r.sessions.get(id + '-kid').jiuwenSessionId, /^fork_/) } },
  'dsh-plan-mode': { drive: (r, s) => r.plan({ dshSessionId: s.id, type: 'turn_end' }), expect: (c, r) => assert.deepEqual(r.planSets, [true]) },
  'dsh-goal': { drive: (r, s) => r.fire('session/event', s, { type: 'goal/change', data: { operation: 'create', goal: { objective: 'ship it', phase: 'active' } } }), expect: c => assert.ok(c.some(([m]) => m === 'command.goal')) },
  'dsh-skill / skill-filesystem': { drive: (r, s) => r.fire('session/event', s, { type: 'request/header', data: { header: s.header } }), expect: async (c, r, id) => { await r.hs.pendingFor(id); assert.deepEqual(r.sessions.get(id).skillBodies?.map(b => b.content), ['MARKSKILLBODY']) } },
  'agent-presets persona': { drive: () => {}, expect: () => {} }, // persona path: test/persona-generic.test.js ({{model}}, minimal); no host event
  'workspace archive / agent dispose': { drive: (r, s) => r.fire('api-session/removed', s.id), expect: (c, r, id) => { assert.ok(!c.some(([m]) => m === 'session.delete')); assert.ok(r.sessions.get(id)) } },
  // memory plugins act on model messages / tools only (see memory-plugins + mcp-bridge tests); host-sync must stay out of the way
  'memory: agent-instructions, session-reference, session-search': { drive: (r, s) => { for (const type of ['agent-instructions/change', 'session-reference/resolved', 'session-query/indexed']) r.fire('session/event', s, { type, data: {} }) }, expect: c => assert.equal(c.length, 0) },
  'mcp-resources, subagent, todo, compaction, approval, web tools': { drive: (r, s) => { for (const type of ['todo/change', 'compaction/end', 'approval/policy', 'mcp/resources', 'subagent/spawn']) r.fire('session/event', s, { type, data: {} }) }, expect: c => assert.equal(c.length, 0) },
}

for (const order of ['adapter-last', 'adapter-first']) {
  for (const [area, { drive, expect }] of Object.entries(AREAS)) {
    test(`plugin compat [${order}] ${area}`, async () => {
      // (a) non-jiuwen session: no RPC, no mapping
      const a = rig(order); const o = sess('stored-o', 'standin'); a.agents.set(o.id, { id: o.id, session: o })
      drive(a, o); await tick()
      assert.deepEqual(a.calls.filter(([m]) => m !== 'heartbeat.set_conf'), [], 'non-jiuwen session untouched')
      assert.equal(a.sessions.get(o.id), undefined)
      // (b) jiuwen session
      const b = rig(order); const j = sess('stored-j', 'jiuwen'); b.agents.set(j.id, { id: j.id, session: j })
      b.sessions.ensure(j.id); b.sessions.update(j.id, { turns: 1 })
      drive(b, j); await tick(); await expect(b.calls, b, j.id)
      // (c) dispose releases every listener
      b.hs(); assert.equal(Object.values(b.listeners).flat().length, 0, 'listeners released')
    })
  }
}
