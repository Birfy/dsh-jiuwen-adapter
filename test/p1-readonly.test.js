import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'
import { maskSecrets, tokenize, kv } from '../src/commands-ext.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

test('maskSecrets / tokenize / kv', () => {
  assert.deepEqual(maskSecrets({ api_key: 'x', a: { access_token: 't', b: 1 }, video_api_key: '', list: [{ password: 'p' }] }), { api_key: '***', a: { access_token: '***', b: 1 }, video_api_key: '(empty)', list: [{ password: '***' }] })
  assert.deepEqual(tokenize(`create name=a expr="*/5 * * * *" 'x y'`), ['create', 'name=a', 'expr=*/5 * * * *', 'x y'])
  assert.deepEqual(kv(['a=1', 'b=x=y', 'c']), { a: '1', b: 'x=y' })
})

test('P1: config get masks secrets (incl api_key)', async () => {
  const h = makeHost(mock)
  const all = await h.cmd('config')
  assert.equal(all.kind, 'success')
  assert.match(all.text, /api_key=\*\*\*/)
  assert.doesNotMatch(all.text, /sk-secret-123/)
  assert.match((await h.cmd('config get nested')).text, /"access_token":"\*\*\*"/)
  assert.match((await h.cmd('config get model')).text, /mock-model/)
  assert.match((await h.cmd('config get nope.x')).text, /no key/)
})

test('P1: read-only subcommands answer from the mock', async () => {
  const h = makeHost(mock)
  const cases = [
    ['mcp show mcp-1', /mock-mcp.*\n.*connected/s],
    ['skills search pdf', /mock-skill desc: about pdf/],
    ['skills online pdf', /online-skill/],
    ['skills show mock-skill', /Jiuwen skill mock-skill/],
    ['memory forbidden', /enabled; patterns: height, weight/],
    ['memory context', /state=CREATED/],
    ['memory context config', /model=openai:mock/],
    ['memory context services', /\(0\)/],
    ['cron meta', /default_mode=agent/],
    ['heartbeat meta', /min_interval=60s/],
    ['heartbeat job hb-job-1', /mock-hb/],
    ['team history', /lead assigned task/],
    ['team snapshot', /team=t1, members=1/],
    ['template show t1', /工程质量顾问/],
    ['group', /designer/],
    ['group show designer', /members \(1\)/],
    ['git status', /branch=main, dirty=false/],
    ['git diff', /M a\.js/],
    ['models validate', /ok — reachable/],
    ['permissions overrides', /\(0\)/],
    ['permissions scopes', /owner scopes: none/],
    ['document formats', /\.exe/],
  ]
  for (const [c, re] of cases) {
    const r = await h.cmd(c)
    assert.equal(r.kind, 'success', `${c}: ${r.text}`)
    assert.match(r.text, re, c)
  }
  // existing subcommands keep working
  assert.match((await h.cmd('cron')).text, /cron/i)
  assert.match((await h.cmd('heartbeat jobs')).text, /hb-job-1/)
  assert.match((await h.cmd('skills')).text, /mock-skill/)
})

test('P1: models validate refuses credentials in args', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('models validate api_key=sk-1')).text, /Refusing/)
})

test('P1: unsupported methods soft-fail once, then are cached and hidden from help', async () => {
  const h = makeHost(mock)
  assert.match((await h.cmd('help')).text, /schedule \[list/)
  const r1 = await h.cmd('schedule list')
  assert.equal(r1.kind, 'success')
  assert.match(r1.text, /not available on this Gateway — schedule\.list/)
  const r2 = await h.cmd('schedule status')
  assert.match(r2.text, /not available/)
  assert.doesNotMatch((await h.cmd('help')).text, /schedule \[list/)
  assert.ok(h.api.gateway.unsupported().includes('schedule.list'))
  assert.equal(await h.api.gateway.supports('config.get'), true)
  assert.equal(await h.api.gateway.supports('schedule.logs'), false)
})
