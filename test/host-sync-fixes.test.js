// Regression tests for host→Jiuwen sync bugs found in the live end-to-end run (2026-10-31).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHostSync, applySkillBodyInjection } from '../src/host-sync.js'
import { sessionUsesProvider } from '../src/bridges.js'
import { SessionStore } from '../src/session-store.js'

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

function rig({ cfg = {}, services = {}, rpcImpl } = {}) {
  const listeners = {}
  const calls = []
  const ctx = { on(n, fn) { (listeners[n] ||= []).push(fn); return () => {} } }
  const sessions = new SessionStore(join(mkdtempSync(join(tmpdir(), 'hsf-')), 'm.json'))
  const g = {
    rpc: async (m, p) => { calls.push([m, p]); return rpcImpl ? rpcImpl(m, p) : {} },
    heartbeatConf: async () => { calls.push(['heartbeat.get_conf', {}]); return { every: 3600, target: 'web', active_hours: { start: '08:00', end: '22:00' } } },
    sessionFork: async (id) => { calls.push(['session.fork', { session_id: id }]); return { session_id: 'fork_' + id } },
  }
  const config = () => ({ provider: 'jiuwen', hostSync: true, models: [{ id: 'jiuwen-default' }], ...cfg })
  installHostSync({ ctx, config, sessions, gateway: () => g, logger: {}, services: () => services })
  const fire = (n, ...a) => { for (const fn of listeners[n] || []) fn(...a) }
  return { listeners, calls, sessions, fire }
}
const jw = (id, extra = {}) => ({ id, header: { config: { provider: 'jiuwen' }, ...extra } })

test('sessionUsesProvider reads a real dsh Session requestHeader() method', () => {
  const s = { id: 'x', header: { id: 'x' }, requestHeader() { return { config: { provider: 'jiuwen', model: 'm' } } } }
  assert.equal(sessionUsesProvider(s, 'jiuwen', null), true)
  const o = { id: 'y', header: {}, requestHeader() { return { config: { provider: 'deepseek' } } } }
  assert.equal(sessionUsesProvider(o, 'jiuwen', { get: () => ({}) }), false)
  const none = { id: 'z', header: {}, requestHeader() { return undefined } }
  assert.equal(sessionUsesProvider(none, 'jiuwen', { get: () => undefined }), false)
})

test('skills: host toggle-off disables the Jiuwen skill we synced; only Jiuwen names go to chat.send; bodies via skills.get', async () => {
  let host = [{ name: 'xlsx', invocation: { modelInvocable: true } }, { name: 'my-host-skill', invocation: { modelInvocable: true } }]
  const services = { skills: { list: async () => host, get: async (n) => ({ name: n, content: `BODY of ${n}` }) } }
  const r = rig({ services, rpcImpl: (m) => m === 'skills.list' ? { skills: [{ name: 'xlsx' }, { name: 'pdf' }] } : {} })
  r.sessions.ensure('s1')
  r.fire('skills/change'); await tick(50)
  let m = r.sessions.get('s1')
  assert.deepEqual(m.skills, ['xlsx'])
  assert.deepEqual(m.skillBodies, [{ name: 'my-host-skill', content: 'BODY of my-host-skill' }])
  assert.deepEqual(r.calls.filter(c => c[0] === 'skills.toggle').map(c => c[1]), [{ name: 'xlsx', enabled: true }])
  // Body injected once; a changed body re-injects.
  assert.match(applySkillBodyInjection('q', m), /BODY of my-host-skill/)
  assert.equal(applySkillBodyInjection('q', m), 'q')
  host = [{ name: 'my-host-skill', invocation: { modelInvocable: true } }]
  services.skills.get = async (n) => ({ name: n, content: 'NEW BODY' })
  r.calls.length = 0
  r.fire('skills/change'); await tick(50)
  m = r.sessions.get('s1')
  assert.equal(m.skills, undefined)
  assert.deepEqual(r.calls.filter(c => c[0] === 'skills.toggle').map(c => c[1]), [{ name: 'xlsx', enabled: false }])
  assert.match(applySkillBodyInjection('q', m), /NEW BODY/)
})

test('mcp: hub catalog entries (installed:false) are never forwarded as session mcp names', async () => {
  const r = rig({ rpcImpl: (m) => m === 'mcp.list' ? { items: [{ name: 'amap', installed: false, connection_state: 'disconnected' }, { name: 'mine', installed: true }] } : {} })
  r.fire('session/created', jw('m1')); await tick(50)
  assert.deepEqual(r.sessions.get('m1').mcpNames, ['mine'])
})

test('permissions: the seeded default preset is a baseline; only later changes update Jiuwen, danger-full-access maps to allow', async () => {
  const r = rig()
  const s = jw('p1')
  r.fire('session/event', s, { type: 'permission/preset', data: { preset: 'workspace-write' } }); await tick()
  assert.equal(r.calls.filter(c => c[0] === 'permissions.tools.update').length, 0)
  r.fire('session/event', s, { type: 'permission/preset', data: { preset: 'danger-full-access' } }); await tick()
  const ups = r.calls.filter(c => c[0] === 'permissions.tools.update').map(c => c[1])
  assert.deepEqual(ups, [{ tool: 'bash', level: 'allow' }, { tool: 'write_file', level: 'allow' }, { tool: 'edit_file', level: 'allow' }])
  assert.ok(!r.calls.some(c => c[0] === 'permissions.tools.set'))
})

test('goal: session goal/change + agent goal/changed for one change send command.goal once', async () => {
  const r = rig()
  const s = jw('g1')
  const goal = { objective: 'Ship it', phase: 'active' }
  r.fire('session/event', s, { type: 'goal/change', data: { operation: 'create', goal } })
  r.fire('goal/changed', { agent: { session: s }, change: { operation: 'create', goal } })
  await tick()
  assert.equal(r.calls.filter(c => c[0] === 'command.goal').length, 1)
})

test('fork: subagent children are not forked; real forks keep turns + options', async () => {
  const r = rig()
  r.sessions.ensure('par'); r.sessions.update('par', { turns: 3, modelName: 'm1', systemHash: 'h' })
  r.fire('session/created', jw('sub', { parentSession: 'par', origin: 'subagent' })); await tick(50)
  assert.equal(r.calls.filter(c => c[0] === 'session.fork').length, 0)
  r.fire('session/created', jw('kid', { parentSession: 'par' })); await tick(50)
  const k = r.sessions.get('kid')
  assert.match(k.jiuwenSessionId, /^fork_/)
  assert.equal(k.turns, 3)
  assert.equal(k.modelName, 'm1')
  assert.equal(k.systemHash, 'h')
})

test('schedule: session schedule/change (every) merges onto heartbeat conf; payload-less schedule/changed is ignored', async () => {
  const r = rig()
  r.fire('schedule/changed'); await tick()
  assert.equal(r.calls.filter(c => c[0] === 'heartbeat.set_conf').length, 0)
  r.fire('session/event', jw('sc1'), { type: 'schedule/change', data: { version: 1, operation: 'create', schedule: { id: 'a', kind: 'every', everySeconds: 900, prompt: 'p', scheduledAt: 'x' } } })
  await tick(50)
  const set = r.calls.filter(c => c[0] === 'heartbeat.set_conf').map(c => c[1])
  assert.deepEqual(set, [{ target: 'web', active_hours: { start: '08:00', end: '22:00' }, every: 900 }])
})

test('model: model/selection syncs; picking the catalog default clears a synced model but not a /jiuwen model pin', async () => {
  const r = rig()
  const s = jw('md')
  r.fire('session/event', s, { type: 'model/selection', data: { provider: 'jiuwen', model: 'doubao-x' } })
  assert.equal(r.sessions.get('md').modelName, 'doubao-x')
  r.fire('session/event', s, { type: 'request/header', data: { header: { config: { provider: 'jiuwen', model: 'jiuwen-default' } } } })
  assert.equal(r.sessions.get('md').modelName, undefined)
  r.sessions.update('md', { modelName: 'pinned' })
  r.fire('session/event', s, { type: 'model/selection', data: { provider: 'jiuwen', model: 'jiuwen-default' } })
  assert.equal(r.sessions.get('md').modelName, 'pinned')
})

test('memory gap is probed on the first jiuwen request/header of a new session (no header at session/created)', async () => {
  const r = rig({ rpcImpl: (m) => { if (m === 'memory.status') throw new Error('unknown method'); return {} } })
  const s = { id: 'mem1', header: {}, requestHeader() { return this._h }, _h: undefined }
  r.fire('session/created', s); await tick()
  assert.equal(r.sessions.get('mem1'), undefined)
  s._h = { config: { provider: 'jiuwen', model: 'jiuwen-default' } }
  r.fire('session/event', s, { type: 'request/header', data: { header: s._h } }); await tick(50)
  assert.equal(r.sessions.get('mem1').memoryBridge, 'gap')
  assert.ok(r.calls.some(c => c[0] === 'mcp.list'))
})

test('permissions: baseline comes from the session log when the mapping is newer than the seeded preset', async () => {
  const r = rig()
  const seed = { type: 'permission/preset', seq: 2, data: { preset: 'workspace-write' } }
  const change = { type: 'permission/preset', seq: 9, data: { preset: 'read-only' } }
  const s = { ...jw('p2'), snapshotEvents: () => [seed, change] }
  r.fire('session/event', s, change); await tick()
  assert.deepEqual(r.calls.filter(c => c[0] === 'permissions.tools.update').map(c => c[1].level), ['deny', 'deny', 'deny'])
})

test('ask_user answers: a picked option is not echoed into custom_input (Jiuwen joined them as "Blue, Blue")', async () => {
  const { questionAnswers } = await import('../src/interaction.js')
  const qs = [{ question: 'Pick?', options: [{ label: 'Blue' }, { label: 'Red' }] }, { question: 'Free?' }]
  const items = [{ id: 'q1' }, { id: 'q2' }]
  const out = questionAnswers(qs, items, [{ id: 'q1', selected: ['Blue'] }, { id: 'q2', selected: ['typed text'] }])
  assert.deepEqual(out[0], { selected_options: ['Blue'], custom_input: '' })
  assert.equal(out[1].custom_input, 'typed text')
  const other = questionAnswers(qs.slice(0, 1), items, [{ id: 'q1', selected: [], custom: 'Green' }])
  assert.deepEqual(other[0], { selected_options: [], custom_input: 'Green' })
})

test('title: a fork child title waits for the fork remap; a title before the first turn is deferred (no orphan Jiuwen session)', async () => {
  const r = rig()
  r.sessions.ensure('tp'); r.sessions.update('tp', { turns: 2 })
  const kid = jw('tk', { parentSession: 'tp' })
  r.fire('session/created', kid)
  r.fire('session/event', kid, { type: 'session/title', data: { title: 'Branch (1)' } })
  await tick(80)
  const renames = r.calls.filter(c => c[0] === 'session.rename').map(c => c[1])
  assert.deepEqual(renames, [{ session_id: 'fork_' + r.sessions.get('tp').jiuwenSessionId, title: 'Branch (1)' }])
  // fresh session: no rename until a turn exists
  const s = jw('fresh')
  r.fire('session/event', s, { type: 'session/title', data: { title: 'Early' } }); await tick(30)
  assert.equal(r.calls.filter(c => c[0] === 'session.rename').length, 1)
  assert.equal(r.sessions.get('fresh').pendingTitle, 'Early')
  r.sessions.recordTurn('fresh')
  r.fire('session/event', s, { type: 'turn/end', data: { turn: 1 } }); await tick(30)
  assert.equal(r.calls.filter(c => c[0] === 'session.rename').at(-1)[1].title, 'Early')
  assert.equal(r.sessions.get('fresh').pendingTitle, undefined)
})

test('title: deferred fallback title released at turn/end does not overwrite a newer user title', async () => {
  let release
  const r = rig({ rpcImpl: (m) => m === 'session.rename' && !release ? new Promise(res => { release = res }) : {} })
  const s = jw('race')
  r.fire('session/event', s, { type: 'session/title', data: { title: 'fallback words' } }); await tick()
  r.sessions.recordTurn('race')
  r.fire('session/event', s, { type: 'turn/end', data: { turn: 1 } })
  r.fire('session/event', s, { type: 'session/title', data: { title: 'User Title' } })
  await tick(30); release?.({}); await tick(50)
  const renames = r.calls.filter(c => c[0] === 'session.rename').map(c => c[1].title)
  assert.equal(renames.at(-1), 'User Title')
  assert.equal(r.sessions.get('race').title, 'User Title')
})
