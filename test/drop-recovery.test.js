import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startMock, makeHost } from './helpers/mock-host.js'
import { RECOVERED_MARK } from '../src/gateway-transport.js'

let mock
before(async () => { mock = await startMock() })
after(() => mock?.stop())
const text = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const fin = cs => cs.find(c => c.type === 'finish')?.reason

test('mid-stream drop: the answer is recovered from history, marked, and the turn finishes ok', async () => {
  const h = makeHost(mock, { recoverWindowMs: 3000 })
  const cs = await h.run({ sessionId: 'drop-1', messages: [{ role: 'user', content: 'please drop-mid now' }] })
  const t = text(cs)
  assert.equal(fin(cs).kind, 'stop', JSON.stringify(fin(cs)))
  assert.ok(t.includes(RECOVERED_MARK), t)
  assert.ok(t.replace(`\n\n${RECOVERED_MARK}`, '').startsWith('gateway-mock: please drop-mid now'), t)
  const blocks = cs.filter(c => c.type === 'block-start')
  assert.equal(blocks.filter(b => b.blockType === 'text').length, 1, 'one text block, no duplicate starts')
})

test('mid-stream drop with nothing in history keeps the clear error', async () => {
  const h = makeHost(mock, { recoverWindowMs: 600 })
  const cs = await h.run({ sessionId: 'drop-2', messages: [{ role: 'user', content: 'drop-lost please' }] })
  assert.equal(fin(cs).kind, 'error')
  assert.match(JSON.stringify(fin(cs)), /closed mid-turn/)
})

test('recoverOnDrop:false keeps the old behaviour (error, no history lookups)', async () => {
  const h = makeHost(mock, { recoverOnDrop: false })
  const cs = await h.run({ sessionId: 'drop-3', messages: [{ role: 'user', content: 'please drop-mid again' }] })
  assert.equal(fin(cs).kind, 'error')
  assert.ok(!text(cs).includes(RECOVERED_MARK))
})

test('_recoverFromHistory: continuation returns only the missing suffix without doubling whitespace', async () => {
  const { GatewayTransport } = await import('../src/gateway-transport.js')
  const t = new GatewayTransport({ gatewayURL: 'ws://127.0.0.1:1/ws', recoverWindowMs: 200 })
  t.historyMessages = async () => ({ messages: [{ role: 'user', content: 'count' }, { role: 'assistant', content: '1 2 3 4', event_type: 'chat.final' }] })
  assert.deepEqual(await t._recoverFromHistory('s', 'count', '1 2 '), { text: '3 4', continued: true })
  assert.deepEqual(await t._recoverFromHistory('s', 'count', ''), { text: '1 2 3 4', continued: false })
  t.historyMessages = async () => ({ messages: [{ role: 'user', content: 'other' }, { role: 'assistant', content: 'x' }] })
  assert.equal(await t._recoverFromHistory('s', 'count', ''), undefined, 'answer to a different query is never used')
})
