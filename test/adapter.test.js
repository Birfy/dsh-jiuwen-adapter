import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJiuwenAdapter } from '../src/adapter.js'
import { SessionStore } from '../src/session-store.js'
import { resolveConfig } from '../src/config.js'

test('adapter openai mode end-to-end against mock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jiuwen-ad-'))
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'adapter-ok' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const cfg = resolveConfig({
      mode: 'openai',
      baseURL: `http://127.0.0.1:${port}/v1`,
      mappingPath: join(dir, 'map.json'),
      models: [{ id: 'jiuwen-default', name: 'Jiuwen Default' }],
    })
    const Adapter = createJiuwenAdapter(null, {
      config: () => cfg,
      sessions: new SessionStore(cfg.mappingPath),
    })
    const adapter = new Adapter()
    const models = await adapter.listModels('jiuwen')
    assert.equal(models[0].id, 'jiuwen-default')
    const chunks = []
    for await (const c of adapter.stream({
      provider: 'jiuwen',
      model: 'jiuwen-default',
      sessionId: 'host-sess-1',
      messages: [{ role: 'user', content: 'ping' }],
    })) chunks.push(c)
    assert.match(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), /adapter-ok/)
    assert.ok(adapter.providerInfo('jiuwen').name)
  } finally {
    await new Promise(r => server.close(r))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveConfig prefers env over raw', () => {
  const cfg = resolveConfig(
    { mode: 'openai', baseURL: 'http://raw' },
    { env: { JIUWEN_MODE: 'gateway', JIUWEN_GATEWAY_URL: 'ws://env/ws', DSH_HOME: '/tmp/dshx' } },
  )
  assert.equal(cfg.mode, 'gateway')
  assert.equal(cfg.gatewayURL, 'ws://env/ws')
  assert.match(cfg.mappingPath, /jiuwen-adapter/)
})

test('default mode is gateway (Jiuwen brain)', () => {
  const cfg = resolveConfig({}, { env: { DSH_HOME: '/tmp/dshx' } })
  assert.equal(cfg.mode, 'gateway')
  assert.equal(cfg.brainOwnership, 'jiuwen')
  assert.equal(cfg.allowDshAgentLoop, false)
})
