import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from '../bin/_ws-server.mjs'
import { GatewayTransport } from '../src/gateway-transport.js'

test('gateway transport streams chat.delta to finish', async () => {
  const port = 19051 + Math.floor(Math.random() * 1000)
  const wss = await WebSocketServer({ port, host: '127.0.0.1' })
  try {
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'event', event: 'connection.ack', payload: {} }))
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.method !== 'chat.send') return
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true }))
        ws.send(JSON.stringify({
          type: 'event', event: 'chat.delta',
          payload: { event_type: 'chat.delta', content: 'gw-' },
        }))
        ws.send(JSON.stringify({
          type: 'event', event: 'chat.final',
          payload: { event_type: 'chat.final', content: 'gw-ok' },
        }))
      })
    })

    const t = new GatewayTransport({
      gatewayURL: `ws://127.0.0.1:${port}/ws`,
      userId: 'test',
      requestTimeoutMs: 10_000,
    })
    const chunks = []
    for await (const c of t.stream(
      { provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: 'ping' }] },
      { jiuwenSessionId: 's1' },
    )) chunks.push(c)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.match(text, /gw/)
    assert.equal(chunks.at(-1).type, 'finish')
  } finally {
    await wss.close?.()
  }
})
