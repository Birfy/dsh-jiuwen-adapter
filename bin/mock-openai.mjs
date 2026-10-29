#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible chat.completions mock (SSE + JSON).
 * Simulates a Jiuwen LLM front for adapter smoke tests.
 *
 *   JIUWEN_MOCK_PORT=18080 node bin/mock-openai.mjs
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = Number(process.env.JIUWEN_MOCK_PORT || process.env.MOCK_PORT || 18080)
const LOG = process.env.JIUWEN_MOCK_LOG || ''
if (LOG) mkdirSync(dirname(LOG), { recursive: true })

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'jiuwen-default', object: 'model' },
        { id: 'jiuwen-swarm', object: 'model' },
      ],
    }))
    return
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    const body = await readJson(req)
    log({ path: url.pathname, model: body.model, messages: body.messages?.length, stream: !!body.stream })
    const reply = craftReply(body)
    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const id = `chatcmpl-mock-${Date.now()}`
      for (const piece of chunkText(reply, 24)) {
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${PORT}/v1`)
})

function craftReply(body) {
  const last = [...(body.messages || [])].reverse().find(m => m.role === 'user')
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '')
  if (/ping/i.test(text)) return 'pong-from-jiuwen-mock'
  return `jiuwen-mock: ${text.slice(0, 200)}`
}

function chunkText(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length ? out : ['']
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function log(entry) {
  if (!LOG) return
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}
