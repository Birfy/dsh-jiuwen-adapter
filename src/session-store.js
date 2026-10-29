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
          updatedAt: String(entry.updatedAt || new Date().toISOString()),
        })
      }
    } catch (error) {
      throw new Error(`session-store: failed to read ${this.path}: ${error.message}`)
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
