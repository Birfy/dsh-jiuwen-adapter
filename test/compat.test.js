/**
 * Compat: the Jiuwen adapter loaded next to a fake default `deepseek` adapter, built-in-style commands
 * (compact / plan / schedule) and a non-jiuwen session. No duplicate errors, non-jiuwen behaviour is
 * unchanged, hostSync/sessionSync/planBridge off == previous behaviour, a duplicate /jiuwen command name does not crash.
 */
import { test, before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import * as plugin from '../index.js'
import { startMock, quiet } from './helpers/mock-host.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())

function cordisLikeHost() {
  const adapters = new Map()
  const commands = new Map()
  const services = new Map()
  const listeners = {}
  const errors = []
  const emitted = []
  const logger = { ...quiet, error: m => errors.push(String(m)), warn: m => errors.push(`warn:${m}`) }
  const ctx = {
    logger,
    llm: {
      registerAdapter(ids, a) { for (const i of ids) { if (adapters.has(i)) throw new Error(`duplicate provider ${i}`); adapters.set(i, a) } return () => ids.forEach(i => adapters.delete(i)) },
      defaultModel: { provider: 'deepseek', model: 'deepseek-chat' },
    },
    provide(n, v) { if (services.has(n)) throw new Error(`service ${n} already provided`); services.set(n, v); this[n] = v },
    get(n) { return services.get(n) },
    on(n, fn) { (listeners[n] ||= []).push(fn); return () => {} },
    emit(n, ...a) { emitted.push(n); for (const fn of listeners[n] || []) fn(...a) },
    inject(_d, cb) { cb({ commands: { register(def) { if (commands.has(def.name)) throw new Error(`duplicate command /${def.name}`); commands.set(def.name, def); return () => commands.delete(def.name) } }, on() {} }) },
  }
  // built-ins + default deepseek adapter
  const deepseek = { calls: 0, async *stream() { this.calls++; yield { type: 'text-delta', text: 'deepseek-ok' } }, listModels: async () => [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek' }] }
  ctx.llm.registerAdapter(['deepseek'], deepseek)
  for (const name of ['compact', 'plan', 'schedule', 'goal']) ctx.inject(['commands'], c => c.commands.register({ name, handler: async () => ({ kind: 'success', text: `builtin ${name}` }) }))
  services.set('planMode', { get: () => ({ active: false }), set() { throw new Error('planMode must not be touched with flags off') } })
  return { ctx, adapters, commands, services, listeners, errors, emitted, deepseek }
}

test('compat: coexists with deepseek + built-in commands; hostSync off changes nothing else', async () => {
  const h = cordisLikeHost()
  const snapshot = { providers: [...h.adapters.keys()], cmds: [...h.commands.keys()], dm: { ...h.ctx.llm.defaultModel } }
  // Explicitly disable host sync + sessionSync so this case matches the old "flags off" contract.
  plugin.apply(h.ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, 'compat.json'), hostSync: false, sessionSync: false, planBridge: false })
  assert.deepEqual([...h.adapters.keys()], [...snapshot.providers, 'jiuwen'])
  assert.deepEqual([...h.commands.keys()], [...snapshot.cmds, 'jiuwen'])
  assert.deepEqual(h.ctx.llm.defaultModel, snapshot.dm) // never sets default model
  for (const n of ['compact', 'plan', 'schedule', 'goal']) assert.equal((await h.commands.get(n).handler({})).text, `builtin ${n}`)
  assert.deepEqual(h.errors, [])
  assert.deepEqual(Object.keys(h.listeners).filter(n => n !== 'dispose'), []) // no global listeners with sync off
  // non-jiuwen session: deepseek adapter untouched, no jiuwen mapping or event
  const out = []
  for await (const c of h.adapters.get('deepseek').stream({ provider: 'deepseek', model: 'deepseek-chat', sessionId: 'ds-1', messages: [] })) out.push(c)
  assert.equal(out[0].text, 'deepseek-ok')
  h.ctx.emit('session/created', { id: 'ds-1', header: { config: { provider: 'deepseek' } } })
  assert.equal(h.services.get('jiuwenAdapter').sessions.get('ds-1'), undefined)
  assert.ok(!h.emitted.some(n => n.startsWith('jiuwen/')))
  // jiuwen session works, only namespaced events
  for await (const _ of h.adapters.get('jiuwen').stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'jw-1', messages: [{ role: 'user', content: 'ping' }] })) { /* drain */ }
  assert.ok(h.emitted.length && h.emitted.every(n => n === 'jiuwen/event' || n === 'session/created'))
  assert.deepEqual(h.errors, [])
})

test('compat: all P3 flags on still leave non-jiuwen sessions alone', async () => {
  const h = cordisLikeHost()
  plugin.apply(h.ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, 'compat2.json'), sessionSync: true, planBridge: true, typedEvents: true, modelDiscovery: true })
  h.ctx.emit('session/created', { id: 'ds-2', header: { config: { provider: 'deepseek' } } })
  h.ctx.emit('session/disposed', { id: 'ds-2' })
  assert.equal(h.services.get('jiuwenAdapter').sessions.get('ds-2'), undefined)
  assert.equal((await h.adapters.get('deepseek').listModels()).length, 1)
  assert.ok(!h.errors.some(e => !e.startsWith('warn:')))
})

test('compat: duplicate /jiuwen command and duplicate service do not crash; commandName avoids the clash', () => {
  const h = cordisLikeHost()
  h.ctx.inject(['commands'], c => c.commands.register({ name: 'jiuwen', handler: async () => ({ kind: 'success', text: 'other plugin' }) }))
  h.services.set('jiuwenAdapter', { other: true })
  assert.doesNotThrow(() => plugin.apply(h.ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, 'compat3.json') }))
  assert.ok(h.errors.some(e => /could not register \/jiuwen/.test(e)))
  assert.ok(h.errors.some(e => /could not provide ctx\.jiuwenAdapter/.test(e)))
  assert.deepEqual(h.services.get('jiuwenAdapter'), { other: true })
  // second instance with its own namespace: needs its own provider id too
  assert.doesNotThrow(() => plugin.apply(h.ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, 'compat4.json'), provider: 'jiuwen2', commandName: 'jiuwen2', serviceName: 'jiuwenAdapter2' }))
  assert.ok(h.commands.has('jiuwen2'))
  assert.ok(h.services.has('jiuwenAdapter2'))
})

// ---- Real-host A/B compatibility (real dsh plugins in a real Cordis Context) -------------
import { execFileSync } from 'node:child_process'
import { existsSync as _exists, readFileSync as _read, readdirSync as _readdir } from 'node:fs'
const _ROOT = new URL('..', import.meta.url).pathname
const _NM = process.env.DSH_NM || '/workspace/fb-busyack3/core/dev/harness/node_modules'
const _hasHost = _exists(`${_NM}/@deepseek-ai/cordis/lib/index.js`) && _exists(`${_NM}/@deepseek-ai/dsh-llm/lib/index.js`)
const _probe = (...a) => JSON.parse(execFileSync(process.execPath, [`${_ROOT}scripts/compat-host.mjs`, ...a], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }))

describe('real-host A/B compatibility', { skip: !_hasHost && 'dsh host packages not found (set DSH_NM)' }, () => {
  let base
  let base0; before(() => { base = base0 ??= _probe() })
  for (const variant of [['--jiuwen', '--down'], ['--jiuwen', '--down', '--order=before'], ['--jiuwen', '--down', '--two'], ['--jiuwen', '--down', '--two', '--order=before']]) {
    it(`non-jiuwen behavior identical: ${variant.join(' ')}`, () => {
      const r = _probe(...variant)
      assert.deepEqual(r.failed, [])
      assert.equal(r.loaded, base.loaded)
      assert.equal(r.servicesUnchanged, true, 'no foreign service replaced')
      for (const k of ['nonJiuwen', 'nonJiuwenAfterJwTurn', 'nonJiuwenAfterDispose']) assert.equal(r[k], base.nonJiuwen, k)
      assert.deepEqual(r.nonJwEvents, base.nonJwEvents, 'no extra events during a non-jiuwen turn')
      assert.deepEqual(r.foreignEventsFromJiuwen, [])
      assert.ok(r.jwEvents.every(e => e.startsWith('jiuwen/')))
      assert.deepEqual(r.globalsAdded, base.globalsAdded)
      assert.deepEqual(r.protosChanged, [])
      assert.equal(r.envChanged, false)
      assert.deepEqual(r.procListenersDelta, {})
      assert.deepEqual(r.providersAfterDispose, base.providersAfterDispose)
      assert.deepEqual(r.cmdsAfterDispose, [])
      assert.ok(!r.jwCmd?.startsWith('THROW') && !r.jwTurn?.startsWith('THROW'), 'gateway down fails soft')
      assert.deepEqual(r.unhandled, [])
      const n = o => Object.values(o).reduce((a, b) => a + b, 0)
      assert.ok(n(r.resourcesAfterDispose) <= n(base.resourcesAfterDispose), `no leaked handles: ${JSON.stringify(r.resourcesAfterDispose)}`)
    })
  }
  it('stress on mock gateway: concurrency, rapid commands, reconnect storm, leaks', () => {
    const r = JSON.parse(execFileSync(process.execPath, [`${_ROOT}scripts/stress.mjs`], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }))
    assert.equal(r.concurrent.ok, 30); assert.equal(r.concurrent.distinctJiuwenSessions, 10); assert.equal(r.concurrent.crossTalk, false)
    assert.equal(r.rapidCommands.fulfilled, 50); assert.equal(r.rapidCommands.errText, 0)
    for (const s of r.reconnectStorm) { assert.match(s.down, /finish:error/); assert.match(s.up, /up\d/) }
    assert.equal(r.leak.procListenersSame, true); assert.equal(r.leak.serviceGone, true); assert.deepEqual(r.leak.providersAfter, [])
    assert.ok(r.leak.after.every(x => x === 'PipeWrap'), JSON.stringify(r.leak.after))
    assert.deepEqual(r.unhandled, [])
  })
})

describe('static: no global mutation in src/', () => {
  it('mcp bridge detaches its process exit listener on stop', () => {
    const src = _read(`${_ROOT}src/mcp-bridge.js`, 'utf8')
    assert.ok((src.match(/process\.off\('exit', removeEp\)/g) || []).length >= 2)
  })
  it('no env writes, globalThis writes, prototype patches or process listeners', () => {
    const bad = /process\.env(\.\w+|\[[^\]]+\])\s*=(?!=)|globalThis\.\w+\s*=(?!=)|\.prototype\.\w+\s*=(?!=)|process\.(on|once|addListener|prependListener)\(|Object\.defineProperty\((globalThis|Object|Array|Function|String|Promise)\b/
    for (const f of _readdir(`${_ROOT}src`).filter(f => f.endsWith('.js'))) {
      const hit = _read(`${_ROOT}src/${f}`, 'utf8').split('\n').find(l => bad.test(l) && !l.includes('compat-allow:'))
      assert.equal(hit, undefined, `${f}: ${hit}`)
    }
  })
})
