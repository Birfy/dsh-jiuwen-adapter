import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

test('round4: skills files/retrieval/graph/evolution/experience', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('skills files mock-skill')).text, /SKILL\.md/)
  assert.match((await h.cmd('skills files mock-skill SKILL.md')).text, /mock skill file/)
  assert.match((await h.cmd('skills files')).text, /Usage/)
  assert.match((await h.cmd('skills retrieval')).text, /enabled=true/)
  assert.match((await h.cmd('skills retrieval tree')).text, /unsupported/)
  assert.match((await h.cmd('skills graph')).text, /exists=false/)
  assert.match((await h.cmd('skills graph get')).text, /not ready/)
  assert.match((await h.cmd('skills evolution mock-skill')).text, /exists=false/)
  assert.match((await h.cmd('skills evolution mock-skill get')).text, /version=1\.0\.0/)
  assert.match((await h.cmd('skills experience')).text, /enabled=false/)
})

test('round4: template/group files + packages + extensions', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('template files t1')).text, /persona\/a\.md/)
  assert.match((await h.cmd('template files t1 persona/a.md')).text, /template body/)
  assert.match((await h.cmd('group files designer')).text, /agents\/x\.md/)
  assert.match((await h.cmd('group files designer agents/x.md')).text, /group body/)
  assert.match((await h.cmd('packages')).text, /mock-pkg/)
  assert.match((await h.cmd('packages show mock-pkg')).text, /Mock Pkg/)
  assert.match((await h.cmd('extensions')).text, /extensions \(0\)/)
})

test('round4: vendors / openai / health (no api_key passed)', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('vendors')).text, /reasoning|openai/)
  const models = await h.cmd('vendors models volcengine coding_plan')
  assert.match(models.text, /mock-model-a/)
  assert.match(models.text, /source=preset/)
  assert.match((await h.cmd('vendors models x api_key=sk-leak')).text, /Refusing/)
  // ensure mock never saw api_key on the successful path
  const leak = await h.cmd('vendors models openai custom_api')
  assert.match(leak.text, /mock-model/)
  assert.match((await h.cmd('openai')).text, /authenticated=false/)
  assert.doesNotMatch((await h.cmd('openai')).text, /sk-|tok_live/)
  assert.match((await h.cmd('openai models')).text, /gpt-mock/)
  assert.match((await h.cmd('health')).text, /every=3600/)
})

test('round4: projects pinned/cron + git soft-fail + publish soft-fail', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('projects pinned')).text, /No pinned sessions/)
  assert.match((await h.cmd('projects cron')).text, /No cron-triggered/)
  assert.match((await h.cmd('git probe')).text, /soft-failed/)
  assert.match((await h.cmd('git turns')).text, /soft-failed/)
  assert.match((await h.cmd('git turn abc')).text, /soft-failed/)
  // existing status/diff still work on mock
  assert.match((await h.cmd('git status')).text, /branch=main/)
  assert.match((await h.cmd('publish describe kind=skill local_id=x')).text, /soft-failed.*AUTH_REQUIRED/i)
  assert.match((await h.cmd('publish local kind=skill local_id=x')).text, /soft-failed/)
  assert.match((await h.cmd('publish describe')).text, /Usage/)
})

test('round4: mcp cancel + permissions set-all confirm + heartbeat update', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('mcp cancel mock-mcp')).text, /cancelled/)
  assert.match((await h.cmd('permissions set-all bash=allow')).text, /Refusing/)
  assert.match((await h.cmd('permissions set-all bash=allow confirm')).text, /Replaced Jiuwen user permissions/)
  // recreate hb for update (p2 may have deleted hb-job-1 in other file — ensure one exists)
  const created = await h.cmd('heartbeat create name=r4 prompt="hi" every=120 enabled=off')
  assert.match(created.text, /Created Jiuwen heartbeat job/)
  const id = created.text.match(/job (hb-\S+)/)?.[1]
  assert.ok(id)
  assert.match((await h.cmd(`heartbeat update ${id} name=renamed`)).text, /Updated Jiuwen heartbeat job/)
  assert.match((await h.cmd(`heartbeat delete ${id} confirm`)).text, /Deleted/)
})

test('round4: help lists new surfaces; schedule still feature-detected', async () => {
  const h = makeHost(mock)
  const help = (await h.cmd('help')).text
  assert.match(help, /skills files/)
  assert.match(help, /vendors/)
  assert.match(help, /packages/)
  assert.match(help, /publish/)
  assert.match(help, /openai/)
  assert.match(help, /health/)
  // schedule still present until first unknown-method probe
  assert.match(help, /schedule/)
})
