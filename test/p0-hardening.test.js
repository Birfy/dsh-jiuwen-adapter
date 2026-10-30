import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
import { createFeatureCache } from '../src/features.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const baseCtx = (extra = {}) => ({ llm: { registerAdapter() { return () => {} } }, logger: quiet, on() {}, ...extra })

test('P0: commands.register throwing inside inject callback does not crash apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-p0-'))
  const warns = []
  const ctx = baseCtx({
    logger: { ...quiet, warn: m => warns.push(m) },
    provide(n, v) { this[n] = v },
    inject(_deps, cb) { cb({ commands: { register() { throw new Error('duplicate command jiuwen') } }, on() {} }) },
  })
  assert.doesNotThrow(() => plugin.apply(ctx, { mappingPath: join(dir, 'm.json') }))
  assert.ok(warns.some(w => /could not register \/jiuwen/.test(w)))
  assert.equal(typeof ctx.jiuwenAdapter.command, 'function')
  rmSync(dir, { recursive: true, force: true })
})

test('P0: configurable command name (default jiuwen)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-p0-'))
  for (const [cfg, want] of [[{}, 'jiuwen'], [{ commandName: '/jw2' }, 'jw2']]) {
    const names = []
    const ctx = baseCtx({ provide(n, v) { this[n] = v }, inject(_d, cb) { cb({ commands: { register(d) { names.push(d.name); return () => {} } }, on() {} }) } })
    plugin.apply(ctx, { mappingPath: join(dir, 'm.json'), ...cfg })
    assert.deepEqual(names, [want])
  }
  rmSync(dir, { recursive: true, force: true })
})

test('P0: no ctx[serviceName] fallback without ctx.provide; warns instead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-p0-'))
  const warns = []
  const ctx = baseCtx({ logger: { ...quiet, warn: m => warns.push(m) } })
  plugin.apply(ctx, { mappingPath: join(dir, 'm.json') })
  assert.equal(ctx.jiuwenAdapter, undefined)
  assert.ok(warns.some(w => /ctx\.provide/.test(w)))
  const ctx2 = baseCtx({ logger: { ...quiet, warn: m => warns.push(m) }, provide() { throw new Error('service jiuwenAdapter already provided') } })
  assert.doesNotThrow(() => plugin.apply(ctx2, { mappingPath: join(dir, 'm.json') }))
  rmSync(dir, { recursive: true, force: true })
})

test('P0: feature cache marks unknown methods and fails fast', async () => {
  const fc = createFeatureCache()
  let calls = 0
  const raw = async (m) => { calls++; if (m === 'x.missing') throw new Error('unknown method: x.missing'); if (m === 'x.bad') throw Object.assign(new Error('"id is required"'), { code: 'TRANSPORT' }); return { ok: 1 } }
  const rpc = fc.wrap('u', raw)
  await assert.rejects(rpc('x.missing'), /unknown method/)
  await assert.rejects(rpc('x.missing'), e => e.code === 'UNSUPPORTED')
  assert.equal(calls, 1)
  await assert.rejects(rpc('x.bad'))
  assert.equal(fc.known('u', 'x.bad'), true)
  assert.deepEqual(await rpc('x.ok'), { ok: 1 })
  assert.equal(await fc.probe('u', raw, 'x.missing'), false)
  assert.equal(await fc.probe('u', raw, 'x.new'), true)
  assert.deepEqual(fc.unsupported('u'), ['x.missing'])
})

test('P0: typed event names are namespaced', () => {
  assert.equal(plugin.JIUWEN_EVENT, 'jiuwen/event')
  for (const v of Object.values(plugin.JIUWEN_TYPED_EVENTS)) assert.match(v, /^jiuwen\//)
})
