import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateConfig, suggestKey, RAW_KEYS } from '../src/config-validate.js'
import * as plugin from '../index.js'

test('clean config and empty config produce no warnings', () => {
  assert.deepEqual(validateConfig({}), [])
  assert.deepEqual(validateConfig(undefined), [])
  assert.deepEqual(validateConfig({ provider: 'jiuwen', mode: 'gateway', gatewayURL: 'ws://x/ws', requestTimeoutMs: 1000, models: [] }), [])
})
test('misspelled keys get the closest suggestion; nonsense gets none', () => {
  const w = validateConfig({ gatewayUrl: 'ws://x', reqestTimeoutMs: 5, zzzqqq: 1 })
  assert.match(w[0], /unknown config key "gatewayUrl" \(did you mean "gatewayURL"\?\)/)
  assert.match(w[1], /did you mean "requestTimeoutMs"/)
  assert.match(w[2], /unknown config key "zzzqqq"; ignored/)
  assert.equal(suggestKey('typedEvent'), 'typedEvents')
})
test('deprecated keys/values and wrong types warn; non-object warns', () => {
  const w = validateConfig({ apiKey: 'sk-should-not-be-here', compactionMode: 'jiuwen', typedEvents: 'yes', models: {} })
  assert.ok(w.some(x => /"apiKey" is deprecated/.test(x)))
  assert.ok(!w.some(x => x.includes('sk-should-not-be-here')), 'never echoes secret values')
  assert.ok(w.some(x => /compactionMode: "jiuwen" is deprecated/.test(x)))
  assert.ok(w.some(x => /"typedEvents" should be a boolean/.test(x)))
  assert.ok(w.some(x => /"models" should be an array/.test(x)))
  assert.match(validateConfig([1])[0], /must be an object/)
})
test('RAW_KEYS stays in sync with every raw.<key> read in src/config.js', () => {
  const src = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  const read = [...new Set([...src.matchAll(/raw\??\.([a-zA-Z_]+)/g)].map(m => m[1]))].sort()
  assert.deepEqual(read.filter(k => !RAW_KEYS.includes(k)), [])
})
test('plugin apply warns through the host logger and never throws on a bad config', () => {
  const warns = []
  const ctx = { logger: { warn: m => warns.push(m), info() {}, debug() {}, error() {} }, llm: { registerAdapter: () => () => {} }, on: () => () => {}, effect: () => {}, get: () => undefined }
  assert.doesNotThrow(() => plugin.apply(ctx, { gatwayURL: 'ws://127.0.0.1:1/ws', registerCommands: false, mappingPath: '/tmp/jw-cv-test.json' }))
  assert.ok(warns.some(w => /\[jiuwen\] unknown config key "gatwayURL" \(did you mean "gatewayURL"\?\)/.test(w)), JSON.stringify(warns))
})
