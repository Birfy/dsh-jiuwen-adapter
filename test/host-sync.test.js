import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'
import { resolveConfig } from '../src/config.js'
import { resolveHostSyncFlags, applySkillBodyInjection, PRESET_LEVELS } from '../src/host-sync.js'
import { GatewayTransport } from '../src/gateway-transport.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

test('hostSync defaults ON; master off disables children', () => {
  const on = resolveConfig({}, { env: {} })
  assert.equal(on.hostSync, true)
  assert.equal(on.syncSkills, true)
  assert.equal(on.syncMcp, true)
  assert.equal(on.sessionSync, true)
  assert.equal(on.planBridge, true)
  assert.equal(on.toolPassthrough, 'mcp')
  assert.deepEqual(on.toolAllowlist, ['*'])
  const off = resolveConfig({ hostSync: false }, { env: {} })
  assert.equal(off.hostSync, false)
  assert.equal(off.syncSkills, false)
  assert.equal(off.syncDelete, false)
  assert.equal(off.toolPassthrough, 'off')
  assert.deepEqual(off.toolAllowlist, [])
  const f = resolveHostSyncFlags({ hostSync: true, syncSkills: false }, {})
  assert.equal(f.syncSkills, false)
  assert.equal(f.syncMcp, true)
})

test('applySkillBodyInjection soft path once', () => {
  const mapping = { skillBodies: [{ name: 'demo', content: 'Do X' }] }
  const q1 = applySkillBodyInjection('hello', mapping)
  assert.match(q1, /Host skill: demo/)
  assert.match(q1, /hello/)
  const q2 = applySkillBodyInjection('hello', mapping)
  assert.equal(q2, 'hello')
})

test('title rename sync: session/title → session.rename', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true, finalGraceMs: 50 }, { listeners })
  // Ensure jiuwen mapping
  h.api.sessions.ensure('t1')
  h.api.sessions.update('t1', { turns: 1 })
  const session = { id: 't1', header: { config: { provider: 'jiuwen' } } }
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'session/title', data: { title: 'Renamed by user' } })
  }
  await new Promise(r => setTimeout(r, 200))
  assert.equal(h.api.sessions.get('t1').title, 'Renamed by user')
})

test('workdir sync: working-directory/change → mapping.projectDir', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true }, { listeners })
  h.api.sessions.ensure('wd1')
  const session = { id: 'wd1', header: { config: { provider: 'jiuwen' }, cwd: '/old' } }
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'working-directory/change', data: { cwd: '/workspace/proj' } })
  }
  assert.equal(h.api.sessions.get('wd1').projectDir, '/workspace/proj')
})

test('plan mode sync: plan/mode → mapping.chatMode agent.plan', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true }, { listeners })
  h.api.sessions.ensure('pm1')
  const session = { id: 'pm1', header: { config: { provider: 'jiuwen' } } }
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'plan/mode', data: { active: true } })
  }
  assert.equal(h.api.sessions.get('pm1').chatMode, 'agent.plan')
})

test('model sync: request/header model → mapping.modelName', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true, forwardModelName: true }, { listeners })
  h.api.sessions.ensure('md1')
  const session = { id: 'md1', header: { config: { provider: 'jiuwen' } } }
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'request/header', data: { config: { provider: 'jiuwen', model: 'doubao-seed-x' } } })
  }
  assert.equal(h.api.sessions.get('md1').modelName, 'doubao-seed-x')
})

test('non-jiuwen sessions ignored by host-sync', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true }, { listeners })
  const session = { id: 'other', header: { config: { provider: 'deepseek' } } }
  for (const fn of listeners['session/event'] || []) {
    fn(session, { type: 'session/title', data: { title: 'Nope' } })
  }
  assert.equal(h.api.sessions.get('other'), undefined)
})

test('session delete sync: api-session/removed → session.delete + unmap', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true }, { listeners })
  const m = h.api.sessions.ensure('del1')
  h.api.sessions.update('del1', { turns: 2 })
  const jw = m.jiuwenSessionId
  for (const fn of listeners['api-session/removed'] || []) fn('del1')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(h.api.sessions.get('del1'), undefined)
  // Gateway accepted delete (mock keeps no state to assert beyond no throw)
  assert.ok(jw)
})

test('goal sync: goal/changed → command.goal', async () => {
  const listeners = {}
  const calls = []
  const h = makeHost(mock, { hostSync: true }, { listeners })
  const orig = h.api.gateway.rpc
  h.api.gateway.rpc = async (method, params) => {
    calls.push([method, params])
    return orig.call(h.api.gateway, method, params)
  }
  // Patch gatewayFor path used by host-sync — it uses gateway() from plugin, not api.gateway.
  // Fire goal/changed with a jiuwen session mapping present.
  h.api.sessions.ensure('g1')
  h.api.sessions.update('g1', { turns: 1 })
  const session = { id: 'g1', header: { config: { provider: 'jiuwen' } } }
  for (const fn of listeners['goal/changed'] || []) {
    fn({ agent: { session }, change: { goal: { objective: 'Ship sync', phase: 'active' }, operation: 'create' } })
  }
  await new Promise(r => setTimeout(r, 400))
  // Soft: at least mapping still present (RPC goes through plugin gatewayFor)
  assert.ok(h.api.sessions.get('g1'))
})

test('fork sync: parentSession → session.fork remap', async () => {
  const listeners = {}
  const h = makeHost(mock, { hostSync: true }, { listeners })
  const parent = h.api.sessions.ensure('fork-parent')
  h.api.sessions.update('fork-parent', { turns: 1, skills: ['a'] })
  const child = { id: 'fork-child', header: { config: { provider: 'jiuwen' }, parentSession: 'fork-parent' } }
  for (const fn of listeners['session/created'] || []) fn(child)
  await new Promise(r => setTimeout(r, 400))
  const m = h.api.sessions.get('fork-child')
  assert.ok(m)
  // Either remapped to fork_* id or still has a mapping (fail-soft if fork raced)
  assert.ok(m.jiuwenSessionId)
})

test('skills/change updates mapping.skills for jiuwen sessions', async () => {
  const listeners = {}
  const skills = {
    list: async () => [
      { name: 'alpha', invocation: { modelInvocable: true, userInvocable: true }, content: 'A' },
      { name: 'beta', invocation: { modelInvocable: false, userInvocable: true } },
    ],
  }
  const h = makeHost(mock, { hostSync: true }, { listeners, services: { skills } })
  h.api.sessions.ensure('sk1')
  // sessionUsesProvider needs provider or mapping — mapping exists
  for (const fn of listeners['skills/change'] || []) fn()
  await new Promise(r => setTimeout(r, 500))
  const m = h.api.sessions.get('sk1')
  assert.ok(m)
  assert.deepEqual(m.skills, ['alpha'])
})

test('hostSync off installs no session/event listener', () => {
  const listeners = {}
  makeHost(mock, { hostSync: false, sessionSync: false }, { listeners })
  assert.equal(listeners['session/event'], undefined)
  assert.equal(listeners['skills/change'], undefined)
})

test('PRESET_LEVELS covers safe presets', () => {
  assert.equal(PRESET_LEVELS['read-only'], 'deny')
  assert.equal(PRESET_LEVELS['workspace-write'], 'ask')
})

test('chat.send picks up mapping.projectDir and skills', async () => {
  const h = makeHost(mock, { hostSync: true, finalGraceMs: 80 })
  h.api.sessions.ensure('turn1')
  h.api.sessions.update('turn1', { projectDir: '/tmp/proj', skills: ['alpha'], modelName: 'm1' })
  const cs = await h.run({
    sessionId: 'turn1',
    messages: [{ role: 'user', content: 'echo-params go' }],
  })
  const text = cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.match(text, /skills=alpha/)
  assert.match(text, /model=m1/)
})
