/**
 * LlmAdapter: DSH Cordis ABI → JiuwenSwarm brain.
 *
 * Product path (mode=gateway): one GenerateOptions turn → Gateway chat.send.
 * Jiuwen owns loop/tools/memory; we only stream assistant text back and finish
 * with stop so DSH agent-loop does not re-execute tools.
 *
 * See ARCHITECTURE.md.
 */

import { OpenAiTransport } from './openai-transport.js'
import { GatewayTransport } from './gateway-transport.js'
import { createToolBridge } from './tool-bridge.js'
import { prepareBrainRequest, callKind } from './agent-brain.js'
import { failureFromError } from './stream-emit.js'

/**
 * @param {typeof import('@deepseek-ai/dsh-llm').LlmAdapter | null} LlmAdapterBase
 * @param {{
 *   config: () => import('./config.js').ResolvedConfig,
 *   sessions: import('./session-store.js').SessionStore,
 *   logger?: { warn: Function, error: Function, info?: Function },
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: typeof WebSocket,
 * }} deps
 */
export function createJiuwenAdapter(LlmAdapterBase, deps) {
  const Base = LlmAdapterBase ?? class {
    providerInfo(provider) { return { id: provider, name: provider } }
    listModels() { return Promise.resolve([]) }
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    prepareCall(provider, model) {
      return Promise.resolve({ model: { provider, id: model, name: model }, stream: o => this.stream(o) })
    }
    /** Required by dsh-llm registerAdapter; undefined => framework defaults. */
    providerRetryPolicy(_provider) {}
    stream() { throw new Error('not implemented') }
  }

  class JiuwenLlmAdapter extends Base {
    constructor() {
      super()
      this._openai = null
      this._gateway = null
    }

    _cfg() {
      return deps.config()
    }

    _openaiTransport() {
      const cfg = this._cfg()
      const key = `${cfg.baseURL}|${cfg.apiKey || ''}`
      if (!this._openai || this._openaiKey !== key) {
        this._openai = new OpenAiTransport({
          baseURL: cfg.baseURL,
          apiKey: cfg.apiKey,
          requestTimeoutMs: cfg.requestTimeoutMs,
          fetchImpl: deps.fetchImpl,
        })
        this._openaiKey = key
      }
      return this._openai
    }

    _gatewayTransport() {
      const cfg = this._cfg()
      const key = `${cfg.gatewayURL}|${cfg.authToken || ''}|${cfg.userId}|${cfg.surfaceGatewayToolEvents}`
      if (!this._gateway || this._gatewayKey !== key) {
        this._gateway = new GatewayTransport({
          gatewayURL: cfg.gatewayURL,
          userId: cfg.userId,
          authToken: cfg.authToken,
          accessToken: cfg.accessToken,
          cookie: cfg.cookie,
          authorization: cfg.authorization,
          xToken: cfg.xToken,
          workMode: cfg.workMode,
          projectDir: cfg.projectDir,
          requestTimeoutMs: cfg.requestTimeoutMs,
          surfaceToolEvents: cfg.surfaceGatewayToolEvents,
          WebSocketImpl: deps.WebSocketImpl,
        })
        this._gatewayKey = key
      }
      return this._gateway
    }

    providerInfo(provider) {
      const cfg = this._cfg()
      return { id: provider, name: cfg.displayName || 'JiuwenSwarm' }
    }

    async listModels(provider) {
      const cfg = this._cfg()
      return cfg.models.map(m => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: ['text'],
      }))
    }

    resolveModel(provider, model) {
      const cfg = this._cfg()
      const hit = cfg.models.find(m => m.id === model)
      return Promise.resolve({
        provider,
        id: model,
        name: hit?.name || model,
        inputModalities: ['text'],
        ...(hit?.contextWindow ? { context: { contextWindow: hit.contextWindow } } : {}),
        ...(hit?.maxTokens ? { defaultMaxTokens: hit.maxTokens } : {}),
        // Gateway brain owns mid-turn tool changes; DSH must not project tool updates.
        systemPromptUpdate: 'in-history',
        toolUpdate: 'in-history',
      })
    }

    prepareCall(provider, model, _signal) {
      return this.resolveModel(provider, model).then(info => ({
        model: info,
        stream: options => this.stream(options),
      }))
    }

    async *stream(options) {
      const cfg = this._cfg()
      const dshSessionId = String(options.sessionId || 'anonymous')
      const mapping = deps.sessions.ensure(dshSessionId, {
        botId: typeof options.sessionId === 'string' ? undefined : undefined,
      })
      const bridge = createToolBridge(cfg, { fetchImpl: deps.fetchImpl })
      const request = prepareBrainRequest(options, cfg, bridge, deps.logger)
      const kind = callKind(options)

      try {
        if (cfg.mode === 'gateway') {
          deps.logger?.info?.(
            `[dsh-jiuwen] brain=jiuwen gateway chat.send kind=${kind} dsh=${dshSessionId} jiuwen=${mapping.jiuwenSessionId} model=${options.model}`,
          )
          yield *this._gatewayTransport().stream(request, mapping)
          return
        }

        deps.logger?.info?.(
          `[dsh-jiuwen] mode=openai (fallback) base=${cfg.baseURL} kind=${kind} session=${mapping.jiuwenSessionId} allowDshAgentLoop=${cfg.allowDshAgentLoop}`,
        )
        yield *this._openaiTransport().stream(request)
      } catch (error) {
        deps.logger?.error?.(error)
        yield failureFromError(error, options.signal)
      }
    }
  }

  return JiuwenLlmAdapter
}

/** Convenience: construct with optional peer package. */
export async function loadJiuwenAdapterClass() {
  const stubCfg = {
    provider: 'jiuwen',
    displayName: 'JiuwenSwarm',
    mode: 'gateway',
    brainOwnership: 'jiuwen',
    baseURL: 'http://127.0.0.1',
    gatewayURL: 'ws://127.0.0.1',
    models: [],
    defaultModel: 'x',
    mappingPath: '/tmp/x',
    allowDshAgentLoop: false,
    exposeJiuwenTools: false,
    surfaceGatewayToolEvents: true,
    requestTimeoutMs: 1000,
    apiKeyEnv: 'JIUWEN_API_KEY',
    userId: 'x',
    workMode: 'agent',
  }
  const deps = {
    config: () => stubCfg,
    sessions: { ensure: id => ({ dshSessionId: id, jiuwenSessionId: id, updatedAt: '' }) },
  }
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    return createJiuwenAdapter(mod.LlmAdapter, deps)
  } catch {
    return createJiuwenAdapter(null, deps)
  }
}
