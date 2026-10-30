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
import { appendFileSync } from 'node:fs'
import { failureFromError, emitTextReply } from './stream-emit.js'
import { toGatewayQuery, contentToText } from './messages.js'

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
      const key = JSON.stringify([cfg.gatewayURL, cfg.authToken, cfg.userId, cfg.eventDisplay, cfg.forwardReasoning,
        cfg.showProcessingStatus, cfg.emitUsage, cfg.interruptOnAbort, cfg.finalGraceMs, cfg.terminalFinalGraceMs, cfg.postCancelSettleMs, cfg.chatMode, cfg.workMode, cfg.projectDir])
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
          chatMode: cfg.chatMode,
          eventDisplay: cfg.eventDisplay,
          forwardReasoning: cfg.forwardReasoning,
          showProcessingStatus: cfg.showProcessingStatus,
          emitUsage: cfg.emitUsage,
          interruptOnAbort: cfg.interruptOnAbort,
          finalGraceMs: cfg.finalGraceMs,
          postCancelSettleMs: cfg.postCancelSettleMs,
          terminalFinalGraceMs: cfg.terminalFinalGraceMs,
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
        inputModalities: ['text', 'image'],
      }))
    }

    resolveModel(provider, model) {
      const cfg = this._cfg()
      const hit = cfg.models.find(m => m.id === model)
      return Promise.resolve({
        provider,
        id: model,
        name: hit?.name || model,
        inputModalities: ['text', 'image'],
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
      const reqSession = options?.providerOptions?.jiuwen?.sessionId || options?.metadata?.jiuwen?.sessionId || options?.jiuwen?.sessionId
      const mapping = deps.sessions.ensure(dshSessionId, reqSession ? { preferredJiuwenId: String(reqSession) } : {})
      const bridge = createToolBridge(cfg, { fetchImpl: deps.fetchImpl })
      let request = prepareBrainRequest(options, cfg, bridge, deps.logger)
      const kind = callKind(options)

      try {
        if (cfg.mode === 'gateway' && options.purpose === 'session-title' && cfg.titleMode === 'local') {
          // Don't spend a full Jiuwen agent turn (and pollute its session) on a title.
          const title = localTitle(options, cfg.ignoreMessagePatterns)
          makeTrace(cfg.traceFile)({ at: 'local-title', title, system: String(options.system || '').slice(0, 300), messages: JSON.stringify(options.messages).slice(0, 1500) })
          yield *emitTextReply(title)
          return
        }
        if (cfg.mode === 'gateway' && options.purpose === 'compaction' && cfg.compactionMode !== 'jiuwen') {
          // Jiuwen owns the real history (historyMode=gateway sends only new user text), so dsh's checkpoint
          // only needs to be a faithful local digest — no throwaway Jiuwen agent turn (~7 s + a new Jiuwen session).
          const summary = localCompaction(options, cfg.ignoreMessagePatterns, mapping.jiuwenSessionId)
          let compacted
          if (cfg.compactionMode === 'local+jiuwen' && mapping.turns > 0) {
            try { await this._gatewayTransport().rpc('command.compact', { session_id: mapping.jiuwenSessionId }, { timeoutMs: 60_000 }); compacted = true } catch (error) { compacted = String(error?.message || error).slice(0, 200) }
          }
          makeTrace(cfg.traceFile)({ at: 'local-compaction', chars: summary.length, jiuwenCompact: compacted })
          yield *emitTextReply(summary)
          return
        }
        if (cfg.mode === 'gateway') {
          deps.logger?.info?.(
            `[dsh-jiuwen] brain=jiuwen gateway chat.send kind=${kind} dsh=${dshSessionId} jiuwen=${mapping.jiuwenSessionId} model=${options.model}`,
          )
          options = await hydrateAttachments(options, deps.attachments?.(), deps.logger)
          const overrides = turnOverrides(cfg, options)
          if (!overrides.modelName && mapping.modelName) overrides.modelName = mapping.modelName // /jiuwen model <name>
          // Per-session overrides from /jiuwen mode (and future skills/agentTemplate): request + catalog
          // win over mapping; mapping wins over bare plugin defaults when those fields were only filled from cfg.
          {
            const req = options?.providerOptions?.jiuwen || options?.metadata?.jiuwen || options?.jiuwen || {}
            const catalog = cfg.models.find(m => m.id === options?.model)
            if (!req.chatMode && !catalog?.chatMode && mapping.chatMode) overrides.chatMode = mapping.chatMode
            if (req.skills === undefined && mapping.skills) overrides.skills = mapping.skills
            if (!req.agentTemplateName && !catalog?.agentTemplateName && mapping.agentTemplateName) {
              overrides.agentTemplateName = mapping.agentTemplateName
            }
          }
          if (overrides.supportsUserInteraction === 'auto') overrides.supportsUserInteraction = Boolean(deps.hasUserQuestions?.())
          // Auxiliary calls (compaction, jiuwen titles) use a throwaway Jiuwen session + full transcript.
          const aux = Boolean(options.purpose)
          const turnMapping = aux ? { ...mapping, jiuwenSessionId: `${mapping.jiuwenSessionId}-aux-${Date.now().toString(36)}`, turns: 0 } : mapping
          if (aux) overrides.historyMode = 'transcript'
          const query = buildQuery(options, turnMapping, cfg, overrides)
          const trace = makeTrace(cfg.traceFile)
          if (!aux && cfg.toolPassthrough === 'mcp' && deps.mcpBridge && options.tools?.length) {
            const r = await deps.mcpBridge.prepare(options.tools, dshSessionId)
            trace({ at: 'mcp-passthrough', exposed: deps.mcpBridge.exposed(), error: r?.error })
            if (r && !r.error) overrides.mcp = [...(overrides.mcp || []), cfg.mcpServerName]
          }
          trace({ at: 'turn-start', dshSessionId, jiuwen: turnMapping.jiuwenSessionId, purpose: options.purpose, query: query.slice(0, 500), messages: (options.messages || []).length,
            blocks: JSON.stringify((options.messages || []).flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b?.type !== 'text') : [])).slice(0, 1500) })
          let recorded = false
          try {
          request = { ...request, messages: options.messages }
          yield *this._gatewayTransport().stream(request, turnMapping, {
            query,
            mark: (name) => trace({ at: 'mark', name }),
            traceParams: (p) => trace({ at: 'params', params: { ...p, content: undefined, query: String(p.query).slice(0, 300) } }),
            overrides,
            ...(deps.interact && !aux ? { interact: (q) => deps.interact({ ...q, told: overrides.supportsUserInteraction === true }, dshSessionId) } : {}),
            onEvent: (e) => {
              trace({ at: 'event', type: e.type, name: e.name, event: e.event, ...(e.type === 'interaction_answered' ? { eventType: e.eventType, source: e.source, outcome: e.outcome, raw: JSON.stringify(e.raw).slice(0, 1500) } : {}) })
              try { overrides.onEvent?.(e) } catch { /* ignore */ }
              try { deps.onEvent?.({ dshSessionId, ...e }) } catch { /* ignore */ }
            },
            onTurnEnd: (info) => {
              trace({ at: 'turn-end', reason: info.reason, chars: info.text?.length })
              recorded = true
              if (!aux && (info.reason?.kind === 'stop' || info.reason?.kind === 'aborted')) {
                deps.sessions.recordTurn?.(dshSessionId, { requestId: info.requestId, pendingQuestion: info.pendingQuestion })
              }
            },
          })
          } finally {
            // Host may stop iterating right after abort; Jiuwen already holds the user message.
            if (!recorded && !aux && options.signal?.aborted) {
              trace({ at: 'turn-end', reason: { kind: 'aborted' } })
              deps.sessions.recordTurn?.(dshSessionId, {})
            }
          }
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

/**
 * Per-request Jiuwen options: options.providerOptions.jiuwen | options.metadata.jiuwen | options.jiuwen,
 * layered over plugin config and the selected catalog model.
 */
export function turnOverrides(cfg, options) {
  const req = options?.providerOptions?.jiuwen || options?.metadata?.jiuwen || options?.jiuwen || {}
  const model = cfg.models.find(m => m.id === options?.model)
  let modelName = req.modelName ?? model?.modelName
  if (modelName === undefined && cfg.forwardModelName && options?.model && !model) modelName = options.model
  const pick = (k) => req[k] ?? model?.[k] ?? cfg[k]
  return {
    chatMode: pick('chatMode'),
    agentTemplateName: pick('agentTemplateName'),
    agentGroupName: pick('agentGroupName'),
    skills: req.skills ?? cfg.skills,
    pluginNames: req.pluginNames,
    ...(Array.isArray(req.mcp) ? { mcp: req.mcp.map(String) } : {}),
    metadata: req.metadata,
    projectDir: req.projectDir,
    supportsUserInteraction: req.supportsUserInteraction ?? cfg.supportsUserInteraction,
    sessionId: req.sessionId,
    historyMode: req.historyMode ?? cfg.historyMode,
    ...(modelName ? { modelName } : {}),
    ...(typeof req.onEvent === 'function' ? { onEvent: req.onEvent } : {}),
  }
}

/**
 * Gateway query text honoring session continuity: once the Jiuwen session has turns,
 * send only the user messages after the last assistant message (hosts may append
 * several, e.g. task + runtime-context), since Jiuwen keeps its own history.
 */
export function buildQuery(options, mapping, cfg, overrides) {
  if ((overrides.historyMode || cfg.historyMode) === 'gateway') {
    const tail = trailingUserText(options.messages || [], cfg.ignoreMessagePatterns)
    if ((mapping.turns || 0) > 0 && tail) return tail
    const hasAssistant = (options.messages || []).some(m => m.role === 'assistant')
    if (!hasAssistant && tail) return tail
  }
  const ignore = cfg.ignoreMessagePatterns || []
  const messages = (options.messages || [])
    .map(m => (m.role === 'user' ? { ...m, content: stripIgnored(m.content, ignore) } : m))
    .filter(m => m.role !== 'user' || m.content)
  return toGatewayQuery({ ...options, messages })
}

function trailingUserText(messages, ignore = []) {
  const out = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') break
    if (m.role === 'user') {
      const t = stripIgnored(m.content, ignore)
      if (t) out.unshift(t)
    }
  }
  return out.join('\n\n')
}

/** Text of a message minus host-context blocks (a matching block is cut from the match onward). */
export function stripIgnored(content, ignore = []) {
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: contentToText(content) }]
  const out = []
  for (const b of blocks) {
    let t = b?.type === 'text' ? String(b.text || '') : contentToText([b])
    for (const re of ignore) {
      const m = re.exec(t)
      if (m) t = t.slice(0, m.index)
    }
    t = t.trim()
    if (t) out.push(t)
  }
  return out.join('\n')
}

/**
 * Optional: resolve content-addressed attachments through a host `attachments`
 * service (Cordis AttachmentStore shape: readImageRequest / fileHostPath) so images
 * and files reach Jiuwen as base64Data. No-op when the host has no such service.
 */
export async function hydrateAttachments(options, store, logger) {
  if (!store || !Array.isArray(options.messages)) return options
  let changed = false
  const messages = []
  for (const m of options.messages) {
    if (!Array.isArray(m.content)) { messages.push(m); continue }
    const content = []
    for (const b of m.content) {
      const att = b?.attachment
      if (!att?.attachmentId || att.base64 || att.dataUrl || att.path) { content.push(b); continue }
      try {
        if (b.type === 'image' && typeof store.readImageRequest === 'function') {
          const scale = Math.min(1, 2048 / Math.max(att.width || 2048, att.height || 2048))
          const img = await store.readImageRequest(att, {
            width: Math.max(1, Math.round((att.width || 2048) * scale)),
            height: Math.max(1, Math.round((att.height || 2048) * scale)),
            maxBytes: 4 * 1024 * 1024,
          }, options.signal)
          content.push({ ...b, attachment: { ...att, mimeType: img.mediaType || att.mediaType, base64: Buffer.from(img.data).toString('base64') } })
          changed = true
          continue
        }
        if (b.type === 'file' && typeof store.fileHostPath === 'function') {
          const path = store.fileHostPath(att)
          if (path) { content.push({ ...b, attachment: { ...att, path, mimeType: att.mimeType || att.mediaType } }); changed = true; continue }
        }
      } catch (error) {
        logger?.warn?.(`[dsh-jiuwen] attachment ${att.attachmentId} unresolved: ${error?.message || error}`)
      }
      content.push(b)
    }
    messages.push({ ...m, content })
  }
  return changed ? { ...options, messages } : options
}

/**
 * Local compaction digest: the conversation as role-tagged lines, newest kept when over budget.
 * The trailing compaction instruction (last user message) is dropped.
 */
export function localCompaction(options, ignore = [], jiuwenSessionId, budget = 6000) {
  const msgs = [...(options.messages || [])]
  if (msgs.at(-1)?.role === 'user') msgs.pop()
  const lines = []
  for (const m of msgs) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const t = stripIgnored(m.content, ignore).replace(/\s+/g, ' ').trim()
    if (t) lines.push(`- ${m.role}: ${t.length > 600 ? `${t.slice(0, 600)}…` : t}`)
  }
  const kept = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > budget && kept.length) break
    kept.unshift(lines[i]); size += lines[i].length
  }
  const head = `Conversation checkpoint (local digest${jiuwenSessionId ? `; JiuwenSwarm session ${jiuwenSessionId} keeps the full history` : ''}).`
  const omitted = lines.length - kept.length
  return [head, ...(omitted > 0 ? [`(${omitted} earlier message(s) omitted)`] : []), ...kept].join('\n')
}

/** Instant session title from the first user message. */
export function localTitle(options, ignore = []) {
  const first = (options.messages || []).find(m => m.role === 'user')
  let raw = stripIgnored(first?.content, ignore)
  // Title prompts often embed the conversation as a JSON array ([{text}] / [{content}]).
  const a = raw.indexOf('['), b = raw.lastIndexOf(']')
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(raw.slice(a, b + 1))
      const item = Array.isArray(arr) ? arr.find(x => x && (typeof x === 'string' || x.text || x.content)) : undefined
      const inner = typeof item === 'string' ? item : (item?.text ?? contentToText(item?.content))
      if (inner) raw = stripIgnored(String(inner), ignore)
    } catch { /* not JSON */ }
  }
  const t = raw.replace(/\s+/g, ' ').trim()
  return t ? (t.length > 40 ? `${t.slice(0, 40)}…` : t) : 'Jiuwen chat'
}

function makeTrace(file) {
  if (!file) return () => {}
  return (rec) => {
    try { appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), up: Math.round(performance.now()), ...rec })}\n`) } catch { /* ignore */ }
  }
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
