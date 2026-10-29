/**
 * Generic usage proof: a minimal NON-FlyBot host implementing only the standard
 * Cordis `llm` service surface (registerAdapter/listModels/stream) consumes the
 * `jiuwen` provider via plugin.apply(). No dsh-llm, no FlyBot paths (compat=none).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'
import { isFlybotCompatEnabled } from '../src/compat/flybot.js'
import { resolveConfig } from '../src/config.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GW_PORT = 19000 + 100 + Math.floor(Math.random() * 800)
let gw, dir

function minimalHost() {
  const adapters = new Map()
  const disposers = []
  const llm = {
    registerAdapter(ids, adapter) {
      for (const id of ids) adapters.set(id, adapter)
      return () => ids.forEach(id => adapters.delete(id))
    },
    listProviders: () => [...adapters.keys()].map(id => adapters.get(id).providerInfo(id)),
    listModels: p => adapters.get(p).listModels(p),
    async *stream(o) {
      const a = adapters.get(o.provider)
      const call = await a.prepareCall(o.provider, o.model)
      yield *call.stream(o)
    },
  }
  const ctx = {
    llm,
    logger: { info() {}, warn() {}, error() {} },
    services: {},
    provide(n, v) { this.services[n] = v },
    on(ev, fn) { if (ev === 'dispose') disposers.push(fn) },
    dispose() { disposers.forEach(f => f()) },
  }
  return ctx
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jw-generic-'))
  gw = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], {
    env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(GW_PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((res, rej) => {
    gw.stdout.on('data', d => { if (/listening/.test(String(d))) res() })
    gw.on('exit', c => rej(new Error(`mock-gateway exited ${c}`)))
  })
})
after(() => { gw?.kill(); rmSync(dir, { recursive: true, force: true }) })

const text = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')

test('compat=none disables FlyBot glue; config has no flybot keys', () => {
  assert.equal(isFlybotCompatEnabled('none', {}), false)
  assert.equal(isFlybotCompatEnabled('auto', { FLYBOT_ROOT: '/nonexistent' }), false)
  assert.equal(isFlybotCompatEnabled('flybot', {}), true)
  const keys = Object.keys(resolveConfig({}, { env: {} }))
  assert.ok(!keys.some(k => /flybot/i.test(k)))
})

test('generic host: plain chat + streaming via gateway mock', async () => {
  const ctx = minimalHost()
  plugin.apply(ctx, { compat: 'none', gatewayURL: `ws://127.0.0.1:${GW_PORT}/ws`, mappingPath: join(dir, 'm.json') })
  assert.deepEqual(ctx.llm.listProviders().map(p => p.id), ['jiuwen'])
  assert.ok((await ctx.llm.listModels('jiuwen')).some(m => m.id === 'jiuwen-default'))
  const chunks = []
  for await (const c of ctx.llm.stream({
    provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'generic-1',
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'ping' }],
  })) chunks.push(c)
  assert.ok(chunks.filter(c => c.type === 'text-delta').length >= 2, 'multiple stream deltas')
  assert.match(text(chunks), /pong-from-gateway-mock/)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.ok(ctx.services.jiuwenAdapter.gateway)
  const models = await ctx.services.jiuwenAdapter.gateway.modelsList()
  assert.ok(JSON.stringify(models).includes('jiuwen-default'))
  ctx.dispose()
  assert.equal(ctx.llm.listProviders().length, 0)
})

test('generic host: OpenAI-style tools in gateway mode are Jiuwen-owned (observed, not re-executed)', async () => {
  const ctx = minimalHost()
  plugin.apply(ctx, { compat: 'none', gatewayURL: `ws://127.0.0.1:${GW_PORT}/ws`, mappingPath: join(dir, 'm2.json') })
  const chunks = []
  for await (const c of ctx.llm.stream({
    provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'generic-2',
    messages: [{ role: 'user', content: 'list files' }],
    tools: [{ name: 'shell', description: 'run', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(c)
  assert.ok(!chunks.some(c => c.type === 'tool-call-delta'))
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  assert.match(reasoning, /🔧 bash/)
  assert.doesNotMatch(text(chunks), /jiuwen-tool/)
  assert.equal(chunks.at(-1).reason?.kind, 'stop')
})

test('generic host: openai mode with allowDshAgentLoop surfaces OpenAI tool_calls', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const j = JSON.parse(body || '{}')
      assert.equal(j.tools?.[0]?.type, 'function')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }] } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      res.write('data: [DONE]\n\n'); res.end()
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const ctx = minimalHost()
    plugin.apply(ctx, {
      compat: 'none', mode: 'openai', allowDshAgentLoop: true,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, mappingPath: join(dir, 'm3.json'),
    })
    const chunks = []
    for await (const c of ctx.llm.stream({
      provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'generic-3',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    })) chunks.push(c)
    const tc = chunks.find(c => c.type === 'tool-call-delta')
    assert.equal(tc?.name, 'get_weather')
    assert.equal(chunks.at(-1).reason?.kind, 'tool-calls')
  } finally { await new Promise(r => server.close(r)) }
})
