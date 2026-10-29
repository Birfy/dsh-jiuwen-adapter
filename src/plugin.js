/**
 * Cordis plugin: registers provider route `jiuwen` on ctx.llm.
 */
import { createRequire } from 'node:module'
import { resolveConfig } from './config.js'
import { Config } from './schema.js'
import { SessionStore } from './session-store.js'
import { createJiuwenAdapter } from './adapter.js'
import { createToolBridge } from './tool-bridge.js'
import { GatewayTransport } from './gateway-transport.js'
import * as flybotCompat from './compat/flybot.js'

export { Config }
export const name = 'llm-jiuwen'
export const inject = ['llm']

export { createJiuwenAdapter as JiuwenLlmAdapter }

const require = createRequire(import.meta.url)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME
    || (typeof ctx.get === 'function' ? ctx.get('path')?.home : undefined)
    || undefined

  let resolved = resolveConfig(config, { dshHome })
  const sessions = new SessionStore(resolved.mappingPath)

  const readConfig = () => {
    resolved = resolveConfig(config, { dshHome })
    return resolved
  }

  const logger = ctx.logger ?? console
  const LlmAdapter = loadLlmAdapter(logger, resolved)

  const AdapterClass = createJiuwenAdapter(LlmAdapter, {
    config: readConfig,
    sessions,
    logger,
  })
  const adapter = new AdapterClass()
  const cfg = readConfig()
  const registration = ctx.llm.registerAdapter([cfg.provider], adapter)

  const bridge = createToolBridge(cfg)
  const gatewayFor = () => {
    const c = readConfig()
    return new GatewayTransport({
      gatewayURL: c.gatewayURL,
      userId: c.userId,
      authToken: c.authToken,
      accessToken: c.accessToken,
      cookie: c.cookie,
      authorization: c.authorization,
      xToken: c.xToken,
      workMode: c.workMode,
      projectDir: c.projectDir,
      requestTimeoutMs: c.requestTimeoutMs,
      surfaceToolEvents: c.surfaceGatewayToolEvents,
    })
  }
  const api = {
    sessions,
    bridge,
    config: readConfig,
    provider: cfg.provider,
    /** Unary E2A helpers (history/models/mcp/memory/files/swarm) — brain stays on Jiuwen. */
    gateway: {
      historyGet: (sid, extra) => gatewayFor().historyGet(sid, extra),
      historyListTurns: (sid, extra) => gatewayFor().historyListTurns(sid, extra),
      sessionMetadata: (sid, extra) => gatewayFor().sessionMetadata(sid, extra),
      modelsList: (extra) => gatewayFor().modelsList(extra),
      mcpList: (filter) => gatewayFor().mcpList(filter),
      memoryList: (sid, extra) => gatewayFor().memoryList(sid, extra),
      memoryStatus: (sid, extra) => gatewayFor().memoryStatus(sid, extra),
      filesList: (sid, extra) => gatewayFor().filesList(sid, extra),
      chatCancel: (sid, extra) => gatewayFor().chatCancel(sid, extra),
      workflows: (sid, action, extra) => gatewayFor().workflows(sid, action, extra),
    },
  }
  if (typeof ctx.provide === 'function') {
    try { ctx.provide('jiuwenAdapter', api) }
    catch {
      try { ctx.set?.('jiuwenAdapter', api) } catch { ctx.jiuwenAdapter = api }
    }
  } else if (typeof ctx.set === 'function') {
    try { ctx.set('jiuwenAdapter', api) } catch { ctx.jiuwenAdapter = api }
  } else {
    ctx.jiuwenAdapter = api
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      yield () => {
        try { registration() } catch { /* already disposed */ }
      }
    }, 'llm-jiuwen')
  } else {
    ctx.on?.('dispose', () => {
      try { registration() } catch { /* ignore */ }
    })
  }

  logger.info?.(`[dsh-jiuwen] registered provider "${cfg.provider}" brain=${cfg.brainOwnership} mode=${cfg.mode} mapping=${cfg.mappingPath}`)
}

/**
 * Resolve the standard `LlmAdapter` base class from @deepseek-ai/dsh-llm.
 * Generic order: explicit module (config.llmAdapterModule / JIUWEN_LLM_ADAPTER_MODULE)
 * → package resolution → common global DSH installs → optional compat candidates
 * (FlyBot only when enabled) → duck-typed base (works with any Cordis `llm` service
 * exposing registerAdapter()).
 */
export function loadLlmAdapter(logger, cfg = {}, env = process.env) {
  const home = env.HOME || ''
  const candidates = [
    ...(cfg.llmAdapterModule ? [cfg.llmAdapterModule] : []),
    '@deepseek-ai/dsh-llm',
    `${home}/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm`,
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
  ]
  if (flybotCompat.isFlybotCompatEnabled(cfg.compat, env)) {
    candidates.push(...flybotCompat.llmAdapterCandidates(env))
  }
  for (const id of candidates) {
    try {
      const mod = require(id)
      if (mod?.LlmAdapter) return mod.LlmAdapter
    } catch {
      // try next
    }
  }
  try {
    const resolved = require.resolve('@deepseek-ai/dsh-llm', {
      paths: [`${home}/.dsh/profiles/web`, '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh'],
    })
    const mod = require(resolved)
    if (mod?.LlmAdapter) return mod.LlmAdapter
  } catch {
    // fall through
  }
  logger.info?.('[dsh-jiuwen] @deepseek-ai/dsh-llm not resolvable; using duck-typed LlmAdapter base')
  return null
}

export default apply
