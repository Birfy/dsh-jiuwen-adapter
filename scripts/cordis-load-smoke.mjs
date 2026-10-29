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
import { flybotPaths } from '../src/compat/flybot.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Generic: resolve cordis/dsh-llm from DSH_LLM_PATH / DSH_CORDIS_PATH, then node resolution,
// then (optional compat) a FlyBot checkout.
const FB = flybotPaths()
const LLM_PATH = process.env.DSH_LLM_PATH || FB.llm
const CORDIS_PATH = process.env.DSH_CORDIS_PATH || FB.cordis
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
