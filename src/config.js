/**
 * Adapter configuration. Env wins over Cordis plugin config for deployment knobs.
 *
 * Architecture (see ARCHITECTURE.md):
 *   JiuwenSwarm owns chat loop, tools, memory, sessions, models.
 *   DSH is Cordis plugin ABI / shell only.
 *
 * Modes:
 *   gateway — DEFAULT. WebSocket chat.send; full Jiuwen agent/swarm turn.
 *   openai  — diagnostics / connectivity fallback only (not the product brain).
 */

const DEFAULT_MODELS = [
  { id: 'jiuwen-default', name: 'Jiuwen Default', contextWindow: 128_000, maxTokens: 8192 },
  { id: 'jiuwen-swarm', name: 'Jiuwen Swarm', contextWindow: 128_000, maxTokens: 8192 },
]

/** @typedef {{
 *   provider: string,
 *   displayName: string,
 *   mode: 'openai' | 'gateway',
 *   brainOwnership: 'jiuwen',
 *   baseURL: string,
 *   gatewayURL: string,
 *   apiKey: string | undefined,
 *   apiKeyEnv: string,
 *   authToken: string | undefined,
 *   accessToken: string | undefined,
 *   cookie: string | undefined,
 *   authorization: string | undefined,
 *   xToken: string | undefined,
 *   userId: string,
 *   defaultModel: string,
 *   models: Array<{id:string,name:string,contextWindow?:number,maxTokens?:number}>,
 *   mappingPath: string,
 *   workMode: string,
 *   projectDir: string | undefined,
 *   requestTimeoutMs: number,
 *   allowDshAgentLoop: boolean,
 *   exposeJiuwenTools: boolean,
 *   surfaceGatewayToolEvents: boolean,
 *   compat: string,
 *   llmAdapterModule: string | undefined,
 * }} ResolvedConfig */

/**
 * @param {Record<string, unknown>} [raw]
 * @param {{ env?: NodeJS.ProcessEnv, dshHome?: string }} [opts]
 * @returns {ResolvedConfig}
 */
export function resolveConfig(raw = {}, opts = {}) {
  const env = opts.env ?? process.env
  // Product default is gateway (Jiuwen brain). openai only if explicitly requested.
  const modeRaw = String(env.JIUWEN_MODE || raw.mode || 'gateway').toLowerCase()
  const mode = modeRaw === 'openai' || modeRaw === 'llm' || modeRaw === 'completions'
    ? 'openai'
    : 'gateway'

  const apiKeyEnv = String(raw.apiKeyEnv || 'JIUWEN_API_KEY')
  const apiKey = firstNonEmpty(
    env.JIUWEN_API_KEY,
    env[apiKeyEnv],
    typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
  )
  const authToken = firstNonEmpty(env.JIUWEN_AUTH_TOKEN, typeof raw.authToken === 'string' ? raw.authToken : undefined)
  const accessToken = firstNonEmpty(env.JIUWEN_ACCESS_TOKEN, typeof raw.accessToken === 'string' ? raw.accessToken : undefined, authToken)
  const cookie = firstNonEmpty(env.JIUWEN_COOKIE, typeof raw.cookie === 'string' ? raw.cookie : undefined)
  const authorization = firstNonEmpty(env.JIUWEN_AUTHORIZATION, typeof raw.authorization === 'string' ? raw.authorization : undefined)
  const xToken = firstNonEmpty(env.JIUWEN_X_TOKEN, typeof raw.xToken === 'string' ? raw.xToken : undefined)

  const dshHome = opts.dshHome || env.DSH_HOME || env.HOME || process.cwd()
  const mappingPath = String(
    raw.mappingPath
    || env.JIUWEN_SESSION_MAP
    || `${dshHome}/jiuwen-adapter/session-map.json`,
  )

  const models = Array.isArray(raw.models) && raw.models.length > 0
    ? raw.models.map(normalizeModel)
    : DEFAULT_MODELS.map(m => ({ ...m }))

  const allowDshAgentLoop = env.JIUWEN_ALLOW_DSH_AGENT_LOOP === '1'
    || raw.allowDshAgentLoop === true

  return {
    provider: String(raw.provider || 'jiuwen'),
    displayName: String(raw.displayName || 'JiuwenSwarm'),
    mode,
    brainOwnership: 'jiuwen',
    baseURL: stripTrailingSlash(String(
      env.JIUWEN_BASE_URL
      || raw.baseURL
      || 'http://127.0.0.1:18080/v1',
    )),
    gatewayURL: String(
      env.JIUWEN_GATEWAY_URL
      || raw.gatewayURL
      || 'ws://127.0.0.1:19000/ws',
    ),
    apiKey,
    apiKeyEnv,
    authToken,
    accessToken,
    cookie,
    authorization,
    xToken,
    userId: String(env.JIUWEN_USER_ID || raw.userId || 'dsh-adapter'),
    defaultModel: String(raw.defaultModel || models[0]?.id || 'jiuwen-default'),
    models,
    mappingPath,
    workMode: String(raw.workMode || env.JIUWEN_WORK_MODE || 'agent'),
    projectDir: firstNonEmpty(env.JIUWEN_PROJECT_DIR, typeof raw.projectDir === 'string' ? raw.projectDir : undefined),
    requestTimeoutMs: Number(raw.requestTimeoutMs || env.JIUWEN_TIMEOUT_MS || 180_000),
    allowDshAgentLoop,
    exposeJiuwenTools: raw.exposeJiuwenTools === true || env.JIUWEN_EXPOSE_TOOLS === '1',
    surfaceGatewayToolEvents: raw.surfaceGatewayToolEvents !== false,
    /** 'auto' | 'none' | 'flybot' — optional host-compat glue (src/compat/). */
    compat: String(env.JIUWEN_COMPAT || raw.compat || 'auto').toLowerCase(),
    llmAdapterModule: firstNonEmpty(env.JIUWEN_LLM_ADAPTER_MODULE, typeof raw.llmAdapterModule === 'string' ? raw.llmAdapterModule : undefined),
  }
}

function normalizeModel(m) {
  const id = String(m.id || m.name || 'model')
  return {
    id,
    name: String(m.name || id),
    contextWindow: Number(m.contextWindow || 128_000),
    maxTokens: Number(m.maxTokens || 8192),
  }
}

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}
