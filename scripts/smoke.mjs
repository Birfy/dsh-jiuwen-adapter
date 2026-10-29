#!/usr/bin/env node
/**
 * Best-effort smoke: start mock OpenAI (+ optional gateway), stream one turn
 * through JiuwenLlmAdapter, assert reply, print evidence.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiuwenAdapter } from '../src/adapter.js'
import { SessionStore } from '../src/session-store.js'
import { resolveConfig } from '../src/config.js'
import { GatewayTransport } from '../src/gateway-transport.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = process.env.SMOKE_OUT || join(ROOT, 'examples/smoke-home')
mkdirSync(OUT, { recursive: true })

const openaiPort = Number(process.env.JIUWEN_MOCK_PORT || 18081)
const gatewayPort = Number(process.env.JIUWEN_GATEWAY_MOCK_PORT || 19081)
const results = { at: new Date().toISOString(), steps: [] }

function note(step, ok, detail) {
  results.steps.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
}

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child._buf = ''
  child.stdout.on('data', d => { child._buf += d; process.stdout.write(d) })
  child.stderr.on('data', d => { child._buf += d; process.stderr.write(d) })
  return child
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`timeout waiting for ${label}`)
}

const children = []
try {
  const openai = start(process.execPath, [join(ROOT, 'bin/mock-openai.mjs')], {
    JIUWEN_MOCK_PORT: String(openaiPort),
    JIUWEN_MOCK_LOG: join(OUT, 'mock-openai.jsonl'),
  })
  children.push(openai)
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${openaiPort}/v1/models`)
      return r.ok
    } catch { return false }
  }, 5000, 'mock-openai')

  const gateway = start(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], {
    JIUWEN_GATEWAY_MOCK_PORT: String(gatewayPort),
  })
  children.push(gateway)
  await new Promise(r => setTimeout(r, 400))

  // --- gateway mode (product brain) ---
  {
    const cfg = resolveConfig({
      mode: 'openai',
      baseURL: `http://127.0.0.1:${openaiPort}/v1`,
      mappingPath: join(OUT, 'session-map.json'),
      apiKey: 'mock',
    })
    const Adapter = createJiuwenAdapter(null, {
      config: () => cfg,
      sessions: new SessionStore(cfg.mappingPath),
      logger: console,
    })
    const adapter = new Adapter()
    const chunks = []
    for await (const c of adapter.stream({
      provider: 'jiuwen',
      model: 'jiuwen-default',
      sessionId: 'smoke-sess-openai',
      messages: [{ role: 'user', content: 'ping' }],
    })) chunks.push(c)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    const ok = /pong-from-jiuwen-mock/.test(text) && chunks.at(-1)?.type === 'finish'
    note('openai-fallback stream', ok, text)
  }

  // --- gateway mode ---
  {
    const transport = new GatewayTransport({
      gatewayURL: `ws://127.0.0.1:${gatewayPort}/ws`,
      userId: 'smoke',
      requestTimeoutMs: 10_000,
    })
    const chunks = []
    for await (const c of transport.stream(
      { provider: 'jiuwen', model: 'jiuwen-default', messages: [{ role: 'user', content: 'ping' }] },
      { jiuwenSessionId: 'smoke-gw-1' },
    )) chunks.push(c)
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    const ok = /pong-from-gateway-mock/.test(text) && chunks.at(-1)?.type === 'finish'
    note('gateway-brain stream', ok, text)
  }

  // --- session map ---
  {
    const store = new SessionStore(join(OUT, 'session-map.json'))
    const hit = store.get('smoke-sess-openai')
    note('session mapping persisted', !!hit?.jiuwenSessionId, hit?.jiuwenSessionId)
  }

  const failed = results.steps.filter(s => !s.ok)
  results.ok = failed.length === 0
  writeFileSync(join(OUT, 'smoke-result.json'), `${JSON.stringify(results, null, 2)}\n`)
  if (!results.ok) {
    console.error(`\nSmoke failed: ${failed.map(f => f.step).join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('\nSmoke OK — evidence in', OUT)
  }
} catch (error) {
  console.error(error)
  results.ok = false
  results.error = String(error)
  writeFileSync(join(OUT, 'smoke-result.json'), `${JSON.stringify(results, null, 2)}\n`)
  process.exitCode = 1
} finally {
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
  }
}
