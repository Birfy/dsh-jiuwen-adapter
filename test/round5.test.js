import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

test('round5: channels list + conf masks secrets', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('channels')).text, /web, tui/)
  const c = (await h.cmd('channels conf feishu')).text
  assert.match(c, /"app_secret":"\*\*\*"/)
  assert.match(c, /"encrypt_key":"\*\*\*"/)
  assert.doesNotMatch(c, /very-secret|"ek"|"vt"/)
  assert.match((await h.cmd('channels conf nope')).text, /Usage/)
})

test('round5: rsi reads + masked tokens + usage', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('rsi')).text, /rt1 \[done\]/)
  assert.match((await h.cmd('rsi versions')).text, /active=none/)
  const r = (await h.cmd('rsi report rt1')).text
  assert.match(r, /"token":"\*\*\*"/)
  assert.match((await h.cmd('rsi task')).text, /Usage/)
  const nf = await h.cmd('rsi task nope')
  assert.equal(nf.kind, 'error'); assert.match(nf.text, /任务不存在/)
})

test('round5: personal context + issues feature-detected + harness soft-fail', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('context search notes')).text, /page about notes/)
  assert.match((await h.cmd('context runs')).text, /\(0\)/)
  assert.match((await h.cmd('context auth github')).text, /authorized/)
  assert.match((await h.cmd('context')).text, /Usage/)
  assert.match((await h.cmd('issues')).text, /not available on this Gateway/)
  assert.match((await h.cmd('issues matrix')).text, /not available/)
  assert.doesNotMatch((await h.cmd('help')).text, /issues \[matrix/)
  assert.match((await h.cmd('harness packages')).text, /soft-failed/)
})

test('round5: skills hub reads (nothing installed)', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('skills hub team pdf')).text, /team-skill/)
  assert.match((await h.cmd('skills hub team-info')).text, /Native Agent/)
  assert.match((await h.cmd('skills hub swarm x')).text, /soft-failed/)
  assert.match((await h.cmd('skills hub recommend a1')).text, /rec-1/)
  assert.match((await h.cmd('skills hub skillnet pdf')).text, /skillnet-hit/)
  assert.match((await h.cmd('skills hub clawhub pdf')).text, /clawhub-hit/)
  assert.match((await h.cmd('skills hub')).text, /Usage/)
})

test('round5: reversible toggles + project rename/pin', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('marketplace toggle baoyu on')).text, /baoyu enabled/)
  assert.match((await h.cmd('marketplace toggle baoyu')).text, /Usage/)
  assert.match((await h.cmd('extensions toggle e1 off')).text, /e1 disabled/)
  assert.match((await h.cmd('extensions')).text, /extensions \(0\)/) // bare still lists
  assert.match((await h.cmd('projects rename p2 New Name')).text, /p2 → New Name/)
  assert.equal((await h.cmd('projects rename default x')).kind, 'error')
  assert.match((await h.cmd('projects pin p2')).text, /pinned/)
  assert.match((await h.cmd('projects pin p2 off')).text, /unpinned/)
  assert.match((await h.cmd('projects')).text, /Default/) // bare projects unaffected
})

test('round5: command hint/description list extended subcommands', async () => {
  const h = makeHost(mock)
  const def = h.commands.find(c => c.name === 'jiuwen')
  for (const s of ['channels', 'rsi', 'context', 'vendors', 'publish', 'marketplace toggle']) assert.match(def.input.hint, new RegExp(s))
  for (const s of ['channels', 'rsi', 'packages', 'vendors']) assert.match(def.description, new RegExp(s))
})
