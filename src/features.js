/**
 * Gateway method feature detection. JiuwenSwarm builds differ in which methods `/ws` routes;
 * an `unknown method` answer is cached per Gateway URL so later calls fail fast (no socket) and
 * `/jiuwen help` can hide the subcommands that need them. Validation errors (`id is required`)
 * prove the method is routed and mark it supported.
 */
export const isUnknownMethod = e => /unknown method/i.test(String(e?.message || e))

export function unsupportedError(method) {
  return Object.assign(new Error(`unknown method: ${method} (not routed by this Gateway on /ws; cached)`), { code: 'UNSUPPORTED', method })
}

export function createFeatureCache() {
  /** @type {Map<string, Map<string, boolean>>} url → method → supported */
  const byUrl = new Map()
  const table = url => { let t = byUrl.get(url); if (!t) byUrl.set(url, t = new Map()); return t }
  const api = {
    /** true / false when known, undefined when never seen. */
    known(url, method) { return byUrl.get(url)?.get(method) },
    isUnsupported(url, method) { return byUrl.get(url)?.get(method) === false },
    mark(url, method, supported) { table(url).set(method, Boolean(supported)) },
    unsupported(url) { return [...(byUrl.get(url) || [])].filter(([, v]) => v === false).map(([k]) => k) },
    clear(url) { if (url) byUrl.delete(url); else byUrl.clear() },
    /** Wrap a raw `rpc(method, params, opts)` with the cache. */
    wrap(url, rawRpc) {
      return async (method, params, opts) => {
        if (api.isUnsupported(url, method)) throw unsupportedError(method)
        try {
          const r = await rawRpc(method, params, opts)
          api.mark(url, method, true)
          return r
        } catch (e) {
          if (isUnknownMethod(e)) api.mark(url, method, false)
          else if (e?.code === 'TRANSPORT' && !e.dropped && !/timed out|WebSocket failed|closed/i.test(String(e?.message))) api.mark(url, method, true)
          throw e
        }
      }
    },
    /** Probe once (empty params by default); resolves true/false, never throws. */
    async probe(url, rawRpc, method, params = {}) {
      const k = api.known(url, method)
      if (k !== undefined) return k
      try { await api.wrap(url, rawRpc)(method, params, { timeoutMs: 10_000 }); return true } catch (e) {
        if (isUnknownMethod(e)) return false
        return api.known(url, method) ?? false // transport failure: unknown → treat as unavailable for now, do not cache
      }
    },
  }
  return api
}
