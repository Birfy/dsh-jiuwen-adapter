/**
 * Jiuwen Gateway WebSocket client: chat.send streaming + unary E2A RPCs.
 * Tools/memory/loop stay on Jiuwen; we never emit DSH tool-call blocks.
 */
import { randomUUID } from 'node:crypto'
import { toGatewayQuery } from './messages.js'
import { emitTextDelta, finishText, failureFromError } from './stream-emit.js'
import { resolveAuthMaterials, buildGatewayWsUrl } from './auth.js'
import { extractMediaFromOptions, attachMediaToChatParams } from './multimodal.js'
import {
  CHAT, HISTORY, MEMORY, MODELS, MCP, FILES, MEDIA, SESSION, SWARM,
  EVENTS, normalizeEventName,
} from './e2a-methods.js'

const FINAL_EVENTS = new Set([
  EVENTS.FINAL,
  EVENTS.ERROR,
  'content',
  'error',
])

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
   * @param {{ jiuwenSessionId: string }} mapping
   */
  async *stream(options, mapping) {
    const signal = options.signal
    if (!this.WebSocketImpl) {
      yield failureFromError(new Error('WebSocket is not available; cannot use gateway brain'), signal)
      return
    }

    const query = toGatewayQuery(options)
    const media = extractMediaFromOptions(options)
    const requestId = `dsh-${randomUUID()}`
    const url = buildGatewayWsUrl(this.gatewayURL, this.auth)

    let ws
    try {
      ws = await this._connect(url, signal)
      await this._awaitAck(ws, Math.min(15_000, this.requestTimeoutMs), signal)

      let params = {
        session_id: mapping.jiuwenSessionId,
        content: query,
        query,
        mode: this.workMode,
        work_mode: this.workMode,
        model_name: options.model,
        user_id: this.auth.userId,
        ...(this.projectDir ? {
          project_dir: this.projectDir,
          cwd: this.projectDir,
          workspace_dir: this.projectDir,
          trusted_dirs: [this.projectDir],
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

      yield *this._consume(ws, requestId, signal)
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

  async *_consume(ws, requestId, signal) {
    const state = { started: false }
    let text = ''
    const deadline = Date.now() + this.requestTimeoutMs
    const queue = []
    let wake
    const push = (item) => { queue.push(item); wake?.() }

    const onMessage = (event) => {
      try { push({ ok: true, frame: JSON.parse(String(event.data)) }) }
      catch (error) { push({ ok: false, error }) }
    }
    const onClose = () => push({ ok: false, error: Object.assign(new Error('Gateway WebSocket closed'), { code: 'TRANSPORT' }) })
    const onError = () => push({ ok: false, error: Object.assign(new Error('Gateway WebSocket error'), { code: 'TRANSPORT' }) })
    const onAbort = () => push({ ok: false, error: Object.assign(new Error('aborted'), { code: 'ABORTED' }) })

    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (Date.now() < deadline) {
        if (queue.length === 0) {
          await new Promise((resolve) => {
            wake = resolve
            setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now())))
          })
          wake = undefined
          if (queue.length === 0) {
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
            continue
          }
        }
        const item = queue.shift()
        if (!item.ok) throw item.error
        const frame = item.frame

        if (frame.type === 'res' && frame.id === requestId && frame.ok === false) {
          const err = frame.error || frame.payload || frame
          throw Object.assign(new Error(typeof err === 'string' ? err : JSON.stringify(err)), { code: 'TRANSPORT' })
        }

        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {}
        const eventType = normalizeEventName(payload.event_type || frame.event)
        const content = payload.content

        if (eventType === EVENTS.DELTA && typeof content === 'string') {
          text += content
          yield *emitTextDelta(0, content, state)
          continue
        }

        // Media / file from Jiuwen — surface as text markers (bytes stay on Jiuwen).
        if (eventType === EVENTS.MEDIA || eventType === EVENTS.FILE) {
          const kind = eventType === EVENTS.MEDIA ? 'media' : 'file'
          const name = payload.name || payload.filename || payload.path || kind
          const note = `[jiuwen-${kind}:${name}]\n`
          text += note
          yield *emitTextDelta(0, note, state)
          continue
        }

        if (eventType === EVENTS.SUBTASK_UPDATE || eventType === EVENTS.PROCESSING || eventType === EVENTS.TODO) {
          const note = `[jiuwen-${eventType}] ${typeof content === 'string' ? content.slice(0, 120) : JSON.stringify(payload).slice(0, 120)}\n`
          text += note
          yield *emitTextDelta(0, note, state)
          continue
        }

        // Jiuwen-owned tools: observe only.
        if (this.surfaceToolEvents && (
          eventType === EVENTS.TOOL_CALL || eventType === EVENTS.TOOL_RESULT || eventType === EVENTS.TOOL_UPDATE
        )) {
          const name = payload.name || payload.tool_name || payload.tool || 'tool'
          const note = (eventType === EVENTS.TOOL_RESULT
            ? `[jiuwen-tool-result:${name}] ${typeof content === 'string' ? content.slice(0, 200) : ''}`
            : `[jiuwen-tool:${name}]`).trim() + '\n'
          text += note
          yield *emitTextDelta(0, note, state)
          continue
        }

        if (FINAL_EVENTS.has(eventType) || eventType === EVENTS.ASK_USER || eventType === EVENTS.INTERRUPT_RESULT) {
          if (typeof content === 'string' && content && content !== text) {
            if (!text || content.startsWith(text) || content.length >= text.length) {
              const extra = content.startsWith(text) ? content.slice(text.length) : (text ? '' : content)
              if (!text) {
                text = content
                yield *emitTextDelta(0, content, state)
              } else if (extra) {
                text = content
                yield *emitTextDelta(0, extra, state)
              } else if (content !== text) {
                text = content
              }
            }
          }
          if (eventType === EVENTS.ERROR) {
            const message = typeof content === 'string' && content ? content : (payload.error || 'Jiuwen chat.error')
            yield *finishText(0, text, state, {
              kind: 'error',
              failure: { message: String(message), code: 'TRANSPORT' },
            })
            return
          }
          yield *finishText(0, text, state, { kind: 'stop' })
          return
        }

        if (frame.event === EVENTS.STREAM_END && (frame.id == null || frame.id === requestId || frame.request_id === requestId)) {
          yield *finishText(0, text, state, { kind: 'stop' })
          return
        }
      }
      throw Object.assign(new Error(`Jiuwen Gateway turn timed out after ${this.requestTimeoutMs}ms`), { code: 'TIMEOUT' })
    } finally {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export { CHAT, HISTORY, MEMORY, MODELS, MCP, FILES, MEDIA, SESSION, SWARM, EVENTS }
