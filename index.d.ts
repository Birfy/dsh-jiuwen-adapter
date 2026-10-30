/**
 * Types for @dsh-jiuwen/adapter: the `jiuwen/event` Cordis event and the `ctx.jiuwenAdapter` helper service.
 * Every event also carries `dshSessionId` (host session), `sessionId` (Jiuwen session) and `requestId` (chat.send id).
 */
export declare const JIUWEN_EVENT: 'jiuwen/event'
/** Typed event names (emitted only when config.typedEvents is on; `jiuwen/event` is always emitted). */
export declare const JIUWEN_TYPED_EVENTS: {
  readonly tool: 'jiuwen/tool'
  readonly plan: 'jiuwen/plan'
  readonly approval: 'jiuwen/approval'
  readonly swarm: 'jiuwen/swarm'
}

interface JiuwenEventBase {
  readonly dshSessionId?: string
  readonly sessionId?: string
  readonly requestId?: string
  /** Original Jiuwen payload (shape owned by JiuwenSwarm; may change between versions). */
  readonly raw?: unknown
}

export type JiuwenEvent = JiuwenEventBase & (
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; name: string; id?: string; arguments?: unknown }
  | { type: 'tool_update'; name?: string; id?: string; status?: string }
  | { type: 'tool_result'; name?: string; id?: string; success?: boolean; result?: string }
  | { type: 'subtask_update' | 'subagent_activity' | 'todo.updated' | 'team.task' | 'team.member' | 'team.message'; summary: string }
  | { type: 'processing_status'; isProcessing?: boolean; isComplete?: boolean }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; model?: string }
  | { type: 'media' | 'file'; name: string; path?: string; url?: string }
  | { type: 'ask_user'; questions: unknown[] }
  | { type: 'interaction_answered'; eventType: string; source?: string; kind: 'question' | 'approval'; outcome?: string; requestIdOfQuestion?: string; answers: unknown[] }
  | { type: 'error'; message: string }
  | { type: 'interrupt'; intent: 'cancel' }
  | { type: 'interrupt_result' }
  /** Any other Jiuwen event, by normalized name (e.g. context.usage, chat.output_phase, task.global_running). */
  | { type: 'raw'; event: string }
)

export type JiuwenToolEvent = JiuwenEvent & { type: 'tool_call' | 'tool_update' | 'tool_result' }
export type JiuwenApprovalEvent = JiuwenEventBase & (
  | { type: 'ask_user'; questions: unknown[] }
  | { type: 'interaction_answered'; eventType: string; source?: string; kind: 'question' | 'approval' | 'swarmflow'; outcome?: string; requestIdOfQuestion?: string; answers: unknown[] }
)
export type JiuwenPlanEvent = JiuwenEventBase & { type: 'plan'; event: string; inPlan?: boolean; status?: string }
export type JiuwenSwarmEvent = JiuwenEventBase & { type: 'swarm'; event: string; runId?: string; summary?: string }

/** Plugin config. Unknown or misspelled keys are reported as warnings at load (never thrown). */
export interface JiuwenAdapterConfig {
  accessToken?: string
  agentGroupName?: string
  agentTemplateName?: string
  allowDshAgentLoop?: boolean
  /** @deprecated Put the key in an environment variable and set `apiKeyEnv`. */
  apiKey?: string
  apiKeyEnv?: string
  approvalTimeoutMs?: number
  authToken?: string
  authorization?: string
  baseURL?: string
  chatMode?: string
  commandName?: string
  compactionMode?: string
  cookie?: string
  defaultModel?: string
  discoveryNamespace?: string
  discoveryPrefix?: string
  displayName?: string
  documentPersist?: boolean
  emitUsage?: boolean
  eventDisplay?: string
  exposeJiuwenTools?: boolean
  finalGraceMs?: number
  forwardModelName?: boolean
  forwardReasoning?: boolean
  gatewayURL?: string
  historyMode?: string
  /** Forward host system prompt once per Jiuwen session: off (default) | persona | full. */
  injectSystem?: 'off' | 'persona' | 'full'
  /** Jiuwen steps in reasoning: summary (default) | full (structured Markdown). */
  trajectoryDetail?: 'summary' | 'full'
  ignoreMessagePatterns?: Array<string | RegExp>
  interruptOnAbort?: boolean
  llmAdapterModule?: string
  mappingPath?: string
  mcpRpcTimeoutMs?: number
  mcpServerName?: string
  mcpStateDir?: string
  mode?: 'gateway' | 'openai'
  modelDiscovery?: boolean
  models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; chatMode?: string }>
  noUiAnswer?: boolean
  planBridge?: boolean
  postCancelSettleMs?: number
  projectDir?: string
  provider?: string
  questionTimeoutMs?: number
  recoverOnDrop?: boolean
  recoverWindowMs?: number
  registerCommands?: boolean
  requestTimeoutMs?: number
  serviceName?: string
  sessionSync?: boolean
  showProcessingStatus?: boolean
  skills?: string[]
  supportsUserInteraction?: boolean
  surfaceGatewayToolEvents?: boolean
  swarmflowReply?: string
  swarmflowStopOnAbort?: boolean
  terminalFinalGraceMs?: number
  titleMode?: string
  toolAllowlist?: string[]
  toolApproval?: string
  toolCallTimeoutMs?: number
  toolPassthrough?: boolean
  traceFile?: string
  typedEvents?: boolean
  userId?: string
  workMode?: string
  xToken?: string
}

export interface JiuwenAdapterService {
  readonly provider: string
  onEvent(listener: (event: JiuwenEvent) => void): () => void
  jiuwenSessionId(dshSessionId: string): string
  /** Run a `/jiuwen` sub-command (e.g. 'status', 'models', 'model <name>') for a host session. */
  command(dshSessionId: string, input: string): Promise<string>
  gateway: Record<string, (...args: any[]) => Promise<any>> & {
    rpc(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any>
    /** Probe once (cached per Gateway URL) whether `/ws` routes a method. Never throws. */
    supports(method: string, params?: Record<string, unknown>): Promise<boolean>
    /** Methods cached as `unknown method` for the configured Gateway. */
    unsupported(): string[]
  }
  [key: string]: unknown
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'jiuwen/event'(event: JiuwenEvent): void
    'jiuwen/tool'(event: JiuwenToolEvent): void
    'jiuwen/plan'(event: JiuwenPlanEvent): void
    'jiuwen/approval'(event: JiuwenApprovalEvent): void
    'jiuwen/swarm'(event: JiuwenSwarmEvent): void
  }
  interface Context {
    jiuwenAdapter: JiuwenAdapterService
  }
}

export declare const name: string
export declare const inject: string[]
export declare function apply(ctx: any, config?: JiuwenAdapterConfig): void
export default apply
