import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAiTransport } from '../src/openai-transport.js'

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}/v1`)
  } finally {
    await new Promise(r => server.close(r))
  }
}

test('openai transport streams SSE text to finish', async () => {
  await withServer((req, res) => {
    assert.equal(req.method, 'POST')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  }, async (baseURL) => {
    const t = new OpenAiTransport({ baseURL, apiKey: 'k' })
    const chunks = []
    for await (const c of t.stream({
      provider: 'jiuwen',
      model: 'jiuwen-default',
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(c)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, 'hello')
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'stop')
  })
})

test('openai transport surfaces HTTP auth errors', async () => {
  await withServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'nope' }))
  }, async (baseURL) => {
    const t = new OpenAiTransport({ baseURL })
    const chunks = []
    for await (const c of t.stream({
      provider: 'jiuwen',
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    })) chunks.push(c)
    assert.equal(chunks.at(-1).reason.kind, 'error')
    assert.equal(chunks.at(-1).reason.failure.code, 'AUTH')
  })
})
