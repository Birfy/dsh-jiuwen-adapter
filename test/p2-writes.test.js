import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())
const ext = async () => (await mock.rpc('debug.ext')).log

test('P2: cron create (disabled by default) / toggle / run / delete needs confirm', async () => {
  const h = makeHost(mock)
  const c = await h.cmd('cron create name=nightly expr="0 3 * * *" desc="dsh test" tz=Asia/Shanghai')
  assert.match(c.text, /Created Jiuwen cron job (cron-\d+) "nightly" \(0 0 3 \* \* \* \*, Asia\/Shanghai\) disabled/)
  const id = c.text.match(/job (cron-\d+)/)[1]
  const created = (await ext()).find(x => x.method === 'cron.job.create')
  assert.equal(created.params.enabled, false)
  assert.equal(created.params.targets, 'web')
  assert.equal(created.params.cron_expr, '0 0 3 * * * *')
  assert.ok(created.params.session_id)
  assert.match((await h.cmd(`cron toggle ${id} on`)).text, /enabled/)
  assert.match((await h.cmd(`cron run ${id}`)).text, /Triggered/)
  assert.match((await h.cmd(`cron get ${id}`)).text, /nightly/)
  assert.match((await h.cmd(`cron preview ${id}`)).text, /2026-11-01/)
  assert.match((await h.cmd(`cron delete ${id}`)).text, /Refusing/)
  assert.ok((await mock.rpc('debug.ext')).cron.some(j => j.id === id))
  assert.match((await h.cmd(`cron delete ${id} confirm`)).text, /Deleted/)
  assert.ok(!(await mock.rpc('debug.ext')).cron.some(j => j.id === id))
  assert.match((await h.cmd('cron create name=x')).text, /Usage/)
})

test('P2: heartbeat job toggle/run/cancel/delete(confirm)', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('heartbeat toggle hb-job-1 off')).text, /disabled/)
  assert.match((await h.cmd('heartbeat run hb-job-1')).text, /Triggered/)
  assert.match((await h.cmd('heartbeat cancel hb-job-1')).text, /Cancelled/)
  assert.match((await h.cmd('heartbeat delete hb-job-1')).text, /Refusing/)
  assert.match((await h.cmd('heartbeat delete hb-job-1 confirm')).text, /Deleted/)
})

test('P2: schedule writes soft-fail on a Gateway without schedule.*', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('schedule create name=a')).text, /not available/)
})

test('P2: permission rules add/update/delete(confirm)', async () => {
  const h = makeHost(mock)
  const r = await h.cmd('permissions rule add tools=bash,shell pattern="rm -rf *" action=deny severity=HIGH desc="no rm"')
  assert.match(r.text, /Created Jiuwen permission rule (ui_rule_\d+) \(bash,shell ~ rm -rf \* → deny\)/)
  const id = r.text.match(/rule (ui_rule_\d+)/)[1]
  const sent = (await ext()).find(x => x.method === 'permissions.rules.create')
  assert.deepEqual(sent.params.rule, { tools: ['bash', 'shell'], pattern: 'rm -rf *', action: 'deny', severity: 'HIGH', description: 'no rm' })
  assert.match((await h.cmd(`permissions rule update ${id} action=ask`)).text, /"action":"ask"/)
  assert.match((await h.cmd(`permissions rule delete ${id}`)).text, /Refusing/)
  assert.match((await h.cmd(`permissions rule delete ${id} confirm`)).text, /Deleted/)
  assert.ok(!(await mock.rpc('debug.ext')).rules.some(x => x.id === id))
  assert.match((await h.cmd('permissions')).text, /rules: 1/) // existing summary untouched
})

test('P2: continue-queued, swarm-stop, doc persist, media discard(confirm)', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('continue-queued')).text, /continue queued/)
  assert.match((await h.cmd('swarm-stop')).text, /Usage/)
  assert.match((await h.cmd('swarm-stop run-1')).text, /swarmflow\.stop for run run-1/)
  assert.match((await h.cmd('doc persist /tmp/a.pdf')).text, /\/uploads\/a\.pdf/)
  assert.match((await h.cmd('media discard /uploads/a.pdf')).text, /Refusing/)
  assert.match((await h.cmd('media discard /uploads/a.pdf confirm')).text, /Discarded/)
})

test('P2: host abort during a SwarmFlow run sends chat.interrupt + swarmflow.stop', async () => {
  const h = makeHost(mock)
  const ac = new AbortController()
  const it = h.run({ sessionId: 'swarm-abort', messages: [{ role: 'user', content: 'swarm-run go' }], signal: ac.signal })
  setTimeout(() => ac.abort(), 600)
  await it
  await new Promise(r => setTimeout(r, 200))
  const stop = (await ext()).find(x => x.method === 'swarmflow.stop' && x.params.run_id === 'run-77')
  assert.ok(stop, 'swarmflow.stop sent')
  assert.match((await h.cmd('swarm-stop', 'swarm-abort')).text, /run run-77/)
})

test('P2: swarmflowStopOnAbort=false keeps the previous abort behaviour', async () => {
  const h = makeHost(mock, { swarmflowStopOnAbort: false })
  const before = (await ext()).filter(x => x.method === 'swarmflow.stop').length
  const ac = new AbortController()
  const it = h.run({ sessionId: 'swarm-abort-2', messages: [{ role: 'user', content: 'swarm-run go' }], signal: ac.signal })
  setTimeout(() => ac.abort(), 600)
  await it
  await new Promise(r => setTimeout(r, 200))
  assert.equal((await ext()).filter(x => x.method === 'swarmflow.stop').length, before)
})

test('P2: swarmflow human turn → ctx.approval → chat.swarmflow_reply', async () => {
  const asked = []
  const agent = { id: 'sw-h' }
  const h = makeHost(mock, {}, { services: { approval: { request: async (r) => { asked.push(r); return 'allowed-once' } }, agents: { get: () => agent } } })
  const cs = await h.run({ sessionId: 'sw-h', messages: [{ role: 'user', content: 'swarm-human please' }] })
  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /Approve the outline/)
  assert.match(asked[0].toolName, /^swarmflow:/)
  const reply = (await ext()).find(x => x.method === 'chat.swarmflow_reply')
  assert.deepEqual({ run: reply.params.run_id, corr: reply.params.correlation_id, answer: reply.params.answer }, { run: 'run-42', corr: 'p1:review:1', answer: 'approved' })
  assert.match(cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /swarm resumed/)
})

test('P2: swarmflow human turn without approval UI is rejected (never fails open)', async () => {
  const h = makeHost(mock)
  await h.run({ sessionId: 'sw-h2', messages: [{ role: 'user', content: 'swarm-human please' }] })
  const reply = (await ext()).filter(x => x.method === 'chat.swarmflow_reply').pop()
  assert.match(reply.params.answer, /^rejected/)
})

test('P2: documentPersist (opt-in) pre-persists document attachments; off by default', async () => {
  const msg = [{ role: 'user', content: [{ type: 'text', text: 'echo-params doc' }, { type: 'file', attachment: { name: 'r.pdf', path: '/tmp/r.pdf', mimeType: 'application/pdf' } }] }]
  const n = async () => (await ext()).filter(x => x.method === 'document.persist').length
  const base = await n()
  await makeHost(mock).run({ sessionId: 'doc-off', messages: msg })
  assert.equal(await n(), base)
  await makeHost(mock, { documentPersist: true }).run({ sessionId: 'doc-on', messages: msg })
  assert.equal(await n(), base + 1)
})
