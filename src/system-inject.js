/**
 * injectSystem: forward the host system prompt (or only its FlyBot persona part) to Jiuwen once per
 * mapped session, as a prefixed block on the query. Jiuwen chat.send has no system field.
 * Every helper fails soft: on any error the caller sends the plain query (old behaviour).
 */
import { createHash } from 'node:crypto'
import { contentToText } from './messages.js'

export const SYSTEM_OPEN = '[System instructions from host]'
export const SYSTEM_CLOSE = '[/System]'
export const SYSTEM_MAX_BYTES = 8 * 1024

/** Latest system text: in-history system/developer messages win over options.system. */
export function latestSystemText(options) {
  const msgs = Array.isArray(options?.messages) ? options.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const role = m?.role || (m?.source?.kind === 'system-prompt' ? 'system' : undefined)
    if (role === 'system' || role === 'developer') {
      const t = contentToText(m.content).trim()
      if (t) return t
    }
  }
  return typeof options?.system === 'string' ? options.system.trim() : ''
}

// FlyBot top-level sections we keep for 'persona' (core/src/host/prompt.js, groups.js).
const PERSONA_H1 = [/^# Your identity\s*$/, /^# This group chat\s*$/]
// FlyBot team/tool rules inside the identity section: everything from here on is host tooling.
const IDENTITY_STOP = /^## (How your Bot team works|You are the Main Bot)\s*$/
const LANGUAGE_LINE = /^- Reply in the user's language\.\s*$/m

/** Persona/instructions/group/language part of a FlyBot system prompt ('' when no markers found). */
export function extractPersona(system) {
  const lines = String(system || '').split('\n')
  const parts = []
  let cur = null
  const flush = () => { if (cur) { const t = cur.join('\n').trim(); if (t) parts.push(t) } cur = null }
  let stopped = false
  for (const line of lines) {
    if (/^# /.test(line)) {
      flush(); stopped = false
      if (PERSONA_H1.some(r => r.test(line))) cur = [line]
      continue
    }
    if (!cur || stopped) continue
    if (IDENTITY_STOP.test(line)) { stopped = true; continue }
    cur.push(line)
  }
  flush()
  if (!parts.length) return ''
  if (LANGUAGE_LINE.test(system)) parts.push("Reply in the user's language.")
  return parts.join('\n\n')
}

export function capBytes(text, max = SYSTEM_MAX_BYTES) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  return `${buf.subarray(0, max - 20).toString('utf8').replace(/\uFFFD+$/, '')}\n…[truncated]`
}

export function systemHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * @returns {{ query: string, hash?: string }} query with the block prefixed when it is new for
 * this mapping (hash differs from mapping.systemHash); otherwise the query unchanged.
 */
export function applySystemInjection(query, options, mapping, mode) {
  try {
    if (mode !== 'persona' && mode !== 'full') return { query }
    const sys = latestSystemText(options)
    if (!sys) return { query }
    const body = mode === 'full' ? sys : extractPersona(sys)
    if (!body) return { query }
    const capped = capBytes(body)
    const hash = systemHash(`${mapping?.jiuwenSessionId || ''}\n${mode}\n${capped}`)
    if (mapping?.systemHash === hash) return { query }
    return { query: `${SYSTEM_OPEN}\n${capped}\n${SYSTEM_CLOSE}\n\n${query}`, hash }
  } catch {
    return { query }
  }
}
