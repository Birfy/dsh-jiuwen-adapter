import { appendFileSync } from 'node:fs'
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
  if (process.env.JIUWEN_TRACE_FILE) {
    try { appendFileSync(process.env.JIUWEN_TRACE_FILE, `${JSON.stringify({ t: new Date().toISOString(), up: Math.round(performance.now()), at: 'plugin-apply' })}\n`) } catch { /* ignore */ }
  }
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

  const listeners = new Set()
  const onEvent = (e) => {
    for (const fn of listeners) { try { fn(e) } catch { /* ignore */ } }
    try { ctx.emit?.('jiuwen/event', e) } catch { /* host may not declare the event */ }
  }
  const AdapterClass = createJiuwenAdapter(LlmAdapter, {
    config: readConfig,
    sessions,
    logger,
    onEvent,
    // Optional host attachment store (generic Cordis service name `attachments`).
    attachments: () => {
      try { return (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined) ?? ctx.attachments } catch { return undefined }
    },
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
  /** Accept a host session id (mapped) or a raw Jiuwen session id. */
  const jw = (sid) => sessions.get(String(sid))?.jiuwenSessionId || sid
  const api = {
    sessions,
    bridge,
    config: readConfig,
    provider: cfg.provider,
    /** Subscribe to structured Jiuwen events ({type, name, ...}); returns unsubscribe. */
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    /** Jiuwen session id for a host session id (creates mapping). */
    jiuwenSessionId: (sid) => sessions.ensure(String(sid)).jiuwenSessionId,
    /** Unary E2A helpers (history/models/mcp/memory/files/swarm) — brain stays on Jiuwen. */
    gateway: {
      rpc: (method, params, opts) => gatewayFor().rpc(method, params, opts),
      historyGet: (sid, extra) => gatewayFor().historyGet(jw(sid), extra),
      historyListTurns: (sid, extra) => gatewayFor().historyListTurns(jw(sid), extra),
      sessionMetadata: (sid, extra) => gatewayFor().sessionMetadata(jw(sid), extra),
      sessionList: (extra) => gatewayFor().sessionList(extra),
      sessionCreate: (extra) => gatewayFor().sessionCreate(extra),
      sessionDelete: (sid, extra) => gatewayFor().sessionDelete(jw(sid), extra),
      sessionFork: (sid, extra) => gatewayFor().sessionFork(jw(sid), extra),
      skillsList: (extra) => gatewayFor().skillsList(extra),
      agentsList: (extra) => gatewayFor().agentsList(extra),
      teamTemplatesList: (extra) => gatewayFor().teamTemplatesList(extra),
      commandsList: (extra) => gatewayFor().commandsList(extra),
      compact: (sid, extra) => gatewayFor().compact(jw(sid), extra),
      interrupt: (sid, intent, extra) => gatewayFor().chatInterrupt(jw(sid), intent, extra),
      userAnswer: (sid, answers, extra) => gatewayFor().userAnswer(jw(sid), answers, {
        ...(sessions.get(String(sid))?.pendingQuestion?.requestId ? { request_id: sessions.get(String(sid)).pendingQuestion.requestId } : {}),
        ...extra,
      }),
      chatResume: (sid, extra) => gatewayFor().chatResume(jw(sid), extra),
      modelsList: (extra) => gatewayFor().modelsList(extra),
      mcpList: (filter) => gatewayFor().mcpList(filter),
      memoryList: (sid, extra) => gatewayFor().memoryList(jw(sid), extra),
      memoryStatus: (sid, extra) => gatewayFor().memoryStatus(jw(sid), extra),
      filesList: (sid, extra) => gatewayFor().filesList(jw(sid), extra),
      chatCancel: (sid, extra) => gatewayFor().chatInterrupt(jw(sid), 'cancel', extra),
      workflows: (sid, action, extra) => gatewayFor().workflows(jw(sid), action, extra),
    },
  }
  exposeService(ctx, cfg.serviceName, api, logger)

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
 * → package resolution → common global DSH installs → built-in duck-typed base (works with any Cordis `llm` service
 * exposing registerAdapter()).
 */
export /** Expose the helper API on ctx under `serviceName` (generic across Cordis versions). */
function exposeService(ctx, serviceName, api, logger) {
  const attempts = [
    () => ctx.provide?.(serviceName, api),
    () => ctx.set?.(serviceName, api),
    () => { ctx[serviceName] = api },
  ]
  for (const attempt of attempts) {
    try {
      attempt()
      if (ctx[serviceName] === api || typeof ctx.provide === 'function') return
    } catch { /* try next */ }
  }
  logger.warn?.(`[dsh-jiuwen] could not expose ctx.${serviceName} (another instance owns it?); set config.serviceName to a unique name`)
}

function loadLlmAdapter(logger, cfg = {}, env = process.env) {
  const home = env.HOME || ''
  const candidates = [
    ...(cfg.llmAdapterModule ? [cfg.llmAdapterModule] : []),
    '@deepseek-ai/dsh-llm',
    `${home}/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-llm`,
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm',
  ]
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
