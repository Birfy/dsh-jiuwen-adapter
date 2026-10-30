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
  { id: 'jiuwen-swarm', name: 'Jiuwen Swarm', contextWindow: 128_000, maxTokens: 8192, chatMode: 'team.work.normal' },
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
    /** ctx service name for the helper API (ctx.jiuwenAdapter). */
    serviceName: String(raw.serviceName || 'jiuwenAdapter'),
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
    // ── Gateway features ──
    /** How Jiuwen tool/subtask/status activity is shown: reasoning | markers | none */
    eventDisplay: pickEnum(env.JIUWEN_EVENT_DISPLAY || raw.eventDisplay, ['reasoning', 'markers', 'none'],
      raw.surfaceGatewayToolEvents === false ? 'none' : 'reasoning'),
    /** Forward Jiuwen chat.reasoning as reasoning-delta. */
    forwardReasoning: raw.forwardReasoning !== false && env.JIUWEN_FORWARD_REASONING !== '0',
    /** Show chat.processing_status (filtered by default; it is UI state, not content). */
    showProcessingStatus: raw.showProcessingStatus === true || env.JIUWEN_SHOW_PROCESSING_STATUS === '1',
    /** Emit a usage chunk from chat.usage_summary / usage_metadata. */
    emitUsage: raw.emitUsage !== false,
    /** gateway: after the first turn send only the newest user message (Jiuwen keeps history). transcript: always send recent transcript. */
    historyMode: pickEnum(env.JIUWEN_HISTORY_MODE || raw.historyMode, ['gateway', 'transcript'], 'gateway'),
    /** chat.send `mode` (e.g. agent.work.normal, agent.plan, agent.fast, code.normal, team). Defaults to workMode. */
    chatMode: firstNonEmpty(env.JIUWEN_CHAT_MODE, typeof raw.chatMode === 'string' ? raw.chatMode : undefined),
    agentTemplateName: firstNonEmpty(env.JIUWEN_AGENT_TEMPLATE, typeof raw.agentTemplateName === 'string' ? raw.agentTemplateName : undefined),
    agentGroupName: firstNonEmpty(env.JIUWEN_AGENT_GROUP, typeof raw.agentGroupName === 'string' ? raw.agentGroupName : undefined),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : (env.JIUWEN_SKILLS ? env.JIUWEN_SKILLS.split(',').map(x => x.trim()).filter(Boolean) : undefined),
    /** Forward model id as model_name (false → let Jiuwen use its default model). */
    forwardModelName: raw.forwardModelName !== false && env.JIUWEN_FORWARD_MODEL !== '0',
    /** Tell Jiuwen whether the host can answer ask_user questions (default false: Jiuwen proceeds on its own). */
    /**
     * Tell Jiuwen whether the host can answer ask_user questions: 'auto' (default: true when the host has
     * ctx.userQuestions) | true | false. Approvals are always routed to ctx.approval (deny when unavailable).
     */
    supportsUserInteraction: raw.supportsUserInteraction === true || env.JIUWEN_SUPPORTS_USER_INTERACTION === '1' ? true
      : (raw.supportsUserInteraction === false || env.JIUWEN_SUPPORTS_USER_INTERACTION === '0' ? false : 'auto'),
    /** Max wait for a dsh user-questions answer (ms; 0 = no limit). */
    questionTimeoutMs: Number(raw.questionTimeoutMs ?? env.JIUWEN_QUESTION_TIMEOUT_MS ?? 600_000),
    /** Max wait for a dsh approval decision before denying (ms). */
    approvalTimeoutMs: Number(raw.approvalTimeoutMs ?? env.JIUWEN_APPROVAL_TIMEOUT_MS ?? 300_000),
    /** dsh tools → Jiuwen: 'off' (default; Jiuwen uses only its own tools) | 'mcp' (serve allowlisted dsh tools as an MCP server registered in Jiuwen). */
    toolPassthrough: pickEnum(env.JIUWEN_TOOL_PASSTHROUGH || raw.toolPassthrough, ['off', 'mcp'], 'off'),
    /** Tool names (exact, prefix*, or '*') exposed when toolPassthrough=mcp. Empty = none. */
    toolAllowlist: Array.isArray(raw.toolAllowlist) ? raw.toolAllowlist.map(String) : (env.JIUWEN_TOOL_ALLOWLIST ? env.JIUWEN_TOOL_ALLOWLIST.split(',').map(x => x.trim()).filter(Boolean) : []),
    /** 'dsh' (default): every passthrough call needs ctx.approval allowed-once (deny when unavailable) | 'none'. */
    toolApproval: pickEnum(env.JIUWEN_TOOL_APPROVAL || raw.toolApproval, ['dsh', 'none'], 'dsh'),
    toolCallTimeoutMs: Number(raw.toolCallTimeoutMs ?? env.JIUWEN_TOOL_CALL_TIMEOUT_MS ?? 120_000),
    mcpServerName: String(raw.mcpServerName || env.JIUWEN_MCP_SERVER_NAME || 'dsh-tools'),
    /** Shared dir for the stable MCP proxy (schemas.json + ep-<pid>.json). Default ~/.cache/dsh-jiuwen/mcp/<mcpServerName>. */
    mcpStateDir: raw.mcpStateDir || env.JIUWEN_MCP_STATE_DIR || undefined,
    mcpRpcTimeoutMs: Number(raw.mcpRpcTimeoutMs ?? env.JIUWEN_MCP_RPC_TIMEOUT_MS ?? 30_000),
    /** Register the `/jiuwen` slash command on ctx.commands when available. */
    registerCommands: raw.registerCommands !== false && env.JIUWEN_REGISTER_COMMANDS !== '0',
    // ── P3 opt-in bridges (default OFF = previous behaviour) ──
    /** Advertise Jiuwen models.list in this provider's catalog as `<discoveryPrefix><model_name>` (+ llm.registerModelDiscovery). */
    modelDiscovery: raw.modelDiscovery === true || env.JIUWEN_MODEL_DISCOVERY === '1',
    discoveryNamespace: String(raw.discoveryNamespace || 'jiuwen'),
    discoveryPrefix: String(raw.discoveryPrefix || 'jiuwen-model:'),
    /** DSH session/created|disposed → local Jiuwen mapping upkeep (jiuwen sessions only). */
    sessionSync: raw.sessionSync === true || env.JIUWEN_SESSION_SYNC === '1',
    /** Jiuwen session.plan_status → ctx.planMode (jiuwen sessions only). */
    planBridge: raw.planBridge === true || env.JIUWEN_PLAN_BRIDGE === '1',
    /** Also emit typed jiuwen/tool | jiuwen/plan | jiuwen/approval | jiuwen/swarm events. */
    typedEvents: raw.typedEvents === true || env.JIUWEN_TYPED_EVENTS === '1',
    /** Slash command name (default 'jiuwen'); change it if another plugin already owns /jiuwen. */
    commandName: String(raw.commandName || env.JIUWEN_COMMAND_NAME || 'jiuwen').replace(/^\//, ''),
    /** Reply sent to Jiuwen when it asked but no dsh answerer exists. */
    noUiAnswer: String(raw.noUiAnswer || 'No interactive user is available. Proceed with your best judgment and state your assumptions.'),
    /** Cancel in-flight Jiuwen turn (chat.interrupt intent=cancel) when the host aborts. */
    interruptOnAbort: raw.interruptOnAbort !== false,
    /** On host abort also send swarmflow.stop for the last SwarmFlow run seen in that Jiuwen session. */
    swarmflowStopOnAbort: raw.swarmflowStopOnAbort !== false && env.JIUWEN_SWARMFLOW_STOP_ON_ABORT !== '0',
    /** Answer SwarmFlow human turns (source swarmflow_human) through ctx.approval + chat.swarmflow_reply. */
    swarmflowReply: raw.swarmflowReply !== false,
    /** Opt-in: pre-persist document attachments with document.persist before chat.send (jiuwen sessions only). */
    documentPersist: raw.documentPersist === true || env.JIUWEN_DOCUMENT_PERSIST === '1',
    /** Idle grace after chat.final before ending the turn (waits for usage / processing_status). */
    finalGraceMs: Number(raw.finalGraceMs ?? env.JIUWEN_FINAL_GRACE_MS ?? 1500),
    terminalFinalGraceMs: Number(raw.terminalFinalGraceMs ?? env.JIUWEN_TERMINAL_FINAL_GRACE_MS ?? 100),
    /** After a mid-turn Gateway drop, look for the turn's answer in Jiuwen history (history.get) and emit it, marked as recovered. */
    recoverOnDrop: (raw.recoverOnDrop ?? env.JIUWEN_RECOVER_ON_DROP ?? 'true') !== false && String(raw.recoverOnDrop ?? env.JIUWEN_RECOVER_ON_DROP ?? 'true') !== 'false',
    /** How long to keep polling history for the dropped turn's final answer. */
    recoverWindowMs: Number(raw.recoverWindowMs ?? env.JIUWEN_RECOVER_WINDOW_MS ?? 15_000),
    postCancelSettleMs: Number(raw.postCancelSettleMs ?? env.JIUWEN_POST_CANCEL_SETTLE_MS ?? 1000),
    /** Host auxiliary calls (GenerateOptions.purpose): session-title → 'local' (instant heuristic) | 'jiuwen'. */
    titleMode: pickEnum(env.JIUWEN_TITLE_MODE || raw.titleMode, ['local', 'jiuwen'], 'local'),
    /**
     * purpose=compaction: 'local' (default; local digest, no Jiuwen call) | 'local+jiuwen' (also send
     * command.compact to the mapped Jiuwen session) | 'jiuwen' (legacy: full Jiuwen turn in a throwaway session).
     */
    compactionMode: pickEnum(env.JIUWEN_COMPACTION_MODE || raw.compactionMode, ['local', 'local+jiuwen', 'jiuwen'], 'local'),
    /** User-message blocks matching these regexes are not forwarded (default: DSH runtime-context snapshot; Jiuwen has its own runtime). */
    ignoreMessagePatterns: (Array.isArray(raw.ignoreMessagePatterns) ? raw.ignoreMessagePatterns : ['^Current runtime context\\.'])
      .map(p => { try { return new RegExp(String(p), 'm') } catch { return null } }).filter(Boolean),
    /** Append JSONL trace of turns/events here (debugging). */
    traceFile: firstNonEmpty(env.JIUWEN_TRACE_FILE, typeof raw.traceFile === 'string' ? raw.traceFile : undefined),
    llmAdapterModule: firstNonEmpty(env.JIUWEN_LLM_ADAPTER_MODULE, typeof raw.llmAdapterModule === 'string' ? raw.llmAdapterModule : undefined),
  }
}

function pickEnum(value, allowed, fallback) {
  const v = String(value || '').toLowerCase()
  return allowed.includes(v) ? v : fallback
}

function normalizeModel(m) {
  const id = String(m.id || m.name || 'model')
  return {
    id,
    name: String(m.name || id),
    contextWindow: Number(m.contextWindow || 128_000),
    maxTokens: Number(m.maxTokens || 8192),
    // Optional Jiuwen-side routing for this catalog entry.
    ...(m.modelName ? { modelName: String(m.modelName) } : {}),
    ...(m.chatMode ? { chatMode: String(m.chatMode) } : (id === 'jiuwen-swarm' ? { chatMode: 'team.work.normal' } : {})),
    ...(m.agentTemplateName ? { agentTemplateName: String(m.agentTemplateName) } : {}),
    ...(m.agentGroupName ? { agentGroupName: String(m.agentGroupName) } : {}),
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
