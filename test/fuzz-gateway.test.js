/**
 * Adversarial Gateway frames against GatewayTransport.stream: malformed frames, out-of-order and
 * duplicated events, unicode/control characters, rapid send/cancel, slow acks, id collisions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from '../bin/_ws-server.mjs'
import { GatewayTransport } from '../src/gateway-transport.js'
import { SessionStore } from '../src/session-store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ev = (event, payload = {}) => JSON.stringify({ type: 'event', event, payload: { event_type: event, ...payload } })
async function server(script) {
  const port = 21000 + Math.floor(Math.random() * 8000)
  const wss = await WebSocketServer({ port, host: '127.0.0.1' })
  const state = { open: 0, sends: [], frames: [] }
  wss.on('connection', (ws) => {
    state.open++
    ws.on('error', () => {}) // peer resets during rapid cancel are expected
    ws.on('close', () => { state.open-- })
    ws.send(JSON.stringify({ type: 'event', event: 'connection.ack', payload: {} }))
    ws.on('message', async (raw) => {
      let f; try { f = JSON.parse(String(raw)) } catch { return }
      state.frames.push(f)
      if (f.method === 'chat.send') { state.sends.push(f); await script(ws, f, state) }
    })
  })
  return { url: `ws://127.0.0.1:${port}/ws`, state, close: () => wss.close?.() }
}
const transport = (url, extra = {}) => new GatewayTransport({ gatewayURL: url, userId: 't', requestTimeoutMs: 5000, finalGraceMs: 50, terminalFinalGraceMs: 50, ...extra })
async function collect(t, mapping = { jiuwenSessionId: 's1' }, opts = {}, turn = {}) {
  const chunks = []
  for await (const c of t.stream({ provider: 'jiuwen', model: 'm', messages: [{ role: 'user', content: 'ping' }], ...opts }, mapping, turn)) chunks.push(c)
  return { chunks, text: chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), finish: chunks.filter(c => c.type === 'finish') }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('fuzz: malformed / non-object frames are ignored, the turn still completes', async () => {
  const s = await server(async (ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    for (const junk of ['not json', '{"type":', 'null', '42', '"str"', '[]', '[1,2]', 'true', JSON.stringify({}), JSON.stringify({ type: 'event' }),
      JSON.stringify({ type: 'event', event: 'chat.delta', payload: null }), JSON.stringify({ type: 'event', event: 'chat.delta', payload: 'x' }),
      JSON.stringify({ type: 'event', event: 'chat.delta', payload: { content: { nested: 1 } } }), JSON.stringify({ type: 'event', event: 123, payload: {} }),
      JSON.stringify({ type: 'event', event: 'chat.tool_call', payload: { tool_call: null } }), JSON.stringify({ type: 'res', id: null }),
      Buffer.from([0xff, 0xfe, 0x00]), JSON.stringify({ type: 'event', event: 'chat.unknown_future', payload: { a: 1 } })]) ws.send(junk)
    ws.send(ev('chat.delta', { content: 'ok-' }))
    ws.send(ev('chat.final', { content: 'ok-done' }))
  })
  try {
    const r = await collect(transport(s.url))
    assert.equal(r.text, 'ok-done')
    assert.equal(r.finish.length, 1); assert.equal(r.finish[0].reason.kind, 'stop')
  } finally { await s.close() }
})

test('fuzz: out-of-order (events before ack, final before deltas) and duplicated finals', async () => {
  const s = await server(async (ws, f) => {
    ws.send(ev('chat.delta', { content: 'A' })) // before ack
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.final', { content: 'AB' }))
    ws.send(ev('chat.delta', { content: 'C' })) // late delta after final
    ws.send(ev('chat.final', { content: 'AB' }))
    ws.send(ev('chat.final', { content: 'AB' }))
    ws.send(ev('chat.final', { content: '' }))
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true })) // duplicated ack
  })
  try {
    const r = await collect(transport(s.url))
    assert.equal(r.finish.length, 1)
    assert.ok(/^ABC?$/.test(r.text), r.text) // never duplicated
  } finally { await s.close() }
})

test('fuzz: unicode / control characters / lone surrogates in tool args and names', async () => {
  const nasty = 'a\u0000b\u0007\u001b[31m\u202e\ud83d\ude00\ud800 "q" \\ `x` </script>\n```'
  const s = await server(async (ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.tool_call', { tool_call: { name: `t${nasty}`, tool_call_id: 'c1', arguments: { s: nasty, deep: [nasty, { k: nasty }] } } }))
    ws.send(ev('chat.tool_call', { tool_call: { name: 'raw', tool_call_id: 'c2', arguments: `{"s":"${'😀'.repeat(400)}` } })) // invalid JSON string args
    ws.send(ev('chat.tool_result', { tool_name: nasty, tool_call_id: 'c1', result: { out: nasty.repeat(50) } }))
    ws.send(ev('chat.final', { content: `done ${nasty}` }))
  })
  for (const extra of [{}, { trajectoryDetail: 'full' }, { eventDisplay: 'markers' }]) {
    const events = []
    try {
      const r = await collect(transport(s.url, extra), { jiuwenSessionId: 's1' }, {}, { onEvent: e => events.push(e) })
      assert.equal(r.finish.at(-1).reason.kind, 'stop', JSON.stringify(extra))
      assert.ok(r.text.endsWith(`done ${nasty}`))
      const calls = events.filter(e => e.type === 'tool_call')
      assert.equal(calls.length, 2)
      assert.deepEqual(JSON.parse(calls[0].arguments).deep[1].k, nasty)
      for (const c of r.chunks) assert.doesNotThrow(() => JSON.stringify(c))
      // truncation never leaves a dangling high surrogate from splitting an emoji
      for (const c of r.chunks.filter(c => typeof c.text === 'string')) assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(c.text.replace(/\ud800 /g, '')), 'split surrogate')
    } catch (e) { await s.close(); throw e }
  }
  await s.close()
})

test('fuzz: rapid send/cancel loop — every turn finishes, no socket leak, no unhandled rejection', async () => {
  const unhandled = []
  const onU = e => unhandled.push(e)
  process.on('unhandledRejection', onU)
  const s = await server(async (ws, f) => {
    await sleep(Math.floor(Math.random() * 4))
    try { ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true })); ws.send(ev('chat.delta', { content: 'x' })) } catch { /* closed */ }
    await sleep(30)
    try { ws.send(ev('chat.final', { content: 'x' })) } catch { /* closed */ }
  })
  try {
    const t = transport(s.url, { interruptOnAbort: true })
    const kinds = []
    for (let i = 0; i < 40; i++) {
      const ac = new AbortController()
      setTimeout(() => ac.abort(), i % 5)
      const r = await collect(t, { jiuwenSessionId: `rapid-${i % 3}` }, { signal: ac.signal }).catch(e => ({ finish: [{ reason: { kind: `throw:${e.code || e.name}` } }] }))
      kinds.push(r.finish.at(-1)?.reason?.kind)
    }
    assert.equal(kinds.length, 40)
    assert.ok(kinds.every(k => k === 'aborted' || k === 'stop'), JSON.stringify([...new Set(kinds)]))
    const deadline = Date.now() + 3000
    while (s.state.open > 0 && Date.now() < deadline) await sleep(50)
    assert.equal(s.state.open, 0, 'all per-turn sockets closed')
    await sleep(50)
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onU); await s.close() }
})

test('fuzz: slow ack within the timeout works; ack never arriving times out cleanly', async () => {
  const slow = await server(async (ws, f) => {
    await sleep(800)
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    ws.send(ev('chat.final', { content: 'late but fine' }))
  })
  try { assert.equal((await collect(transport(slow.url))).text, 'late but fine') } finally { await slow.close() }
  const never = await server(async () => {})
  try {
    const t0 = Date.now()
    const r = await collect(transport(never.url, { requestTimeoutMs: 1200 })).then(r => r.finish.at(-1)?.reason?.kind, e => `throw:${e.code}`)
    assert.ok(Date.now() - t0 < 4000, 'bounded by requestTimeoutMs')
    assert.ok(/error|TIMEOUT/.test(String(r)), String(r))
    await sleep(200)
    assert.equal(never.state.open, 0, 'socket closed after timeout')
  } finally { await never.close() }
})

test('fuzz: same Jiuwen session id on concurrent turns — no cross-talk (one socket per turn)', async () => {
  const s = await server(async (ws, f) => {
    ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true }))
    const q = String(f.params?.query || '')
    await sleep(q.includes('slow') ? 150 : 10)
    ws.send(ev('chat.final', { content: `echo:${q}` }))
  })
  try {
    const t = transport(s.url)
    const one = (q) => collect(t, { jiuwenSessionId: 'same' }, { messages: [{ role: 'user', content: q }] }, { query: q })
    const [a, b, c] = await Promise.all([one('slow-a'), one('b'), one('c')])
    assert.deepEqual([a.text, b.text, c.text], ['echo:slow-a', 'echo:b', 'echo:c'])
  } finally { await s.close() }
})

test('fuzz: hostile dsh session ids in the mapping store (prototype keys, unicode, huge)', () => {
  const st = new SessionStore(join(mkdtempSync(join(tmpdir(), 'jw-fuzz-')), 'm.json'))
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', ' ', '😀\u0000\u202e', 'x'.repeat(10_000), '../../etc/passwd']) {
    const m = st.ensure(id)
    assert.equal(st.get(id), m, JSON.stringify(id.slice(0, 20)))
    st.update(id, { turns: 1 })
    assert.equal(st.get(id).turns, 1)
  }
  assert.throws(() => st.ensure(''))
  assert.equal({}.turns, undefined); assert.equal(Object.prototype.turns, undefined)
  const ids = new Set(st.list().map(m => m.jiuwenSessionId))
  assert.equal(ids.size, st.list().length, 'distinct Jiuwen ids')
  st.remove('__proto__'); assert.equal(st.get('__proto__'), undefined); assert.ok(st.get('constructor'))
})

test('fuzz: null / primitive frames before connection.ack and in RPC replies are ignored', async () => {
  const port = 21000 + Math.floor(Math.random() * 8000)
  const wss = await WebSocketServer({ port, host: '127.0.0.1' })
  const unhandled = []; const onU = e => unhandled.push(e); process.on('uncaughtException', onU)
  wss.on('connection', (ws) => {
    ws.on('error', () => {})
    for (const j of ['null', '7', '"x"', 'not json']) ws.send(j) // before ack
    ws.send(JSON.stringify({ type: 'event', event: 'connection.ack', payload: {} }))
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw))
      for (const j of ['null', 'false', '[]', '{"type":"res","id":"other","ok":true}']) ws.send(j)
      ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true, payload: { sessions: [] } }))
    })
  })
  try {
    const t = transport(`ws://127.0.0.1:${port}/ws`)
    assert.deepEqual(await t.rpc('session.list', {}), { sessions: [] })
    await sleep(50)
    assert.deepEqual(unhandled, [])
  } finally { process.off('uncaughtException', onU); await wss.close?.() }
})
