import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayTransport } from '../src/gateway-transport.js'
import { createFeatureCache } from '../src/features.js'

/** Fake WS: opens, acks, then closes when a req arrives (Gateway killed mid-RPC). */
const fakeWs = ({ open = true, closeOnSend = true } = {}) => class extends EventTarget {
  constructor () {
    super()
    if (open) setTimeout(() => {
      this.dispatchEvent(new Event('open'))
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'event', event: 'connection.ack' }) })), 5)
    }, 5)
  }
  send () { if (closeOnSend) setTimeout(() => this.dispatchEvent(new Event('close')), 10) }
  close () {}
}

test('unary RPC fails fast when the Gateway drops mid-RPC (not after the RPC timeout)', async () => {
  const t = new GatewayTransport({ gatewayURL: 'ws://127.0.0.1:1/ws', WebSocketImpl: fakeWs() })
  const t0 = Date.now()
  await assert.rejects(t.rpc('session.list', {}, { timeoutMs: 20_000 }), e => e.code === 'TRANSPORT' && e.dropped === true)
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0}ms`)
})

test('history page fails fast on drop', async () => {
  const t = new GatewayTransport({ gatewayURL: 'ws://127.0.0.1:1/ws', WebSocketImpl: fakeWs() })
  const t0 = Date.now()
  await assert.rejects(t.historyMessages('s', { timeoutMs: 20_000 }), e => e.dropped === true)
  assert.ok(Date.now() - t0 < 2000)
})

test('half-open Gateway (no WS open) times out the connect instead of hanging', async () => {
  const t = new GatewayTransport({ gatewayURL: 'ws://127.0.0.1:1/ws', WebSocketImpl: fakeWs({ open: false }), requestTimeoutMs: 1000 })
  await assert.rejects(t.rpc('session.list', {}), /connect timed out/)
})

test('a dropped RPC is not cached as supported/unsupported', async () => {
  const f = createFeatureCache()
  const raw = async () => { throw Object.assign(new Error('RPC x: Gateway WebSocket closed'), { code: 'TRANSPORT', dropped: true }) }
  await assert.rejects(f.wrap('u', raw)('x', {}))
  assert.equal(f.known('u', 'x'), undefined)
})
