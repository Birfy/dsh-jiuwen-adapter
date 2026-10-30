/**
 * Compat: the Jiuwen adapter loaded next to a fake default `deepseek` adapter, built-in-style commands
 * (compact / plan / schedule) and a non-jiuwen session. No duplicate errors, non-jiuwen behaviour is
 * unchanged, all flags off == previous behaviour, a duplicate /jiuwen command name does not crash.
 */
import { test, before, after } from 'node:test'
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

test('compat: coexists with deepseek + built-in commands; flags off changes nothing else', async () => {
  const h = cordisLikeHost()
  const snapshot = { providers: [...h.adapters.keys()], cmds: [...h.commands.keys()], dm: { ...h.ctx.llm.defaultModel } }
  plugin.apply(h.ctx, { gatewayURL: mock.url, mappingPath: join(mock.dir, 'compat.json') })
  assert.deepEqual([...h.adapters.keys()], [...snapshot.providers, 'jiuwen'])
  assert.deepEqual([...h.commands.keys()], [...snapshot.cmds, 'jiuwen'])
  assert.deepEqual(h.ctx.llm.defaultModel, snapshot.dm) // never sets default model
  for (const n of ['compact', 'plan', 'schedule', 'goal']) assert.equal((await h.commands.get(n).handler({})).text, `builtin ${n}`)
  assert.deepEqual(h.errors, [])
  assert.deepEqual(Object.keys(h.listeners).filter(n => n !== 'dispose'), []) // no global listeners with flags off (own dispose only)
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
