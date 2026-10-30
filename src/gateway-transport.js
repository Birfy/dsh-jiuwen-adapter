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
  SKILLS, AGENTS, TEAM, COMMANDS, SYSTEM, EVENTS, normalizeEventName,
} from './e2a-methods.js'

/** Jiuwen interaction sources that must be answered by a resuming chat.send (see jiuwenswarm runtime/interaction.py). */
export const INTERRUPT_RESUME_SOURCES = new Set(['confirm_interrupt', 'permission_interrupt', 'ask_user_interrupt', 'evolution_interrupt'])

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
    /** On host abort, also send swarmflow.stop for the session's last seen SwarmFlow run. */
    this.swarmflowStopOnAbort = opts.swarmflowStopOnAbort !== false
    /** Answer swarmflow_human questions with chat.swarmflow_reply. */
    this.swarmflowReply = opts.swarmflowReply !== false
    /** Opt-in: document.persist document attachments before chat.send. */
    this.documentPersist = opts.documentPersist === true
    this.finalGraceMs = Number.isFinite(opts.finalGraceMs) ? opts.finalGraceMs : 1500
    /** Idle grace after the terminal (empty, request-scoped) chat.final. Negative disables the early end. */
    this.terminalFinalGraceMs = Number.isFinite(opts.terminalFinalGraceMs) && opts.terminalFinalGraceMs >= 0 ? opts.terminalFinalGraceMs : (opts.terminalFinalGraceMs < 0 ? this.finalGraceMs : 100)
    /**
     * JiuwenSwarm accepts a chat.send issued within a few hundred ms of a chat.interrupt on the same
     * session but never runs it (the request hangs until another one arrives). Delay the next send on a
     * recently-cancelled session until this many ms after the cancel. 0 disables.
     */
    this.postCancelSettleMs = Number.isFinite(opts.postCancelSettleMs) ? opts.postCancelSettleMs : 1000
    /** @type {Map<string, number>} */
    this.recentCancels = new Map()
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
      const mark = turn.mark || (() => {})
      await this._settleAfterCancel(mapping, signal)
      mark('ws-connect')
      ws = await this._connect(url, signal)
      mark('ws-open')
      await this._awaitAck(ws, Math.min(15_000, this.requestTimeoutMs), signal)
      mark('ws-ack')

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
        ...(Array.isArray(o.mcp) && o.mcp.length ? { mcp: o.mcp } : {}),
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

      if (this.documentPersist) params = await this._persistDocuments(ws, params)
      ws.send(JSON.stringify({
        type: 'req',
        id: requestId,
        method: CHAT.SEND,
        params,
      }))

      mark('chat-send'); turn.traceParams?.(params)
      yield *this._consume(ws, requestId, signal, { mapping, onEvent: turn.onEvent, onTurnEnd: turn.onTurnEnd, mark, interact: turn.interact, resumeParams: { session_id: params.session_id, mode, user_id: params.user_id, ...(projectDir ? { project_dir: projectDir, cwd: projectDir } : {}) } })
    } catch (error) {
      yield failureFromError(error, signal)
    } finally {
      try { ws?.close() } catch { /* ignore */ }
    }
  }

  /** Remember that a session was cancelled (in-process map + mapping.lastCancelAt for persistence). */
  noteCancel(sessionId, mapping) {
    const now = Date.now()
    if (sessionId) this.recentCancels.set(sessionId, now)
    if (mapping) mapping.lastCancelAt = now
  }

  /** Wait out the post-cancel settle window for this session, if any. */
  async _settleAfterCancel(mapping, signal) {
    if (!(this.postCancelSettleMs > 0)) return
    const sid = mapping?.jiuwenSessionId
    const at = Math.max(this.recentCancels.get(sid) || 0, Number(mapping?.lastCancelAt) || 0)
    const wait = at + this.postCancelSettleMs - Date.now()
    if (wait <= 0) return
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait)
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }

  /** document.persist the chat's document items on the open socket; fail soft (keep originals). */
  async _persistDocuments(ws, params) {
    const items = Array.isArray(params.media_items) ? params.media_items : []
    const docs = items.filter(x => x?.type === 'document')
    if (!docs.length) return params
    try {
      const r = await this._unary(ws, MEDIA.DOCUMENT_PERSIST, { session_id: params.session_id, documents: docs }, 30_000)
      const stored = (Array.isArray(r?.media_items) ? r.media_items : []).filter(x => x?.type === 'document' && x.path)
      if (!stored.length) return params
      return { ...params, media_items: [...items.filter(x => x?.type !== 'document'), ...stored], ...(r?.files ? { files: { ...(params.files || {}), ...r.files } } : {}) }
    } catch {
      return params
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
  /**
   * history.get on JiuwenSwarm ≥0.2.7 only acks (`{accepted:true}`) and streams the page as
   * `history.message` events (page_idx is 1-based, newest first; a final `{status:'done'}` frame).
   * Collect one page, reassemble `_part` splits, return `{ messages }` oldest → newest.
   */
  async historyMessages(sessionId, { page_idx = 1, timeoutMs = 20_000, ...extra } = {}) {
    if (!this.WebSocketImpl) throw Object.assign(new Error('WebSocket unavailable'), { code: 'TRANSPORT' })
    const ws = await this._connect(buildGatewayWsUrl(this.gatewayURL, this.auth))
    try {
      await this._awaitAck(ws, Math.min(15_000, this.requestTimeoutMs))
      const id = `rpc-${randomUUID()}`
      const records = []
      const parts = new Map()
      const meta = {}
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); records.length ? resolve() : reject(Object.assign(new Error('RPC history.get timed out'), { code: 'TIMEOUT' })) }, timeoutMs)
        const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', onMessage) }
        const onMessage = (event) => {
          let f
          try { f = JSON.parse(String(event.data)) } catch { return }
          if (f.type === 'res' && f.id === id) {
            if (f.ok === false) { cleanup(); reject(Object.assign(new Error(JSON.stringify(f.error || f.payload || f)), { code: 'TRANSPORT' })) }
            return
          }
          if (f.type !== 'event') return
          const p = f.payload || {}
          if (f.event === 'chat.error' && (!p.request_id || p.request_id === id)) {
            cleanup()
            if (/history not found/i.test(String(p.error || ''))) resolve()
            else reject(Object.assign(new Error(String(p.error || 'history.get failed')), { code: 'TRANSPORT' }))
            return
          }
          if (f.event !== 'history.message') return
          if (p.status === 'done' || p.status === 'error') {
            Object.assign(meta, { total_pages: p.total_pages, page_idx: p.page_idx, has_more: p.has_more, next_cursor: p.next_cursor })
            cleanup()
            if (p.status === 'error') reject(Object.assign(new Error(String(p.error || 'history.get failed')), { code: p.code || 'TRANSPORT' }))
            else resolve()
            return
          }
          const m = p.message
          if (!m || typeof m !== 'object') return
          const part = m._part
          if (part && part.record_id) {
            const slot = parts.get(part.record_id) || { m: { ...m }, chunks: [] }
            slot.chunks[part.part_idx] = String(m.content ?? '')
            if (!parts.has(part.record_id)) { parts.set(part.record_id, slot); records.push(slot.m) }
            if (slot.chunks.filter(x => x !== undefined).length === part.total_parts) { slot.m.content = slot.chunks.join(''); delete slot.m._part }
            return
          }
          records.push(m)
        }
        ws.addEventListener('message', onMessage)
        ws.send(JSON.stringify({ type: 'req', id, method: HISTORY.GET, params: { session_id: sessionId, page_idx, ...extra } }))
      })
      return { ...meta, records, messages: records.slice().reverse() }
    } finally {
      try { ws.close() } catch { /* ignore */ }
    }
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
    this.noteCancel(sessionId)
    return this.rpc(CHAT.CANCEL, { session_id: sessionId, ...extra })
  }
  swarmflowPause(sessionId, extra = {}) {
    return this.rpc(SWARM.PAUSE, { session_id: sessionId, ...extra })
  }
  swarmflowResume(sessionId, extra = {}) {
    return this.rpc(SWARM.RESUME, { session_id: sessionId, ...extra })
  }
  chatInterrupt(sessionId, intent = 'cancel', extra = {}) {
    if (intent === 'cancel') this.noteCancel(sessionId)
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
  // 0.2.7 AgentServer reads source_session_id (session_id kept for older Gateways).
  sessionFork(sessionId, extra = {}) { return this.rpc(SESSION.FORK, { session_id: sessionId, source_session_id: sessionId, ...extra }) }
  sessionRename(sessionId, title, extra = {}) {
    return this.rpc(SESSION.RENAME, { session_id: sessionId, title, ...extra })
  }
  sessionPin(sessionId, pinned, extra = {}) {
    return this.rpc(SESSION.PIN, { session_id: sessionId, pinned: Boolean(pinned), ...extra })
  }
  sessionSwitch(sessionId, extra = {}) {
    return this.rpc(SESSION.SWITCH, { session_id: sessionId, ...extra })
  }
  sessionArchive(sessionIds, extra = {}) {
    const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
    return this.rpc(SESSION.ARCHIVE, { session_ids: ids.filter(Boolean).map(String), ...extra })
  }
  sessionUnarchive(sessionIds, extra = {}) {
    const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
    return this.rpc(SESSION.UNARCHIVE, { session_ids: ids.filter(Boolean).map(String), ...extra })
  }
  skillsList(extra = {}) { return this.rpc(SKILLS.LIST, { ...extra }) }
  skillsInstalled(extra = {}) { return this.rpc(SKILLS.INSTALLED, { ...extra }) }
  skillsToggle(name, enabled, extra = {}) {
    return this.rpc(SKILLS.TOGGLE, { name, enabled: Boolean(enabled), ...extra })
  }
  agentsList(extra = {}) { return this.rpc(AGENTS.LIST, { ...extra }) }
  teamTemplatesList(extra = {}) { return this.rpc(TEAM.TEMPLATES_LIST, { ...extra }) }
  teamList(extra = {}) { return this.rpc(TEAM.LIST, { ...extra }) }
  commandsList(extra = {}) { return this.rpc(COMMANDS.LIST, { ...extra }) }
  compact(sessionId, extra = {}) { return this.rpc(COMMANDS.COMPACT, { session_id: sessionId, ...extra }) }
  goal(sessionId, { action, objective, ...extra } = {}) {
    return this.rpc(COMMANDS.GOAL, {
      session_id: sessionId,
      ...(action !== undefined ? { action } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...extra,
    })
  }
  btw(sessionId, question, extra = {}) {
    return this.rpc(COMMANDS.BTW, { session_id: sessionId, question, ...extra })
  }
  recap(sessionId, extra = {}) {
    return this.rpc(COMMANDS.RECAP, { session_id: sessionId, ...extra })
  }
  planStatus(sessionId, extra = {}) {
    return this.rpc(SESSION.PLAN_STATUS, { session_id: sessionId, ...extra })
  }
  workflows(sessionId, action = 'list', extra = {}) {
    return this.rpc(SWARM.WORKFLOWS, { session_id: sessionId, action, ...extra })
  }
  modelsGet(modelId, extra = {}) {
    return this.rpc(MODELS.GET, { model_id: modelId, ...extra })
  }

  agentsToolsList(extra = {}) { return this.rpc(AGENTS.TOOLS_LIST, { ...extra }) }
  hooksList(extra = {}) { return this.rpc(SYSTEM.HOOKS_LIST, { ...extra }) }
  permissionsToolsGet(extra = {}) { return this.rpc(SYSTEM.PERMISSIONS_TOOLS_GET, { ...extra }) }
  permissionsToolsUpdate(tool, level, extra = {}) {
    return this.rpc(SYSTEM.PERMISSIONS_TOOLS_UPDATE, { tool, level, ...extra })
  }
  permissionsToolsDelete(tool, extra = {}) {
    return this.rpc(SYSTEM.PERMISSIONS_TOOLS_DELETE, { tool, ...extra })
  }
  permissionsRulesGet(extra = {}) { return this.rpc(SYSTEM.PERMISSIONS_RULES_GET, { ...extra }) }
  pluginsList(extra = {}) { return this.rpc(SYSTEM.PLUGINS_LIST, { ...extra }) }
  pluginsEnable(name, extra = {}) { return this.rpc(SYSTEM.PLUGINS_ENABLE, { name, ...extra }) }
  pluginsDisable(name, extra = {}) { return this.rpc(SYSTEM.PLUGINS_DISABLE, { name, ...extra }) }
  projectList(extra = {}) { return this.rpc(SYSTEM.PROJECT_LIST, { ...extra }) }
  projectInfo(projectId, extra = {}) {
    return this.rpc(SYSTEM.PROJECT_INFO, { ...(projectId ? { project_id: projectId } : {}), ...extra })
  }
  projectGetSessions(projectId, extra = {}) {
    return this.rpc(SYSTEM.PROJECT_GET_SESSIONS, { ...(projectId ? { project_id: projectId } : {}), ...extra })
  }
  sessionArchivedList(extra = {}) { return this.rpc(SYSTEM.SESSION_ARCHIVED_LIST, { ...extra }) }
  sessionAssetsList(sessionId, extra = {}) { return this.rpc(SYSTEM.SESSION_ASSETS_LIST, { session_id: sessionId, ...extra }) }
  updaterStatus(extra = {}) { return this.rpc(SYSTEM.UPDATER_STATUS, { ...extra }) }
  heartbeatConf(extra = {}) { return this.rpc(SYSTEM.HEARTBEAT_GET_CONF, { ...extra }) }
  heartbeatSetConf(conf = {}, extra = {}) { return this.rpc(SYSTEM.HEARTBEAT_SET_CONF, { ...conf, ...extra }) }
  heartbeatJobList(extra = {}) { return this.rpc(SYSTEM.HEARTBEAT_JOB_LIST, { ...extra }) }
  pathGet(extra = {}) { return this.rpc(SYSTEM.PATH_GET, { ...extra }) }
  localeGetConf(extra = {}) { return this.rpc(SYSTEM.LOCALE_GET_CONF, { ...extra }) }
  cronJobList(extra = {}) { return this.rpc(SYSTEM.CRON_JOB_LIST, { ...extra }) }
  updaterCheck(extra = {}) { return this.rpc(SYSTEM.UPDATER_CHECK, { ...extra }, { timeoutMs: 60_000 }) }
  updaterConf(extra = {}) { return this.rpc(SYSTEM.UPDATER_GET_CONF, { ...extra }) }
  agentsGet(name, extra = {}) { return this.rpc(AGENTS.GET, { name, ...extra }) }
  skillsGet(name, extra = {}) { return this.rpc(SKILLS.GET, { name, ...extra }) }
  skillsVersionsList(name, extra = {}) { return this.rpc(SKILLS.VERSIONS_LIST, { name, ...extra }) }
  skillsMarketplaceList(extra = {}) { return this.rpc(SKILLS.MARKETPLACE_LIST, { ...extra }) }
  teamBindingsList(extra = {}) { return this.rpc(TEAM.BINDINGS_LIST, { ...extra }) }
  agentTemplatesList(extra = {}) { return this.rpc(SYSTEM.AGENT_TEMPLATES_LIST, { ...extra }) }

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
    let terminalFinal = false
    let lastActivity = Date.now()
    let usage
    let pendingQuestion = null
    let deadline = Date.now() + this.requestTimeoutMs
    /** chat.send ids of this turn (the original plus interrupt-resume sends). */
    const turnIds = new Set([requestId])
    /** True between answering an interaction and the first resumed output (ignore stale completion frames). */
    let resumePending = false
    const answeredIds = new Set()
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
    const marked = new Set()
    const mark1 = (n) => { if (!marked.has(n)) { marked.add(n); ctx.mark?.(n) } }
    const finish = function *(reason) {
      mark1('finish')
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
          const grace = terminalFinal ? this.terminalFinalGraceMs : this.finalGraceMs
          const waitMs = finalSeen ? Math.max(1, grace - (Date.now() - lastActivity)) : 1000
          let idle
          await new Promise((resolve) => {
            wake = resolve
            idle = setTimeout(resolve, Math.min(waitMs, Math.max(1, deadline - Date.now())))
          })
          clearTimeout(idle) // a pending idle timer would keep a short-lived host (dsh headless) alive up to 1 s
          wake = undefined
          if (queue.length === 0) {
            if (signal?.aborted) queue.push({ ok: false, abort: true })
            else if (finalSeen && Date.now() - lastActivity >= (terminalFinal ? this.terminalFinalGraceMs : this.finalGraceMs)) {
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
              this.noteCancel(ctx.mapping?.jiuwenSessionId, ctx.mapping)
              emitEvent({ type: 'interrupt', intent: 'cancel' })
              const runId = ctx.mapping?.swarmRunId
              if (this.swarmflowStopOnAbort && runId) {
                // chat.interrupt stops the turn; a SwarmFlow run keeps going without an explicit stop.
                ws.send(JSON.stringify({ type: 'req', id: `swarm-stop-${randomUUID()}`, method: SWARM.STOP, params: { session_id: ctx.mapping?.jiuwenSessionId, run_id: runId } }))
                emitEvent({ type: 'raw', event: 'swarmflow.stop', runId })
              }
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

        if (frame.type === 'res' && turnIds.has(frame.id) && frame.ok === false) {
          const err = frame.error || frame.payload || frame
          throw Object.assign(new Error(typeof err === 'string' ? err : JSON.stringify(err)), { code: 'TRANSPORT' })
        }
        if (frame.type === 'res') continue

        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {}
        const eventType = normalizeEventName(frame.event || payload.event_type)
        {
          // Remember the SwarmFlow run of this Jiuwen session (swarmflow.stop on abort, /jiuwen swarm-stop).
          const run = payload.run_id || payload.workflow_run_id || payload.swarmflow_meta?.run_id
          if (run && ctx.mapping && /swarm|workflow/i.test(`${eventType} ${payload.source || ''}`)) ctx.mapping.swarmRunId = String(run)
        }
        if (ctx.mark) {
          mark1('first-frame')
          if (eventType === EVENTS.REASONING) mark1('first-reasoning')
          else if (eventType === EVENTS.DELTA) mark1('first-delta')
          else if (eventType === EVENTS.FINAL) mark1(payload.content ? 'final' : 'terminal-final')
          else if (eventType === EVENTS.PROCESSING && payload.is_complete) mark1('status-complete')
        }
        const content = payload.content
        if (resumePending && (eventType === EVENTS.DELTA || eventType === EVENTS.REASONING || eventType === EVENTS.TOOL_CALL
          || ((eventType === EVENTS.FINAL || eventType === 'content') && typeof content === 'string' && content))) resumePending = false
        if (resumePending && (eventType === EVENTS.FINAL || eventType === 'content')) continue

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
            if (payload.is_complete === true && !resumePending && (finalSeen || text.body)) { yield *finish({ kind: 'stop' }); return }
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
          case EVENTS.ASK_USER:
          case EVENTS.PLAN_APPROVAL: {
            // Host-answered interaction (dsh user-questions / approval): reply on the same socket and keep streaming.
            if (typeof ctx.interact === 'function' && payload.request_id && answeredIds.has(payload.request_id)) continue // duplicate card for an answered request
            if (typeof ctx.interact === 'function') {
              let reply = null
              try { reply = await ctx.interact({ eventType, payload, signal }) } catch { reply = null }
              if (reply && Array.isArray(reply.answers) && !signal?.aborted) {
                const rid = payload.request_id
                const source = payload.source
                if (rid) answeredIds.add(rid)
                emitEvent({ type: 'interaction_answered', eventType, source, kind: reply.kind, outcome: reply.outcome, requestIdOfQuestion: rid, answers: reply.answers, raw: payload })
                const meta = payload.swarmflow_meta
                if (source === 'swarmflow_human' && meta?.correlation_id && this.swarmflowReply !== false) {
                  // SwarmFlow human turn: deliver the person's reply with chat.swarmflow_reply (not chat.user_answer).
                  const a0 = reply.answers[0] || {}
                  const answer = reply.answerText ?? (a0.custom_input || (a0.selected_options || []).join(', '))
                  ws.send(JSON.stringify({ type: 'req', id: `dsh-swarm-reply-${randomUUID()}`, method: CHAT.SWARMFLOW_REPLY, params: {
                    session_id: ctx.mapping?.jiuwenSessionId, run_id: meta.run_id, correlation_id: meta.correlation_id, answer,
                  } }))
                } else if (INTERRUPT_RESUME_SOURCES.has(source) && rid) {
                  const id = `dsh-resume-${randomUUID()}`
                  turnIds.add(id)
                  ws.send(JSON.stringify({ type: 'req', id, method: CHAT.SEND, is_stream: true, params: {
                    ...(ctx.resumeParams || {}), query: '', content: '', request_id: rid, answers: reply.answers, source, supports_user_interaction: true,
                  } }))
                } else {
                  ws.send(JSON.stringify({ type: 'req', id: `dsh-answer-${randomUUID()}`, method: CHAT.ANSWER, params: {
                    session_id: ctx.mapping?.jiuwenSessionId, request_id: rid, answers: reply.answers,
                  } }))
                }
                finalSeen = false; terminalFinal = false; resumePending = true
                deadline = Date.now() + this.requestTimeoutMs
                if (reply.note) yield *activity(this, reply.note)
                continue
              }
            }
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
            // JiuwenSwarm closes a turn with an empty, request-scoped chat.final (no final_mode) ~0.7 s
            // before processing_status{is_complete}; end on it after a short idle grace.
            if (content === '' && !payload.final_mode && turnIds.has(payload.request_id) && (finalSeen || text.body)) terminalFinal = true
            finalSeen = true
            continue
          }
          case EVENTS.STREAM_END:
            if (frame.id == null || turnIds.has(frame.id) || turnIds.has(frame.request_id)) {
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

export { CHAT, HISTORY, MEMORY, MODELS, MCP, FILES, MEDIA, SESSION, SWARM, SKILLS, AGENTS, TEAM, COMMANDS, SYSTEM, EVENTS }
