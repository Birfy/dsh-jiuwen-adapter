/**
 * Tool policy under Jiuwen-owned brain (ARCHITECTURE.md).
 *
 * Product path (gateway / brainOwnership=jiuwen):
 *   - Never forward DSH tool schemas into a model call that DSH would execute.
 *   - Never emit DSH tool-call stream chunks from Gateway (would re-arm DSH loop).
 *   - Jiuwen runs tools inside its own agent turn.
 *
 * Diagnostics (openai + allowDshAgentLoop=true):
 *   - Explicitly opt into DSH-as-brain; forward schemas. Discouraged.
 *
 * exposeJiuwenTools: optional discovery of Jiuwen-side tool names for diagnostics.
 */

/**
 * @param {import('./config.js').ResolvedConfig} config
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
export function createToolBridge(config, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis)

  return {
    /**
     * Whether GenerateOptions.tools may be forwarded on the wire.
     * Only when explicitly allowing a DSH-owned agent loop on openai mode.
     */
    shouldForwardDshTools() {
      return config.mode === 'openai' && config.allowDshAgentLoop === true
    },

    /** True when this turn must not let DSH execute tools. */
    jiuwenOwnsTools() {
      return config.brainOwnership === 'jiuwen' && !this.shouldForwardDshTools()
    },

    /**
     * Best-effort discovery of Jiuwen-side tools for diagnostics.
     * @returns {Promise<{ ok: boolean, tools?: Array<{name:string,description?:string}>, error?: string }>}
     */
    async listJiuwenTools() {
      if (!config.exposeJiuwenTools) {
        return { ok: false, error: 'exposeJiuwenTools is disabled' }
      }
      if (!fetchImpl) return { ok: false, error: 'fetch unavailable' }
      const candidates = [
        `${config.baseURL.replace(/\/v1$/, '')}/mcp/tools`,
        `${config.baseURL}/tools`,
        `${config.baseURL}/models`,
      ]
      for (const url of candidates) {
        try {
          const headers = {}
          if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
          const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) })
          if (!response.ok) continue
          const json = await response.json()
          const list = Array.isArray(json?.tools) ? json.tools
            : Array.isArray(json?.data) ? json.data
              : Array.isArray(json) ? json : null
          if (!list) continue
          return {
            ok: true,
            tools: list.map(t => ({
              name: String(t.name || t.id || 'tool'),
              ...(t.description ? { description: String(t.description) } : {}),
            })),
          }
        } catch {
          // try next
        }
      }
      return { ok: false, error: 'no Jiuwen tools endpoint responded' }
    },
  }
}
