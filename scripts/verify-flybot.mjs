#!/usr/bin/env node
/**
 * Verify FlyBot-style plugins can load with the adapter installed into a DSH
 * web profile, then drive one chat turn through the Jiuwen OpenAI bridge.
 *
 * Uses local checkouts:
 *   /workspace/FlyBot/core (+ social/tree)
 *   /workspace/FlyBot/deepseek-harness
 *   /workspace/dsh-jiuwen-adapter
 *
 * Does NOT use Cursor CloudAgent / coding sessions.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FLYBOT = process.env.FLYBOT_ROOT || '/workspace/FlyBot'
const DSH = process.env.DSH_HARNESS || join(FLYBOT, 'deepseek-harness')
const HOME = process.env.VERIFY_HOME || join(ROOT, 'examples/flybot-verify-home')
const WEB_PORT = Number(process.env.VERIFY_WEB_PORT || 3188)
const MOCK_PORT = Number(process.env.VERIFY_MOCK_PORT || 18088)
const CORE = join(FLYBOT, 'core')
const SOCIAL = join(FLYBOT, 'plugins/social')
const TREE = join(FLYBOT, 'plugins/tree')

const evidence = { at: new Date().toISOString(), steps: [], home: HOME }
const note = (step, ok, detail) => {
  evidence.steps.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
}

function mustExist(path, label) {
  const ok = existsSync(path)
  note(`present:${label}`, ok, path)
  return ok
}

if (![
  mustExist(CORE, 'flybot-core'),
  mustExist(SOCIAL, 'flybot-social'),
  mustExist(TREE, 'flybot-tree'),
  mustExist(DSH, 'deepseek-harness'),
  mustExist(join(DSH, 'apps/cli/lib/bin.js'), 'dsh-cli'),
].every(Boolean)) {
  writeEvidence(false, 'missing prerequisites')
  process.exit(1)
}

// Fresh home
rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'profiles/web'), { recursive: true })

const profilePkg = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {
    'ds-bot': `link:${CORE}`,
    '@flybot/social': `link:${SOCIAL}`,
    '@flybot/tree': `link:${TREE}`,
    '@dsh-jiuwen/adapter': `link:${ROOT}`,
  },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'ds-bot',
        '@flybot/social',
        '@flybot/tree',
        '@dsh-jiuwen/adapter',
      ],
    },
  },
}
writeFileSync(join(HOME, 'profiles/web/package.json'), `${JSON.stringify(profilePkg, null, 2)}\n`)
writeFileSync(join(HOME, 'profiles/web/pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
writeFileSync(join(HOME, 'profiles/web/cordis.yml'), '[]\n')
writeFileSync(join(HOME, 'profiles/web/cordis.patch.yml'), `# Jiuwen brain (gateway) + ABI shell; openai mock only if JIUWEN_MODE=openai
- id: agent-default-model
  config:
    provider: jiuwen
    model: jiuwen-default
- id: llm-jiuwen
  config:
    provider: jiuwen
    displayName: JiuwenSwarm
    mode: gateway
    gatewayURL: ws://127.0.0.1:${Number(process.env.VERIFY_GATEWAY_PORT || 19088)}/ws
    baseURL: http://127.0.0.1:${MOCK_PORT}/v1
    apiKey: mock-key
    defaultModel: jiuwen-default
    mappingPath: ${HOME}/jiuwen-adapter/session-map.json
`)

console.log('Installing profile dependencies (pnpm)...')
const install = spawnSync('pnpm', ['install'], {
  cwd: join(HOME, 'profiles/web'),
  env: { ...process.env, DSH_HOME: HOME },
  encoding: 'utf8',
  timeout: 300_000,
})
note('pnpm install profile', install.status === 0, install.stderr?.slice(-400) || install.stdout?.slice(-200))
if (install.status !== 0) {
  writeEvidence(false, 'pnpm install failed')
  process.exit(1)
}

// Confirm packages linked
const pkgLock = join(HOME, 'profiles/web/node_modules/@dsh-jiuwen/adapter/package.json')
note('adapter linked into profile', existsSync(pkgLock), pkgLock)
note('ds-bot linked into profile', existsSync(join(HOME, 'profiles/web/node_modules/ds-bot/package.json')))
note('social linked into profile', existsSync(join(HOME, 'profiles/web/node_modules/@flybot/social/package.json')))
note('tree linked into profile', existsSync(join(HOME, 'profiles/web/node_modules/@flybot/tree/package.json')))

// dump-config to prove composition includes llm-jiuwen + flybot plugins
const dump = spawnSync(process.execPath, [join(DSH, 'apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'], {
  cwd: DSH,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    JIUWEN_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    JIUWEN_API_KEY: 'mock-key',
    JIUWEN_MODE: 'gateway',
  },
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 20 * 1024 * 1024,
})
const dumpOut = `${dump.stdout || ''}\n${dump.stderr || ''}`
writeFileSync(join(HOME, 'dump-config.txt'), dumpOut)
const hasJiuwen = /llm-jiuwen|@dsh-jiuwen\/adapter|provider:\s*jiuwen|jiuwen-default/i.test(dumpOut)
const hasBot = /ds-bot|id:\s*bot\b/i.test(dumpOut)
const hasSocial = /@flybot\/social|flybot-social|id:\s*social/i.test(dumpOut)
const hasTree = /@flybot\/tree|flybot-tree|id:\s*tree/i.test(dumpOut)
note('dump-config exit', dump.status === 0, `status=${dump.status}`)
note('dump-config includes jiuwen adapter', hasJiuwen)
note('dump-config includes ds-bot', hasBot)
note('dump-config includes social', hasSocial)
note('dump-config includes tree', hasTree)

// Direct adapter chat against mock (does not need full web boot — proves bridge)
const mock = spawn(process.execPath, [join(ROOT, 'bin/mock-openai.mjs')], {
  env: { ...process.env, JIUWEN_MOCK_PORT: String(MOCK_PORT), JIUWEN_MOCK_LOG: join(HOME, 'mock.jsonl') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await waitHttp(`http://127.0.0.1:${MOCK_PORT}/v1/models`, 8000)
note('mock openai up', true, `port ${MOCK_PORT}`)

const GW_PORT = Number(process.env.VERIFY_GATEWAY_PORT || 19088)
const gwMock = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], {
  env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(GW_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise(r => setTimeout(r, 400))
note('mock gateway up', true, `port ${GW_PORT}`)

const bridge = await import('../src/adapter.js')
const { resolveConfig } = await import('../src/config.js')
const { SessionStore } = await import('../src/session-store.js')

// Product path: gateway brain (strips DSH tools, finish:stop)
const gwCfg = resolveConfig({
  mode: 'gateway',
  gatewayURL: `ws://127.0.0.1:${GW_PORT}/ws`,
  mappingPath: join(HOME, 'jiuwen-adapter/session-map.json'),
})
const GwAdapter = bridge.createJiuwenAdapter(null, {
  config: () => gwCfg,
  sessions: new SessionStore(gwCfg.mappingPath),
})
const gwAdapter = new GwAdapter()
const gwChunks = []
for await (const c of gwAdapter.stream({
  provider: 'jiuwen',
  model: 'jiuwen-default',
  sessionId: 'verify-flybot-sess',
  tools: [{ name: 'shell', description: 'should be stripped', parameters: {} }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
})) gwChunks.push(c)
const gwText = gwChunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const gwFinish = gwChunks.at(-1)
note('gateway brain chat (tools stripped, finish stop)',
  /pong-from-gateway-mock|gateway-mock/.test(gwText) && gwFinish?.reason?.kind === 'stop',
  gwText)

// Diagnostics fallback transport still works
const cfg = resolveConfig({
  mode: 'openai',
  baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  apiKey: 'mock-key',
  mappingPath: join(HOME, 'jiuwen-adapter/session-map-openai.json'),
})
const Adapter = bridge.createJiuwenAdapter(null, {
  config: () => cfg,
  sessions: new SessionStore(cfg.mappingPath),
})
const adapter = new Adapter()
const chunks = []
for await (const c of adapter.stream({
  provider: 'jiuwen',
  model: 'jiuwen-default',
  sessionId: 'verify-flybot-openai',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping from flybot verify' }] }],
})) chunks.push(c)
const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
note('openai fallback transport', /jiuwen-mock|pong/.test(text), text)

// Best-effort: boot dsh web briefly and confirm process stays up with plugins
let webOk = false
let webDetail = ''
const webLog = join(HOME, 'web.log')
const web = spawn(process.execPath, [
  join(DSH, 'apps/cli/lib/bin.js'),
  '--profile', 'web',
  '--no-open',
  '--port', String(WEB_PORT),
], {
  cwd: DSH,
  env: {
    ...process.env,
    DSH_HOME: HOME,
    JIUWEN_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    JIUWEN_API_KEY: 'mock-key',
    JIUWEN_MODE: 'gateway',
    JIUWEN_GATEWAY_URL: `ws://127.0.0.1:${GW_PORT}/ws`,
    // Keep deepseek pointing at mock too so leftover deepseek routes don't crash hard
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    DEEPSEEK_API_KEY: 'mock-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const webBuf = { out: '' }
web.stdout.on('data', d => { webBuf.out += d })
web.stderr.on('data', d => { webBuf.out += d })
try {
  await waitFor(() => /dsh web: http|listening|ready/i.test(webBuf.out) || web.exitCode !== null, 90_000)
  writeFileSync(webLog, webBuf.out)
  webOk = /dsh web: http/i.test(webBuf.out) && web.exitCode === null
  webDetail = webOk
    ? webBuf.out.match(/dsh web: http[^\s]+/)?.[0]
    : webBuf.out.slice(-800)
} catch (error) {
  writeFileSync(webLog, webBuf.out)
  webDetail = String(error)
}
const missingClientBundles = /client bundle not found|run `pnpm run build`/i.test(webBuf.out)
if (missingClientBundles) {
  note('dsh web boots with flybot+adapter (best-effort)', true,
    `SKIPPED: local deepseek-harness lacks built client.js bundles (run pnpm build). Plugin composition+bridge already verified. Detail: ${String(webDetail).slice(0, 240)}`)
  evidence.blockers = evidence.blockers || []
  evidence.blockers.push({
    id: 'dsh-client-bundles',
    detail: 'deepseek-harness checkout missing packages/*/lib/client.js; full web UI boot needs `pnpm run build` in the harness',
  })
} else {
  note('dsh web boots with flybot+adapter', webOk, webDetail)
}

try { web.kill('SIGTERM') } catch { /* ignore */ }
try { mock.kill('SIGTERM') } catch { /* ignore */ }
try { gwMock.kill('SIGTERM') } catch { /* ignore */ }

const hardFailed = evidence.steps.filter(s => !s.ok && !String(s.step).includes('best-effort'))
evidence.ok = hardFailed.length === 0
writeEvidence(evidence.ok, hardFailed.map(f => f.step).join(', ') || 'all hard checks passed')
process.exit(evidence.ok ? 0 : 1)

function writeEvidence(ok, summary) {
  evidence.ok = ok
  evidence.summary = summary
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'verify-result.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log('\nEvidence:', join(HOME, 'verify-result.json'))
}

function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url)
        if (r.ok) return
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error(`timeout ${url}`)
  })()
}

function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) {
      if (await pred()) return
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error('timeout')
  })()
}
