/**
 * Persist DSH session/bot id ↔ Jiuwen session/agent id mappings.
 * File-backed JSON under $DSH_HOME/jiuwen-adapter/ (or config.mappingPath).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * @typedef {{
 *   dshSessionId: string,
 *   jiuwenSessionId: string,
 *   jiuwenAgentId?: string,
 *   botId?: string,
 *   modelName?: string,
 *   chatMode?: string,
 *   skills?: string[],
 *   agentTemplateName?: string,
 *   title?: string,
 *   updatedAt: string,
 * }} SessionMapping
 */

export class SessionStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path
    /** @type {Map<string, SessionMapping>} */
    this.byDsh = new Map()
    /** @type {Map<string, SessionMapping>} */
    this.byJiuwen = new Map()
    this._load()
  }

  /** @param {string} dshSessionId */
  get(dshSessionId) {
    return this.byDsh.get(dshSessionId)
  }

  /**
   * Resolve or create a Jiuwen session id for a DSH session.
   * @param {string} dshSessionId
   * @param {{ botId?: string, preferredJiuwenId?: string }} [opts]
   */
  ensure(dshSessionId, opts = {}) {
    if (!dshSessionId) throw new Error('session-store: dshSessionId required')
    const existing = this.byDsh.get(dshSessionId)
    if (existing) {
      if (opts.botId && existing.botId !== opts.botId) {
        existing.botId = opts.botId
        existing.updatedAt = new Date().toISOString()
        this._save()
      }
      return existing
    }
    const mapping = {
      dshSessionId,
      jiuwenSessionId: opts.preferredJiuwenId || `dsh-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ...(opts.botId ? { botId: opts.botId } : {}),
      updatedAt: new Date().toISOString(),
    }
    this._put(mapping)
    this._save()
    return mapping
  }

  /** Patch persisted per-session options (e.g. modelName); undefined deletes a key. */
  update(dshSessionId, patch = {}) {
    const mapping = this.ensure(dshSessionId)
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete mapping[k]; else mapping[k] = v }
    mapping.updatedAt = new Date().toISOString()
    this._put(mapping)
    this._save()
    return mapping
  }

  /** Drop a mapping from both indexes and persist (local unmap; does not call Gateway). */
  remove(dshSessionId) {
    const mapping = this.byDsh.get(dshSessionId)
    if (!mapping) return false
    this.byDsh.delete(dshSessionId)
    if (mapping.jiuwenSessionId) this.byJiuwen.delete(mapping.jiuwenSessionId)
    this._save()
    return true
  }

  /**
   * Record an agent id after Gateway creates/binds one.
   * @param {string} dshSessionId
   * @param {string} jiuwenAgentId
   */
  setAgentId(dshSessionId, jiuwenAgentId) {
    const mapping = this.ensure(dshSessionId)
    mapping.jiuwenAgentId = jiuwenAgentId
    mapping.updatedAt = new Date().toISOString()
    this._put(mapping)
    this._save()
    return mapping
  }

  /**
   * Record a completed turn (session continuity: later turns send only the new user message).
   * @param {string} dshSessionId
   * @param {{ requestId?: string, pendingQuestion?: object | null }} [extra]
   */
  recordTurn(dshSessionId, extra = {}) {
    const mapping = this.byDsh.get(dshSessionId)
    if (!mapping) return undefined
    mapping.turns = (mapping.turns || 0) + 1
    if (extra.requestId) mapping.lastRequestId = extra.requestId
    if (extra.pendingQuestion !== undefined) {
      if (extra.pendingQuestion) mapping.pendingQuestion = extra.pendingQuestion
      else delete mapping.pendingQuestion
    }
    mapping.updatedAt = new Date().toISOString()
    this._save()
    return mapping
  }

  /** @returns {SessionMapping[]} */
  list() {
    return [...this.byDsh.values()]
  }

  clear() {
    this.byDsh.clear()
    this.byJiuwen.clear()
    this._save()
  }

  _put(mapping) {
    this.byDsh.set(mapping.dshSessionId, mapping)
    this.byJiuwen.set(mapping.jiuwenSessionId, mapping)
  }

  _load() {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const entries = Array.isArray(raw?.mappings) ? raw.mappings : Array.isArray(raw) ? raw : []
      for (const entry of entries) {
        if (!entry?.dshSessionId || !entry?.jiuwenSessionId) continue
        this._put({
          dshSessionId: String(entry.dshSessionId),
          jiuwenSessionId: String(entry.jiuwenSessionId),
          ...(entry.jiuwenAgentId ? { jiuwenAgentId: String(entry.jiuwenAgentId) } : {}),
          ...(entry.botId ? { botId: String(entry.botId) } : {}),
          ...(Number.isFinite(entry.turns) ? { turns: entry.turns } : {}),
          ...(Number.isFinite(entry.lastCancelAt) ? { lastCancelAt: entry.lastCancelAt } : {}),
          ...(entry.lastRequestId ? { lastRequestId: String(entry.lastRequestId) } : {}),
          ...(entry.pendingQuestion ? { pendingQuestion: entry.pendingQuestion } : {}),
          ...(entry.modelName ? { modelName: String(entry.modelName) } : {}),
          ...(entry.chatMode ? { chatMode: String(entry.chatMode) } : {}),
          ...(Array.isArray(entry.skills) ? { skills: entry.skills.map(String) } : {}),
          ...(entry.agentTemplateName ? { agentTemplateName: String(entry.agentTemplateName) } : {}),
          ...(entry.title ? { title: String(entry.title) } : {}),
          ...(entry.swarmRunId ? { swarmRunId: String(entry.swarmRunId) } : {}),
          updatedAt: String(entry.updatedAt || new Date().toISOString()),
        })
      }
    } catch (error) {
      // Corrupt / truncated / non-JSON store must not crash plugin load — start empty and
      // overwrite on the next successful save. Callers can inspect `loadError`.
      this.loadError = error
      this.byDsh.clear()
      this.byJiuwen.clear()
    }
  }

  _save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      mappings: this.list(),
    }
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.path)
  }
}
