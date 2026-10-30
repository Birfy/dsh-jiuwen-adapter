/**
 * Opt-in (default OFF) bridges between Jiuwen and DSH-native services. Every hook early-returns for
 * sessions that do not use this adapter's provider and never throws into the host.
 */
import { JIUWEN_TYPED_EVENTS } from './typed-events.js'

/** Classify a `jiuwen/event` into a typed `jiuwen/*` event: [name, payload] or null. */
export function typedEventFor(e) {
  if (!e || typeof e !== 'object') return null
  const t = e.type
  if (t === 'tool_call' || t === 'tool_update' || t === 'tool_result') return [JIUWEN_TYPED_EVENTS.tool, e]
  if (t === 'ask_user' || t === 'interaction_answered') return [JIUWEN_TYPED_EVENTS.approval, e]
  const name = String(e.event || t || '')
  const base = { dshSessionId: e.dshSessionId, sessionId: e.sessionId, requestId: e.requestId, raw: e.raw }
  if (/(^|\.)plan(\.|_|$)|plan_status|approval_required/i.test(name)) {
    return [JIUWEN_TYPED_EVENTS.plan, { ...base, type: 'plan', event: name, ...(e.raw?.in_plan !== undefined ? { inPlan: Boolean(e.raw.in_plan) } : {}), ...(e.raw?.status ? { status: String(e.raw.status) } : {}) }]
  }
  if (/swarm|workflow|subtask|subagent|^team\./i.test(name)) {
    const runId = e.runId || e.raw?.run_id || e.raw?.workflow_run_id || e.raw?.swarmflow_meta?.run_id
    return [JIUWEN_TYPED_EVENTS.swarm, { ...base, type: 'swarm', event: name, ...(runId ? { runId: String(runId) } : {}), ...(e.summary ? { summary: e.summary } : {}) }]
  }
  return null
}

/** Best-effort: does this DSH session use `provider`? (header config, or an existing local mapping). */
export function sessionUsesProvider(session, provider, sessions) {
  try {
    const id = session?.id != null ? String(session.id) : undefined
    const p = session?.header?.config?.provider ?? session?.requestHeader?.config?.provider ?? session?.config?.provider ?? session?.provider
    if (p !== undefined) return p === provider
    return Boolean(id && sessions?.get?.(id))
  } catch { return false }
}

/**
 * sessionSync: DSH session lifecycle → Jiuwen mapping. created → ensure the local mapping (no
 * Gateway call; Jiuwen creates the session on first chat.send); disposed → clear per-session
 * runtime state (pending question, SwarmFlow run) but keep the mapping so the conversation resumes.
 */
export function installSessionSync({ ctx, config, sessions, logger }) {
  const offs = []
  const on = (name, fn) => {
    try {
      const off = ctx.on?.(name, (...args) => { try { fn(...args) } catch (error) { logger?.debug?.(`[dsh-jiuwen] ${name} sync failed: ${error?.message || error}`) } })
      if (typeof off === 'function') offs.push(off)
    } catch { /* host has no such event */ }
  }
  on('session/created', (session) => {
    const cfg = config()
    if (!session?.id || !sessionUsesProvider(session, cfg.provider, sessions)) return
    sessions.ensure(String(session.id))
  })
  on('session/disposed', (session) => {
    const cfg = config()
    if (!session?.id || !sessionUsesProvider(session, cfg.provider, sessions)) return
    const m = sessions.get?.(String(session.id))
    if (!m) return
    sessions.update?.(String(session.id), { pendingQuestion: undefined, swarmRunId: undefined })
  })
  return () => { for (const off of offs) { try { off() } catch { /* ignore */ } } }
}

/**
 * planBridge: after a Jiuwen turn completes (or a plan event arrives) read session.plan_status and
 * mirror `in_plan` onto ctx.planMode for the live DSH agent of that (jiuwen) session.
 */
export function createPlanBridge({ services, gateway, sessions, logger, debounceMs = 200 }) {
  const timers = new Map()
  const sync = async (dshSessionId) => {
    const { planMode, agents } = services()
    if (!planMode?.set || !planMode?.get) return
    const mapping = sessions.get?.(dshSessionId)
    if (!mapping) return // not a jiuwen session
    let agent
    try { agent = agents?.get?.(dshSessionId) } catch { agent = undefined }
    if (!agent) return
    const r = await gateway().planStatus(mapping.jiuwenSessionId)
    const inPlan = r?.in_plan ?? r?.plan_mode
    if (typeof inPlan !== 'boolean') return
    let cur
    try { cur = planMode.get(agent)?.active } catch { cur = undefined }
    if (cur === inPlan) return
    planMode.set(agent, inPlan)
  }
  return function onEvent(e) {
    const sid = e?.dshSessionId
    if (!sid) return
    const done = e.type === 'processing_status' && e.isComplete
    const plan = /plan/i.test(String(e.event || '')) || e.eventType === 'plan.approval_required'
    if (!done && !plan) return
    clearTimeout(timers.get(sid))
    timers.set(sid, setTimeout(() => {
      timers.delete(sid)
      sync(String(sid)).catch(error => logger?.debug?.(`[dsh-jiuwen] planBridge: ${String(error?.message || error).slice(0, 160)}`))
    }, debounceMs))
    timers.get(sid)?.unref?.()
  }
}

/** modelDiscovery: Jiuwen models.list → unique ids `<prefix><model_name>` (cached). */
export function createModelDiscovery({ gateway, config, ttlMs = 60_000 }) {
  let cache = { at: 0, models: [] }
  const fetchModels = async () => {
    if (Date.now() - cache.at < ttlMs) return cache.models
    const cfg = config()
    const r = await gateway().modelsList()
    const prefix = cfg.discoveryPrefix
    const seen = new Set()
    const models = []
    for (const x of r?.models || []) {
      const name = x?.model_name || x?.id || x?.name
      if (!name || seen.has(name)) continue
      seen.add(name)
      models.push({ id: `${prefix}${name}`, name: `Jiuwen · ${x.alias || name}`, modelName: String(name), ...(x.context_window_tokens ? { contextWindow: Number(x.context_window_tokens) } : {}) })
    }
    cache = { at: Date.now(), models }
    return models
  }
  return { list: () => fetchModels().catch(() => cache.models), reset() { cache = { at: 0, models: [] } } }
}
