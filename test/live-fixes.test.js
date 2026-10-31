import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'
import { GatewayTransport } from '../src/gateway-transport.js'
import { fileBlocksFromHandles } from '../src/multimodal.js'
import { teamRecordLine } from '../src/commands-ext.js'
import { createPlanBridge } from '../src/bridges.js'

// Regressions found by the full live run against JiuwenSwarm 0.2.7 (mock runs in 0.2.7 shape).
let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())
const ext = async () => (await mock.rpc('debug.ext')).log

test('0.2.7 history.get (ack + streamed history.message): /jiuwen history shows the turns', async () => {
  const h = makeHost(mock)
  await h.run({ sessionId: 'hist-1', messages: [{ role: 'user', content: 'ping' }] })
  await h.run({ sessionId: 'hist-1', messages: [{ role: 'user', content: 'ping' }, { role: 'assistant', content: 'pong-from-gateway-mock' }, { role: 'user', content: 'a much longer second question that is split into parts' }] })
  const out = await h.cmd('history', 'hist-1')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /1\. \[user\] ping\n2\. \[assistant\] pong-from-gateway-mock\n3\. \[user\] a much longer second question that is split into parts/)
  // service helper
  const jw = h.ctx.jiuwenAdapter.jiuwenSessionId('hist-1')
  const page = await new GatewayTransport({ gatewayURL: mock.url }).historyMessages(jw)
  assert.equal(page.messages.length, 4)
  assert.equal(page.messages[0].content, 'ping')
  // unknown session → empty, not an error
  assert.deepEqual((await new GatewayTransport({ gatewayURL: mock.url }).historyMessages('nope')).messages, [])
})

test('0.2.7 session.fork needs source_session_id', async () => {
  const h = makeHost(mock)
  await h.run({ sessionId: 'fk-27', messages: [{ role: 'user', content: 'ping' }] })
  const r = await h.cmd('fork', 'fk-27')
  assert.equal(r.kind, 'success')
  assert.match(r.text, /new session_id=fork_/)
})

test('0.2.7 heartbeat job ops carry the session_id (jobs are session-scoped)', async () => {
  const h = makeHost(mock)
  for (const l of ['heartbeat toggle hb-job-1 on', 'heartbeat run hb-job-1', 'heartbeat cancel hb-job-1']) assert.doesNotMatch((await h.cmd(l, 'hb-27')).text, /another session/)
  const sent = (await ext()).filter(x => /^heartbeat\.job\./.test(x.method))
  assert.ok(sent.length >= 3 && sent.every(x => typeof x.params.session_id === 'string' && x.params.session_id.length > 0))
})

test('fileBlocksFromHandles: dsh-llm file handle text in the last user message → file blocks', () => {
  const handle = '[File "r.pdf" (12 bytes, sha256:abcdef12): verbatim read-only copy saved at "/x/y/r.pdf". Read that path with your file tools when its contents are needed.]'
  const o = { messages: [{ role: 'user', content: [{ type: 'text', text: `old ${handle}` }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: [{ type: 'text', text: `see ${handle}` }] }] }
  const out = fileBlocksFromHandles(o)
  const last = out.messages[2].content
  assert.equal(last.length, 2)
  assert.deepEqual(last[1], { type: 'file', attachment: { name: 'r.pdf', path: '/x/y/r.pdf', bytes: 12, mimeType: 'application/pdf' } })
  assert.equal(out.messages[0], o.messages[0]) // earlier turns untouched (persist once)
  const none = { messages: [{ role: 'user', content: '[File "a" (1 bytes, sha256:ab) was uploaded, but the current execution environment cannot access a readable path.]' }] }
  assert.equal(fileBlocksFromHandles(none), none)
})

test('documentPersist: handle-text attachment is persisted before chat.send', async () => {
  const msg = [{ role: 'user', content: [{ type: 'text', text: 'echo-params doc\n[File "r.txt" (3 bytes, sha256:ab12cd34): verbatim read-only copy saved at "/tmp/r.txt". Read that path.]' }] }]
  const n = async () => (await ext()).filter(x => x.method === 'document.persist').length
  const base = await n()
  await makeHost(mock, { documentPersist: true }).run({ sessionId: 'doc-h', messages: msg })
  assert.equal(await n(), base + 1)
})

test('teamRecordLine: readable lines for 0.2.7 team.history records', () => {
  assert.equal(teamRecordLine({ role: 'leader', event_type: 'chat.tool_call', content: '', tool_call: { name: 'view_task' } }), '[leader] 🔧 view_task')
  assert.equal(teamRecordLine({ role: 'teammate', member_name: 'w', event_type: 'chat.tool_result', content: '', tool_name: 'claim_task', success: true }), '[w] ↳ claim_task ok')
  assert.equal(teamRecordLine({ role: 'teammate', member_name: 'w', event_type: 'chat.final', content: 'done' }), '[w] done')
  assert.equal(teamRecordLine({ role: 'assistant', event_type: 'team.task', content: '', event: { type: 'team.task.completed' } }), '[assistant] team.task team.task.completed')
  assert.equal(teamRecordLine({ summary: 'lead assigned task' }), '[?] lead assigned task')
})

test('planBridge syncs on turn_end (turns end before processing_status{is_complete})', async () => {
  const sets = []
  const agent = { id: 'a' }
  const onEvent = createPlanBridge({
    services: () => ({ planMode: { get: () => ({ active: undefined }), set: (a, v) => sets.push([a.id, v]) }, agents: { get: () => agent } }),
    gateway: () => ({ planStatus: async () => ({ in_plan: true }) }),
    sessions: { get: () => ({ jiuwenSessionId: 'j' }) }, debounceMs: 5,
  })
  onEvent({ type: 'turn_end', dshSessionId: 'd' })
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(sets, [['a', true]])
})

test('/jiuwen rename and goal set strip one pair of surrounding quotes; plan-status before first turn is fail-soft', async () => {
  const { createJiuwenCommand } = await import('../src/commands.js')
  const calls = []
  const g = {
    sessionRename: async (sid, title) => { calls.push(['rename', title]); return { title } },
    goal: async (sid, p) => { calls.push(['goal', p.objective]); return { action: p.action } },
    planStatus: async () => { throw new Error('session not found') },
  }
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j1' }) }, gateway: () => g, config: () => ({}) })
  assert.match(await cmd.run('d', 'rename "My title"'), /→ "My title"\./)
  await cmd.run('d', "goal set 'finish it'")
  await cmd.run('d', 'rename say "hi" there')
  assert.deepEqual(calls, [['rename', 'My title'], ['goal', 'finish it'], ['rename', 'say "hi" there']])
  assert.match(await cmd.run('d', 'plan-status'), /no Jiuwen session yet/)
})

test('dsh-time-context snapshot is not forwarded to Jiuwen nor used in the local title', async () => {
  const { localTitle, buildQuery } = await import('../src/adapter.js')
  const { resolveConfig } = await import('../src/config.js')
  const cfg = resolveConfig({})
  const tc = 'Time sampled while preparing turn 4, step 1: 2026-10-31T17:28:24+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: 3s.'
  const messages = [{ role: 'user', content: 'Hi! Who are you' }, { role: 'user', content: [{ type: 'text', text: tc }], source: { kind: 'time-context' } }]
  assert.equal(buildQuery({ messages }, { turns: 1 }, cfg, {}), 'Hi! Who are you')
  assert.equal(buildQuery({ messages: [{ role: 'user', content: `Hi! Who are you\n\n${tc}` }] }, { turns: 1 }, cfg, {}), 'Hi! Who are you')
  assert.equal(localTitle({ messages: [{ role: 'user', content: `Hi! Who are you\n\n${tc}` }] }, cfg.ignoreMessagePatterns), 'Hi! Who are you')
})
