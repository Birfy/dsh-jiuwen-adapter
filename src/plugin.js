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
import { createInteractor } from './interaction.js'
import { createMcpBridge } from './mcp-bridge.js'
import { createJiuwenCommand } from './commands.js'
import { createFeatureCache } from './features.js'

export { Config }
export const name = 'llm-jiuwen'
/** Cordis event carrying structured Jiuwen activity (see index.d.ts / docs/dsh-integration.md). */
export const JIUWEN_EVENT = 'jiuwen/event'
/** Typed, namespaced events (opt-in: config.typedEvents). */
export const JIUWEN_TYPED_EVENTS = Object.freeze({ tool: 'jiuwen/tool', plan: 'jiuwen/plan', approval: 'jiuwen/approval', swarm: 'jiuwen/swarm' })
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
    try { ctx.emit?.(JIUWEN_EVENT, e) } catch { /* host may not declare the event */ }
  }
  const service = (name) => { try { return (typeof ctx.get === 'function' ? ctx.get(name) : undefined) ?? ctx[name] } catch { return undefined } }
  const interact = createInteractor({
    config: readConfig,
    logger,
    services: () => ({ userQuestions: service('userQuestions'), approval: service('approval'), agents: service('agents') }),
  })
  const mcpBridge = createMcpBridge({
    config: readConfig,
    logger,
    services: () => ({ tools: service('tools'), approval: service('approval'), agents: service('agents') }),
    rpc: (method, params, opts) => gatewayFor().rpc(method, params, opts),
  })
  const AdapterClass = createJiuwenAdapter(LlmAdapter, {
    interact,
    mcpBridge,
    // `auto` needs a live answerer, not just the service: headless dsh loads ctx.userQuestions but no
    // client listens on `user-questions/request`, so enabling it there only adds Jiuwen's ask_user
    // tool (~920 input tokens/turn) for questions that are always NO_PROVIDER.
    hasUserQuestions: () => Boolean(service('userQuestions')?.ask) && hasQuestionAnswerer(ctx),
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
  const features = createFeatureCache()
  const gatewayFor = () => {
    const c = readConfig()
    const t = new GatewayTransport({
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
    // Every unary helper goes through this.rpc → feature-detect cache (unknown methods fail fast).
    t.rpc = features.wrap(c.gatewayURL, t.rpc.bind(t))
    t.features = features
    return t
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
      /** Probe a Gateway method once (cached): true when /ws routes it. Never throws. */
      supports: (method, params) => { const t = gatewayFor(); return features.probe(readConfig().gatewayURL, (m, p, o) => GatewayTransport.prototype.rpc.call(t, m, p, o), method, params) },
      /** Methods this Gateway answered `unknown method` for (cached). */
      unsupported: () => features.unsupported(readConfig().gatewayURL),
      historyGet: (sid, extra) => gatewayFor().historyGet(jw(sid), extra),
      historyListTurns: (sid, extra) => gatewayFor().historyListTurns(jw(sid), extra),
      sessionMetadata: (sid, extra) => gatewayFor().sessionMetadata(jw(sid), extra),
      sessionList: (extra) => gatewayFor().sessionList(extra),
      sessionCreate: (extra) => gatewayFor().sessionCreate(extra),
      sessionDelete: (sid, extra) => gatewayFor().sessionDelete(jw(sid), extra),
      sessionFork: (sid, extra) => gatewayFor().sessionFork(jw(sid), extra),
      sessionRename: (sid, title, extra) => gatewayFor().sessionRename(jw(sid), title, extra),
      sessionPin: (sid, pinned, extra) => gatewayFor().sessionPin(jw(sid), pinned, extra),
      sessionSwitch: (sid, extra) => gatewayFor().sessionSwitch(jw(sid), extra),
      sessionArchive: (sid, extra) => gatewayFor().sessionArchive(Array.isArray(sid) ? sid.map(jw) : jw(sid), extra),
      sessionUnarchive: (sid, extra) => gatewayFor().sessionUnarchive(Array.isArray(sid) ? sid.map(jw) : jw(sid), extra),
      skillsList: (extra) => gatewayFor().skillsList(extra),
      skillsInstalled: (extra) => gatewayFor().skillsInstalled(extra),
      skillsToggle: (name, enabled, extra) => gatewayFor().skillsToggle(name, enabled, extra),
      agentsList: (extra) => gatewayFor().agentsList(extra),
      teamTemplatesList: (extra) => gatewayFor().teamTemplatesList(extra),
      teamList: (extra) => gatewayFor().teamList(extra),
      agentsToolsList: (...args) => gatewayFor().agentsToolsList(...args),
      hooksList: (...args) => gatewayFor().hooksList(...args),
      permissionsToolsGet: (...args) => gatewayFor().permissionsToolsGet(...args),
      permissionsToolsUpdate: (tool, level, extra) => gatewayFor().permissionsToolsUpdate(tool, level, extra),
      permissionsToolsDelete: (tool, extra) => gatewayFor().permissionsToolsDelete(tool, extra),
      permissionsRulesGet: (...args) => gatewayFor().permissionsRulesGet(...args),
      pluginsList: (...args) => gatewayFor().pluginsList(...args),
      pluginsEnable: (name, extra) => gatewayFor().pluginsEnable(name, extra),
      pluginsDisable: (name, extra) => gatewayFor().pluginsDisable(name, extra),
      projectList: (...args) => gatewayFor().projectList(...args),
      projectInfo: (projectId, extra) => gatewayFor().projectInfo(projectId, extra),
      projectGetSessions: (projectId, extra) => gatewayFor().projectGetSessions(projectId, extra),
      sessionArchivedList: (...args) => gatewayFor().sessionArchivedList(...args),
      sessionAssetsList: (...args) => gatewayFor().sessionAssetsList(...args),
      updaterStatus: (...args) => gatewayFor().updaterStatus(...args),
      heartbeatConf: (...args) => gatewayFor().heartbeatConf(...args),
      heartbeatSetConf: (conf, extra) => gatewayFor().heartbeatSetConf(conf, extra),
      heartbeatJobList: (...args) => gatewayFor().heartbeatJobList(...args),
      pathGet: (...args) => gatewayFor().pathGet(...args),
      localeGetConf: (...args) => gatewayFor().localeGetConf(...args),
      cronJobList: (...args) => gatewayFor().cronJobList(...args),
      agentTemplatesList: (...args) => gatewayFor().agentTemplatesList(...args),
      commandsList: (extra) => gatewayFor().commandsList(extra),
      compact: (sid, extra) => gatewayFor().compact(jw(sid), extra),
      goal: (sid, opts) => gatewayFor().goal(jw(sid), opts),
      btw: (sid, question, extra) => gatewayFor().btw(jw(sid), question, extra),
      recap: (sid, extra) => gatewayFor().recap(jw(sid), extra),
      planStatus: (sid, extra) => gatewayFor().planStatus(jw(sid), extra),
      interrupt: (sid, intent, extra) => gatewayFor().chatInterrupt(jw(sid), intent, extra),
      userAnswer: (sid, answers, extra) => gatewayFor().userAnswer(jw(sid), answers, {
        ...(sessions.get(String(sid))?.pendingQuestion?.requestId ? { request_id: sessions.get(String(sid)).pendingQuestion.requestId } : {}),
        ...extra,
      }),
      chatResume: (sid, extra) => gatewayFor().chatResume(jw(sid), extra),
      modelsList: (extra) => gatewayFor().modelsList(extra),
      modelsGet: (modelId, extra) => gatewayFor().modelsGet(modelId, extra),
      mcpList: (filter) => gatewayFor().mcpList(filter),
      memoryList: (sid, extra) => gatewayFor().memoryList(jw(sid), extra),
      memoryStatus: (sid, extra) => gatewayFor().memoryStatus(jw(sid), extra),
      filesList: (sid, extra) => gatewayFor().filesList(jw(sid), extra),
      chatCancel: (sid, extra) => gatewayFor().chatInterrupt(jw(sid), 'cancel', extra),
      workflows: (sid, action, extra) => gatewayFor().workflows(jw(sid), action, extra),
    },
  }
  exposeService(ctx, cfg.serviceName, api, logger)

  // `/jiuwen <sub>` slash command when the host has a command registry (dsh-commands).
  const command = createJiuwenCommand({ sessions, gateway: gatewayFor, config: readConfig, mcpBridge, features })
  api.command = command.run
  if (cfg.registerCommands !== false && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['commands'], (c) => {
        // Fail soft inside the inject callback: a duplicate name or a registry error must not
        // break the host fiber (or other plugins sharing it).
        try {
          const dispose = c.commands.register({ ...command.definition, name: cfg.commandName })
          if (typeof dispose === 'function') {
            if (typeof c.effect === 'function') c.effect(function* () { yield () => { try { dispose() } catch { /* ignore */ } } }, 'llm-jiuwen command')
            else c.on?.('dispose', () => { try { dispose() } catch { /* ignore */ } })
          }
        } catch (error) {
          logger.warn?.(`[dsh-jiuwen] could not register /${cfg.commandName} (${error?.message || error}); set config.commandName to a unique name`)
        }
      })
    } catch (error) {
      logger.debug?.(`[dsh-jiuwen] commands registry unavailable: ${error?.message || error}`)
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      yield () => {
        try { registration() } catch { /* already disposed */ }
        mcpBridge.dispose().catch(() => {})
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
  // Only the sanctioned Cordis service API: never assign ctx[serviceName] directly (that could
  // shadow another plugin's service or a Context method).
  if (typeof ctx.provide !== 'function') {
    logger.warn?.(`[dsh-jiuwen] host has no ctx.provide; helper service ctx.${serviceName} not exposed`)
    return false
  }
  try {
    ctx.provide(serviceName, api)
    return true
  } catch (error) {
    logger.warn?.(`[dsh-jiuwen] could not provide ctx.${serviceName} (${error?.message || error}); set config.serviceName to a unique name`)
    return false
  }
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

/** True when some client listens on the `user-questions/request` waterfall (TUI/web remotes);
 *  unknown host internals → true (keep the documented `auto` behaviour). */
export function hasQuestionAnswerer(ctx) {
  try {
    const hooks = ctx.root?.events?._hooks
    if (!hooks || typeof hooks !== 'object') return true
    const h = hooks['user-questions/request']
    return Array.isArray(h) ? h.length > 0 : Boolean(h && (h.size ?? Object.keys(h).length))
  } catch { return true }
}
