/**
 * Jiuwen Gateway WebSocket client: chat.send streaming + unary E2A RPCs.
 * Tools/memory/loop stay on Jiuwen; we never emit DSH tool-call blocks.
 */
import { randomUUID } from 'node:crypto'
import { toGatewayQuery } from './messages.js'
import { failureFromError } from './stream-emit.js'
import { resolveAuthMaterials, buildGatewayWsUrl } from './auth.js'
import { extractMediaFromOptions, attachMediaToChatParams } from './multimodal.js'
import {
  CHAT, HISTORY, MEMORY, MODELS, MCP, FILES, MEDIA, SESSION, SWARM,
  SKILLS, AGENTS, TEAM, COMMANDS, EVENTS, normalizeEventName,
} from './e2a-methods.js'


export class GatewayTransport {
  /**
   * @param {{
   *   gatewayURL: string,
   *   userId?: string,
   *   authToken?: string,
   *   accessToken?: string,
   *   cookie?: string,
   *   authorization?: string,
   *   xToken?: string,
   *   workMode?: string,
   *   projectDir?: string,
   *   requestTimeoutMs?: number,
   *   surfaceToolEvents?: boolean,
   *   WebSocketImpl?: typeof WebSocket,
   * }} opts
   */
  constructor(opts) {
    this.gatewayURL = opts.gatewayURL
    this.workMode = opts.workMode || 'agent'
    this.projectDir = opts.projectDir
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000
    this.surfaceToolEvents = opts.surfaceToolEvents !== false
    this.chatMode = opts.chatMode
    this.eventDisplay = opts.eventDisplay || (this.surfaceToolEvents ? 'reasoning' : 'none')
    this.forwardReasoning = opts.forwardReasoning !== false
    this.showProcessingStatus = opts.showProcessingStatus === true
    this.emitUsage = opts.emitUsage !== false
    this.interruptOnAbort = opts.interruptOnAbort !== false
    this.finalGraceMs = Number.isFinite(opts.finalGraceMs) ? opts.finalGraceMs : 1500
    this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket
    this.auth = resolveAuthMaterials({
      userId: opts.userId || 'dsh-adapter',
      authToken: opts.authToken,
      accessToken: opts.accessToken,
      cookie: opts.cookie,
      authorization: opts.authorization,
      xToken: opts.xToken,
    })
  }

  /**
   * Stream one agent turn (Jiuwen brain).
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
   * @param {{ jiuwenSessionId: string, turns?: number }} mapping
   * @param {{ query?: string, overrides?: Record<string, unknown>, onEvent?: (e: object) => void, onTurnEnd?: (info: object) => void }} [turn]
   */
  async *stream(options, mapping, turn = {}) {
    const signal = options.signal
    if (!this.WebSocketImpl) {
      yield failureFromError(new Error('WebSocket is not available; cannot use gateway brain'), signal)
      return
    }

    const query = turn.query ?? toGatewayQuery(options)
    const media = extractMediaFromOptions(options)
    const requestId = `dsh-${randomUUID()}`
    const url = buildGatewayWsUrl(this.gatewayURL, this.auth)
    const o = { ...(turn.overrides || {}) }
    const projectDir = o.projectDir || this.projectDir
    const mode = o.chatMode || this.chatMode || this.workMode

    let ws
    try {
      ws = await this._connect(url, signal)
      await this._awaitAck(ws, Math.min(15_000, this.requestTimeoutMs), signal)

      let params = {
        session_id: mapping.jiuwenSessionId,
        content: query,
        query,
        mode,
        work_mode: this.workMode,
        ...(o.modelName ? { model_name: o.modelName } : {}),
        user_id: this.auth.userId,
        ...(o.agentTemplateName !== undefined ? { agent_template_name: o.agentTemplateName } : {}),
        ...(o.agentGroupName ? { agent_group_name: o.agentGroupName } : {}),
        ...(Array.isArray(o.skills) ? { skills: o.skills } : {}),
        ...(Array.isArray(o.pluginNames) ? { plugin_names: o.pluginNames } : {}),
        ...(o.metadata && typeof o.metadata === 'object' ? { metadata: o.metadata } : {}),
        supports_user_interaction: o.supportsUserInteraction ?? false,
        ...(projectDir ? {
          project_dir: projectDir,
          cwd: projectDir,
          workspace_dir: projectDir,
          trusted_dirs: [projectDir],
        } : {}),
      }
      params = attachMediaToChatParams(params, media)
      if (media.textExtras.length && !media.mediaItems.length) {
        params.query = `${params.query}\n${media.textExtras.join('\n')}`
        params.content = params.query
      }

      ws.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method: CHAT.SEND,
        params,
      }))

      yield *this._consume(ws, requestId, signal, { mapping, onEvent: turn.onEvent, onTurnEnd: turn.onTurnEnd })
    } catch (error) {
      yield failureFromError(error, signal)
    } finally {
      try { ws?.close() } catch { /* ignore */ }
    }
  }

  /** Unary E2A RPC helper (opens a short-lived connection). */
  async rpc(method, params = {}, { timeoutMs } = {}) {
    if (!this.WebSocketImpl) throw Object.assign(new Error('WebSocket unavailable'), { code: 'TRANSPORT' })
    const url = buildGatewayWsUrl(this.gatewayURL, this.auth)
    const ws = await this._connect(url)
    try {
      await this._awaitAck(ws, Math.min(15_000, this.requestTimeoutMs))
      return await this._unary(ws, method, params, timeoutMs ?? 30_000)
    } finally {
      try { ws.close() } catch { /* ignore */ }
    }
  }

  // ── Convenience RPCs (Jiuwen-owned surfaces) ─────────────────────
  historyGet(sessionId, extra = {}) {
    return this.rpc(HISTORY.GET, { session_id: sessionId, ...extra })
  }
  historyListTurns(sessionId, extra = {}) {
    return this.rpc(HISTORY.LIST_TURNS, { session_id: sessionId, ...extra })
  }
  sessionMetadata(sessionId, extra = {}) {
    return this.rpc(SESSION.GET_METADATA, { session_id: sessionId, ...extra })
  }
  modelsList(extra = {}) {
    return this.rpc(MODELS.LIST, { ...extra })
  }
  mcpList(filter = 'builtin') {
    return this.rpc(MCP.LIST, { filter })
  }
  memoryList(sessionId, extra = {}) {
    return this.rpc(MEMORY.LIST, { session_id: sessionId, ...extra })
  }
  memoryStatus(sessionId, extra = {}) {
    return this.rpc(MEMORY.STATUS, { session_id: sessionId, ...extra })
  }
  filesList(sessionId, extra = {}) {
    return this.rpc(FILES.LIST, { session_id: sessionId, ...extra })
  }
  mediaPersist(sessionId, extra = {}) {
    return this.rpc(MEDIA.PERSIST, { session_id: sessionId, ...extra })
  }
  chatCancel(sessionId, extra = {}) {
    return this.rpc(CHAT.CANCEL, { session_id: sessionId, ...extra })
  }
  swarmflowPause(sessionId, extra = {}) {
    return this.rpc(SWARM.PAUSE, { session_id: sessionId, ...extra })
  }
  swarmflowResume(sessionId, extra = {}) {
    return this.rpc(SWARM.RESUME, { session_id: sessionId, ...extra })
  }
  chatInterrupt(sessionId, intent = 'cancel', extra = {}) {
    return this.rpc(CHAT.CANCEL, { session_id: sessionId, intent, ...extra })
  }
  userAnswer(sessionId, answers, extra = {}) {
    return this.rpc(CHAT.ANSWER, { session_id: sessionId, answers, ...extra })
  }
  chatResume(sessionId, extra = {}) {
    return this.rpc(CHAT.RESUME, { session_id: sessionId, ...extra })
  }
  sessionList(extra = {}) { return this.rpc(SESSION.LIST, { ...extra }) }
  sessionCreate(extra = {}) { return this.rpc(SESSION.CREATE, { ...extra }) }
  sessionDelete(sessionId, extra = {}) { return this.rpc(SESSION.DELETE, { session_id: sessionId, ...extra }) }
  sessionFork(sessionId, extra = {}) { return this.rpc(SESSION.FORK, { session_id: sessionId, ...extra }) }
  skillsList(extra = {}) { return this.rpc(SKILLS.LIST, { ...extra }) }
  agentsList(extra = {}) { return this.rpc(AGENTS.LIST, { ...extra }) }
  teamTemplatesList(extra = {}) { return this.rpc(TEAM.TEMPLATES_LIST, { ...extra }) }
  commandsList(extra = {}) { return this.rpc(COMMANDS.LIST, { ...extra }) }
  compact(sessionId, extra = {}) { return this.rpc(COMMANDS.COMPACT, { session_id: sessionId, ...extra }) }
  workflows(sessionId, action = 'list', extra = {}) {
    return this.rpc(SWARM.WORKFLOWS, { session_id: sessionId, action, ...extra })
  }

  _connect(url, signal) {
    return new Promise((resolve, reject) => {
      const headers = this.auth.headers
      // Node undici/ws-like constructors may accept { headers }; browsers ignore.
      let ws
      try {
        ws = new this.WebSocketImpl(url, undefined, { headers })
      } catch {
        ws = new this.WebSocketImpl(url)
      }
      const onAbort = () => {
        try { ws.close() } catch { /* ignore */ }
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      ws.addEventListener('open', () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        signal?.removeEventListener('abort', onAbort)
        reject(Object.assign(new Error(`Jiuwen Gateway WebSocket failed: ${url}`), { code: 'TRANSPORT' }))
      })
    })
  }

  _awaitAck(ws, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve() }, timeoutMs)
      const onAbort = () => {
        cleanup()
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
      }
      const onMessage = (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        const name = normalizeEventName(frame.event || frame.payload?.event_type)
        if (frame.type === 'event' && name === EVENTS.CONNECTION_ACK) {
          cleanup()
          resolve()
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        ws.removeEventListener('message', onMessage)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      ws.addEventListener('message', onMessage)
    })
  }

  _unary(ws, method, params, timeoutMs) {
    const id = `rpc-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(Object.assign(new Error(`RPC ${method} timed out`), { code: 'TIMEOUT' }))
      }, timeoutMs)
      const onMessage = (event) => {
        let frame
        try { frame = JSON.parse(String(event.data)) } catch { return }
        if (frame.type !== 'res' || frame.id !== id) return
        cleanup()
        if (frame.ok === false) {
          reject(Object.assign(new Error(JSON.stringify(frame.error || frame.payload || frame)), { code: 'TRANSPORT' }))
          return
        }
        resolve(frame.payload ?? frame.result ?? frame)
      }
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  /**
   * Consume one chat.send turn. Ends on chat.processing_status{is_complete},
   * stream.end, chat.error, interrupt_result, or `finalGraceMs` idle after chat.final.
   */
  async *_consume(ws, requestId, signal, ctx = {}) {
    const text = { index: 0, started: false, body: '' }
    const reasoning = { index: 1, started: false, body: '' }
    let nextIndex = 2
    let finalSeen = false
    let lastActivity = Date.now()
    let usage
    let pendingQuestion = null
    const deadline = Date.now() + this.requestTimeoutMs
    const queue = []
    let wake
    const push = (item) => { queue.push(item); wake?.() }
    const emitEvent = (e) => {
      try { ctx.onEvent?.({ requestId, sessionId: ctx.mapping?.jiuwenSessionId, ...e }) } catch { /* ignore */ }
    }

    const onMessage = (event) => {
      try { push({ ok: true, frame: JSON.parse(String(event.data)) }) }
      catch (error) { push({ ok: false, error }) }
    }
    const onClose = () => push({ ok: false, error: Object.assign(new Error('Gateway WebSocket closed'), { code: 'TRANSPORT' }) })
    const onError = () => push({ ok: false, error: Object.assign(new Error('Gateway WebSocket error'), { code: 'TRANSPORT' }) })
    const onAbort = () => push({ ok: false, abort: true })

    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    const textDelta = function *(delta) {
      if (!delta) return
      if (!text.started) { text.started = true; yield { type: 'block-start', index: text.index, blockType: 'text' } }
      text.body += delta
      yield { type: 'text-delta', index: text.index, text: delta }
    }
    const reasoningDelta = function *(delta) {
      if (!delta) return
      if (!reasoning.started) { reasoning.started = true; yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' } }
      reasoning.body += delta
      yield { type: 'reasoning-delta', index: reasoning.index, text: delta }
    }
    /** Activity line (tool/subtask/status) per eventDisplay. */
    const activity = function *(self, line) {
      if (self.eventDisplay === 'none' || !line) return
      if (self.eventDisplay === 'markers') { yield *textDelta(`${line}\n`); return }
      yield *reasoningDelta(`${reasoning.body && !reasoning.body.endsWith('\n') ? '\n' : ''}${line}\n`)
    }
    const self = this
    const finish = function *(reason) {
      if (reasoning.started) yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.body } }
      if (text.started) yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.body } }
      if (usage && self.emitUsage && reason.kind !== 'error' && reason.kind !== 'aborted') yield { type: 'usage', usage }
      try { ctx.onTurnEnd?.({ requestId, reason, pendingQuestion, text: text.body }) } catch { /* ignore */ }
      yield { type: 'finish', reason }
    }

    try {
      while (true) {
        if (Date.now() > deadline) {
          throw Object.assign(new Error(`Jiuwen Gateway turn timed out after ${this.requestTimeoutMs}ms`), { code: 'TIMEOUT' })
        }
        if (queue.length === 0) {
          const waitMs = finalSeen ? Math.max(1, this.finalGraceMs - (Date.now() - lastActivity)) : 1000
          await new Promise((resolve) => {
            wake = resolve
            setTimeout(resolve, Math.min(waitMs, Math.max(1, deadline - Date.now())))
          })
          wake = undefined
          if (queue.length === 0) {
            if (signal?.aborted) queue.push({ ok: false, abort: true })
            else if (finalSeen && Date.now() - lastActivity >= this.finalGraceMs) {
              yield *finish({ kind: 'stop' }); return
            } else continue
          }
        }
        const item = queue.shift()
        if (item.abort) {
          if (this.interruptOnAbort) {
            try {
              ws.send(JSON.stringify({
                type: 'req', id: `cancel-${randomUUID()}`, method: CHAT.CANCEL,
                params: { session_id: ctx.mapping?.jiuwenSessionId, intent: 'cancel', request_id: requestId },
              }))
              emitEvent({ type: 'interrupt', intent: 'cancel' })
              await new Promise(r => setTimeout(r, 150))
            } catch { /* ignore */ }
          }
          yield *finish({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } })
          return
        }
        if (!item.ok) {
          if (finalSeen) { yield *finish({ kind: 'stop' }); return }
          throw item.error
        }
        const frame = item.frame
        lastActivity = Date.now()

        if (frame.type === 'res' && frame.id === requestId && frame.ok === false) {
          const err = frame.error || frame.payload || frame
          throw Object.assign(new Error(typeof err === 'string' ? err : JSON.stringify(err)), { code: 'TRANSPORT' })
        }
        if (frame.type === 'res') continue

        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {}
        const eventType = normalizeEventName(frame.event || payload.event_type)
        const content = payload.content

        switch (eventType) {
          case EVENTS.DELTA:
            if (typeof content === 'string') yield *textDelta(content)
            continue
          case EVENTS.REASONING:
            emitEvent({ type: 'reasoning', text: content })
            if (this.forwardReasoning && typeof content === 'string') {
              if (this.eventDisplay === 'markers') continue // legacy: reasoning not shown
              yield *reasoningDelta(content)
            }
            continue
          case EVENTS.TOOL_CALL: {
            const tc = payload.tool_call || payload
            const name = tc.name || tc.tool_name || payload.tool_name || payload.name || 'tool'
            const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {})
            emitEvent({ type: 'tool_call', name, id: tc.tool_call_id || tc.id, arguments: args, raw: payload })
            yield *activity(this, this.eventDisplay === 'markers'
              ? `[jiuwen-tool:${name}]`
              : `🔧 ${name} ${truncate(args, 300)}`)
            continue
          }
          case EVENTS.TOOL_UPDATE:
            emitEvent({ type: 'tool_update', name: payload.tool_name || payload.name, id: payload.tool_call_id, status: payload.status, raw: payload })
            continue
          case EVENTS.TOOL_RESULT: {
            const name = payload.tool_name || payload.name || 'tool'
            const result = payload.rendered_result ?? payload.result ?? content ?? ''
            const resultText = typeof result === 'string' ? result : JSON.stringify(result)
            emitEvent({ type: 'tool_result', name, id: payload.tool_call_id, success: payload.success, result: resultText, raw: payload })
            yield *activity(this, this.eventDisplay === 'markers'
              ? `[jiuwen-tool-result:${name}] ${truncate(resultText, 200)}`.trim()
              : `${payload.success === false ? '✗' : '✓'} ${name}: ${truncate(resultText, 400)}`)
            continue
          }
          case EVENTS.SUBTASK_UPDATE:
          case EVENTS.SUBAGENT_ACTIVITY:
          case EVENTS.TODO:
          case EVENTS.TEAM_TASK:
          case EVENTS.TEAM_MEMBER:
          case EVENTS.TEAM_MESSAGE: {
            const summary = typeof content === 'string' && content ? content : summarize(payload)
            emitEvent({ type: eventType.replace(/^chat\./, ''), summary, raw: payload })
            yield *activity(this, this.eventDisplay === 'markers'
              ? `[jiuwen-${eventType}] ${truncate(summary, 120)}`
              : `• ${eventType.replace(/^chat\./, '')}: ${truncate(summary, 200)}`)
            continue
          }
          case EVENTS.PROCESSING:
            emitEvent({ type: 'processing_status', isProcessing: payload.is_processing, isComplete: payload.is_complete, raw: payload })
            if (payload.is_complete === true && (finalSeen || text.body)) { yield *finish({ kind: 'stop' }); return }
            if (this.showProcessingStatus) yield *activity(this, `… ${payload.is_processing ? 'processing' : 'idle'}`)
            continue
          case EVENTS.USAGE_SUMMARY:
          case EVENTS.USAGE_METADATA: {
            const u = payload.usage || payload.metadata?.usage_metadata
            if (u && (eventType === EVENTS.USAGE_SUMMARY || !usage)) {
              usage = {
                inputTokens: Number(u.input_tokens || 0),
                outputTokens: Number(u.output_tokens || 0),
                ...(u.total_tokens ? { totalTokens: Number(u.total_tokens) } : {}),
                ...(u.cache_tokens ? { cacheReadTokens: Number(u.cache_tokens) } : {}),
              }
            }
            emitEvent({ type: 'usage', usage, model: payload.model, raw: payload })
            continue
          }
          case EVENTS.MEDIA:
          case EVENTS.FILE: {
            const kind = eventType === EVENTS.MEDIA ? 'media' : 'file'
            const files = Array.isArray(payload.files) ? payload.files : [payload]
            for (const f of files) {
              const name = f.name || f.filename || f.path || kind
              emitEvent({ type: kind, name, path: f.path, url: f.url, raw: f })
              yield *textDelta(`\n[jiuwen-${kind}:${name}]\n`)
            }
            continue
          }
          case EVENTS.ASK_USER: {
            pendingQuestion = { requestId: payload.request_id || requestId, payload }
            const qs = Array.isArray(payload.questions) ? payload.questions : []
            const rendered = qs.length
              ? qs.map((q, i) => `${i + 1}. ${q.question || q.text || q.header || ''}${Array.isArray(q.options) ? `\n   ${q.options.map(op => op.label || op).join(' / ')}` : ''}`).join('\n')
              : (typeof content === 'string' ? content : summarize(payload))
            emitEvent({ type: 'ask_user', questions: qs, raw: payload })
            yield *textDelta(`${text.body ? '\n\n' : ''}❓ ${rendered}\n`)
            yield *finish({ kind: 'stop' })
            return
          }
          case EVENTS.ERROR: {
            const message = typeof content === 'string' && content ? content : (payload.error || 'Jiuwen chat.error')
            emitEvent({ type: 'error', message: String(message), raw: payload })
            // Agent-level failure after Jiuwen accepted the turn: not retryable (a host retry would
            // re-send the user message into the same Jiuwen session).
            yield *finish({ kind: 'error', failure: { message: String(message), code: 'JIUWEN_ERROR' } })
            return
          }
          case EVENTS.INTERRUPT_RESULT:
            emitEvent({ type: 'interrupt_result', raw: payload })
            yield *finish({ kind: signal?.aborted ? 'aborted' : 'stop' })
            return
          case EVENTS.FINAL:
          case 'content': {
            // Segment finals may repeat streamed text; only append an unseen tail.
            if (typeof content === 'string' && content) {
              if (!text.body) yield *textDelta(content)
              else if (content.startsWith(text.body) && content.length > text.body.length) yield *textDelta(content.slice(text.body.length))
            }
            finalSeen = true
            continue
          }
          case EVENTS.STREAM_END:
            if (frame.id == null || frame.id === requestId || frame.request_id === requestId) {
              yield *finish({ kind: 'stop' }); return
            }
            continue
          default:
            emitEvent({ type: 'raw', event: eventType, raw: payload })
            continue
        }
      }
    } finally {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function truncate(s, n) {
  const v = String(s ?? '')
  return v.length > n ? `${v.slice(0, n)}…` : v
}

function summarize(payload) {
  const { runtime_event, output_order, ...rest } = payload || {}
  return JSON.stringify(rest).slice(0, 300)
}

export { CHAT, HISTORY, MEMORY, MODELS, MCP, FILES, MEDIA, SESSION, SWARM, SKILLS, AGENTS, TEAM, COMMANDS, EVENTS }
