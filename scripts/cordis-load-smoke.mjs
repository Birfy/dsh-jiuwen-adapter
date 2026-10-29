#!/usr/bin/env node
/**
 * Minimal Cordis load: Context + LlmRuntime + llm-jiuwen plugin.
 * Proves apply() registers the provider without booting full dsh web.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Resolve cordis + dsh-llm: DSH_CORDIS_PATH / DSH_LLM_PATH, then node resolution, then a global
// `npm i -g @deepseek-ai/dsh` install (its bundled node_modules).
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
const globalRoot = (() => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim() } catch { return '' } })()
const DSH_NM = process.env.DSH_NODE_MODULES || join(globalRoot, '@deepseek-ai/dsh/node_modules')
const LLM_PATH = process.env.DSH_LLM_PATH || join(DSH_NM, '@deepseek-ai/dsh-llm/lib/index.js')
const CORDIS_PATH = process.env.DSH_CORDIS_PATH || join(DSH_NM, '@deepseek-ai/cordis/lib/index.js')
if (!existsSync(LLM_PATH) && !process.env.DSH_LLM_PATH) console.log(`note: ${LLM_PATH} not found; set DSH_NODE_MODULES or DSH_LLM_PATH`)
const require = createRequire(join(ROOT, 'package.json'))

const out = { at: new Date().toISOString(), steps: [] }
const note = (step, ok, detail) => {
  out.steps.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'jiuwen-cordis-'))
const mockPort = 18089

try {
  // Start tiny openai mock
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'jiuwen-default' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'cordis-pong' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise(r => server.listen(mockPort, '127.0.0.1', r))

  let Context, LlmRuntime
  try {
    ;({ Context } = require('@deepseek-ai/cordis'))
    ;({ default: LlmRuntime } = require('@deepseek-ai/dsh-llm'))
  } catch (error) {
    // Path imports
    const cordis = await import(pathToFileURL(CORDIS_PATH).href)
    Context = cordis.Context
    const llm = await import(pathToFileURL(LLM_PATH).href)
    LlmRuntime = llm.default || llm.LlmRuntime
    note('import cordis+llm via path', !!(Context && LlmRuntime), error?.message)
  }
  if (!Context || !LlmRuntime) {
    // try path only
    const cordis = await import(pathToFileURL(CORDIS_PATH).href)
    Context = cordis.Context
    const llm = await import(pathToFileURL(LLM_PATH).href)
    LlmRuntime = llm.default
  }
  note('Context+LlmRuntime loaded', !!(Context && LlmRuntime))

  const ctx = new Context()
  // Provide llm service the same way DSH does: plugin the runtime class
  if (typeof ctx.plugin === 'function') {
    await ctx.plugin(LlmRuntime)
  } else {
    // Fallback: construct and assign
    const runtime = new LlmRuntime(ctx)
    ctx.llm = runtime
    ctx.provide?.('llm', runtime)
  }
  note('llm service present', !!ctx.llm)

  const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  note('Config has ~standard', !!plugin.Config?.['~standard']?.validate)

  await ctx.plugin(plugin, {
    provider: 'jiuwen',
    mode: 'openai',
    baseURL: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: 'mock',
    mappingPath: join(dir, 'map.json'),
    models: [{ id: 'jiuwen-default', name: 'Jiuwen Default' }],
  })

  const providers = ctx.llm.listProviders()
  note('provider jiuwen registered', providers.some(p => p.id === 'jiuwen'), JSON.stringify(providers))

  const models = await ctx.llm.listModels('jiuwen')
  note('listModels', models.some(m => m.id === 'jiuwen-default'), JSON.stringify(models))

  const chunks = []
  for await (const c of ctx.llm.stream({
    provider: 'jiuwen',
    model: 'jiuwen-default',
    sessionId: 'cordis-smoke',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) chunks.push(c)
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  note('llm.stream via cordis', /cordis-pong/.test(text), text)

  // Gateway mode through the real LlmRuntime (validates stream grammar: reasoning + text + usage).
  const { spawn } = await import('node:child_process')
  const gwPort = 19089
  const gw = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], { env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(gwPort) }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(r => gw.stdout.on('data', d => /listening/.test(String(d)) && r()))
  try {
    await ctx.plugin(plugin, {
      provider: 'jiuwen-gw', serviceName: 'jiuwenAdapterGw', mode: 'gateway', finalGraceMs: 300,
      gatewayURL: `ws://127.0.0.1:${gwPort}/ws`, mappingPath: join(dir, 'map-gw.json'),
      models: [{ id: 'jiuwen-default', name: 'Jiuwen Default' }],
    })
    const gwChunks = []
    for await (const c of ctx.llm.stream({
      provider: 'jiuwen-gw', model: 'jiuwen-default', sessionId: 'cordis-gw',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) gwChunks.push(c)
    const gwText = gwChunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    const gwReasoning = gwChunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
    const fin = gwChunks.at(-1)
    note('gateway stream via real LlmRuntime (grammar ok)', /pong-from-gateway-mock/.test(gwText) && /🔧 bash/.test(gwReasoning) && fin?.reason?.kind === 'stop',
      `${JSON.stringify(fin?.reason)} usage=${JSON.stringify(gwChunks.find(c => c.type === 'usage')?.usage)}`)
  } finally { gw.kill() }

  server.close()
} catch (error) {
  note('cordis-load-smoke', false, String(error?.stack || error))
  console.error(error)
} finally {
  out.ok = out.steps.every(s => s.ok)
  mkdirSync(join(ROOT, 'examples/smoke-home'), { recursive: true })
  writeFileSync(join(ROOT, 'examples/smoke-home/cordis-load-result.json'), `${JSON.stringify(out, null, 2)}\n`)
  rmSync(dir, { recursive: true, force: true })
  console.log('\nResult ok=', out.ok)
  process.exit(out.ok ? 0 : 1)
}
