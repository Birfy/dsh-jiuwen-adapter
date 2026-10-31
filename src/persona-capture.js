/**
 * Generic persona source for `injectSystem: persona` on plain dsh (no FlyBot markers).
 * Observes the public `system-prompt/assemble` waterfall and remembers, per dsh session, the text of
 * the named persona sections (dsh-system-prompt `personaPrefix/Suffix`, dsh-persona rows).
 * Read-only: the listener returns the downstream assembly untouched, so other plugins are unaffected.
 */
export const PERSONA_SECTIONS = Object.freeze(['deployment:persona-prefix', 'deployment:persona-suffix'])
const MAX_ENTRIES = 512

export function personaFromAssembly(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const parts = []
  for (const name of PERSONA_SECTIONS) {
    const s = sections.find(x => x?.name === name)
    const t = typeof s?.text === 'string' ? s.text.trim() : ''
    if (t) parts.push(t)
  }
  return parts.join('\n\n')
}

export function createPersonaCapture(ctx, logger) {
  const map = new Map()
  let off
  const record = (id, text) => {
    map.delete(id)
    map.set(id, text)
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value)
  }
  try {
    if (typeof ctx?.on === 'function') {
      off = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const result = await next()
        try {
          const id = context?.agent?.session?.id ?? context?.agent?.id
          if (id !== undefined && id !== null) record(String(id), personaFromAssembly(result))
        } catch { /* observe only */ }
        return result
      })
    }
  } catch (error) {
    logger?.debug?.(`[dsh-jiuwen] persona capture unavailable: ${error?.message || error}`)
  }
  return {
    get: id => map.get(String(id)),
    forget: id => { map.delete(String(id)) },
    record,
    dispose: () => { try { if (typeof off === 'function') off() } catch { /* ignore */ } map.clear() },
  }
}
