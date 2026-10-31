/**
 * Host → Jiuwen sync for jiuwen-provider sessions only.
 * Namespaced, fail-soft, feature-detected Gateway methods. Defaults ON via hostSync.
 */
import { sessionUsesProvider } from './bridges.js'

const PLAN_CHAT = 'agent.plan'
const AGENT_CHAT = 'agent'

/** Safe permission preset → Jiuwen tools.level map (never uses permissions.tools.set). */
const PRESET_LEVELS = Object.freeze({
  'read-only': 'deny',
  'workspace-write': 'ask',
  'full-access': 'allow',
  ask: 'ask',
  allow: 'allow',
  deny: 'deny',
})

function flag(raw, envName, fallback, env = process.env) {
  if (raw === true || raw === false) return raw
  const e = env[envName]
  if (e === '1' || e === 'true') return true
  if (e === '0' || e === 'false') return false
  return fallback
}

/** Resolve hostSync + per-feature flags (each defaults to hostSync). */
export function resolveHostSyncFlags(raw = {}, env = process.env) {
  const hostSync = flag(raw.hostSync, 'JIUWEN_HOST_SYNC', true, env)
  const one = (key, envName) => flag(raw[key], envName, hostSync, env)
  return {
    hostSync,
    syncSkills: one('syncSkills', 'JIUWEN_SYNC_SKILLS'),
    syncMcp: one('syncMcp', 'JIUWEN_SYNC_MCP'),
    syncModel: one('syncModel', 'JIUWEN_SYNC_MODEL'),
    syncPlanMode: one('syncPlanMode', 'JIUWEN_SYNC_PLAN'),
    syncWorkDir: one('syncWorkDir', 'JIUWEN_SYNC_WORKDIR'),
    syncTitle: one('syncTitle', 'JIUWEN_SYNC_TITLE'),
    syncDelete: one('syncDelete', 'JIUWEN_SYNC_DELETE'),
    syncGoal: one('syncGoal', 'JIUWEN_SYNC_GOAL'),
    syncPause: one('syncPause', 'JIUWEN_SYNC_PAUSE'),
    syncPermissions: one('syncPermissions', 'JIUWEN_SYNC_PERMISSIONS'),
    syncFork: one('syncFork', 'JIUWEN_SYNC_FORK'),
    syncGroup: one('syncGroup', 'JIUWEN_SYNC_GROUP'),
    syncSchedule: one('syncSchedule', 'JIUWEN_SYNC_SCHEDULE'),
    syncMemory: one('syncMemory', 'JIUWEN_SYNC_MEMORY'),
    syncPlugins: one('syncPlugins', 'JIUWEN_SYNC_PLUGINS'),
    syncSkillInstall: one('syncSkillInstall', 'JIUWEN_SYNC_SKILL_INSTALL'),
  }
}

function sidOf(session) {
  try { return session?.id != null ? String(session.id) : undefined } catch { return undefined }
}

function soft(logger, label, err) {
  logger?.debug?.(`[dsh-jiuwen] host-sync ${label}: ${String(err?.message || err).slice(0, 200)}`)
}

async function rpcOk(gateway, method, params, logger, label) {
  try {
    const g = gateway()
    if (g.features?.isUnsupported?.(g.gatewayURL || g.url, method)) return null
    return await g.rpc(method, params)
  } catch (e) {
    soft(logger, label || method, e)
    return null
  }
}

/**
 * Install all host→Jiuwen sync listeners. Returns disposer.
 * @param {{ ctx, config: () => object, sessions, gateway: () => object, logger, services: () => object, mcpBridge?: object }} deps
 */
export function installHostSync(deps) {
  const { ctx, config, sessions, gateway, logger, services, mcpBridge } = deps
  const offs = []
  const on = (name, fn) => {
    try {
      const off = ctx.on?.(name, (...args) => {
        try { fn(...args) } catch (e) { soft(logger, name, e) }
      })
      if (typeof off === 'function') offs.push(off)
    } catch { /* host has no such event */ }
  }

  const jiuwenSession = (session) => {
    const cfg = config()
    const id = sidOf(session)
    if (!id || !sessionUsesProvider(session, cfg.provider, sessions)) return null
    return { id, mapping: sessions.ensure(id), cfg }
  }

  // ── skills/change → skills.toggle + mapping.skills (+ body soft-inject) ──
  on('skills/change', () => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncSkills) return
    syncSkillsNow().catch(e => soft(logger, 'skills', e))
  })

  async function syncSkillsNow(session) {
    const f = resolveHostSyncFlags(config())
    if (!f.syncSkills) return
    const { skills } = services()
    if (!skills?.list) return
    let hostSkills = []
    try { hostSkills = await skills.list(session ? { cwd: session.header?.cwd } : {}) } catch { return }
    const enabled = []
    const bodies = []
    for (const s of hostSkills || []) {
      const name = s?.name
      if (!name) continue
      const onModel = s.invocation?.modelInvocable !== false
      if (onModel) enabled.push(String(name))
      if (s.content && typeof s.content === 'string') bodies.push({ name: String(name), content: s.content })
    }
    // Apply to all mapped jiuwen sessions (skills are host-global; session filter when provided).
    const targets = session
      ? (() => { const j = jiuwenSession(session); return j ? [j] : [] })()
      : sessions.list().map(m => ({ id: m.dshSessionId, mapping: m, cfg: config() }))
        .filter(t => sessionUsesProvider({ id: t.id }, t.cfg.provider, sessions))

    let jwNames = new Set()
    try {
      const listed = await gateway().skillsList?.() || await gateway().rpc?.('skills.list', {})
      for (const x of listed?.skills || listed?.items || []) {
        const n = x?.name || x?.skill_name
        if (n) jwNames.add(String(n))
      }
    } catch (e) { soft(logger, 'skills.list', e) }
    try {
      const inst = await gateway().skillsInstalled?.()
      for (const x of inst?.skills || []) {
        const n = x?.name
        if (n) jwNames.add(String(n))
      }
    } catch { /* optional */ }

    for (const t of targets) {
      const patch = { skills: enabled }
      // Bodies for skills Jiuwen does not know: soft path — store for injectSystem-adjacent host instructions.
      const unknown = bodies.filter(b => !jwNames.has(b.name))
      if (unknown.length && f.syncSkillInstall) {
        patch.skillBodies = unknown.map(b => ({ name: b.name, content: String(b.content).slice(0, 4000) }))
      } else if (!unknown.length) {
        patch.skillBodies = undefined
      }
      try { sessions.update(t.id, patch) } catch (e) { soft(logger, 'skills.map', e) }
      for (const name of enabled) {
        if (!jwNames.has(name)) continue
        await rpcOk(gateway, 'skills.toggle', { name, enabled: true }, logger, 'skills.toggle')
      }
      // Disable Jiuwen skills that host no longer enables (intersection only).
      for (const name of jwNames) {
        if (enabled.includes(name)) continue
        // Only toggle off when we previously synced it onto this mapping.
        if (Array.isArray(t.mapping?.skills) && t.mapping.skills.includes(name)) {
          await rpcOk(gateway, 'skills.toggle', { name, enabled: false }, logger, 'skills.toggle.off')
        }
      }
    }
  }

  // ── session/event: title, workdir, plan, model header, permission preset, goal ──
  on('session/event', (session, event) => {
    const j = jiuwenSession(session)
    if (!j) return
    const f = resolveHostSyncFlags(j.cfg)
    const type = event?.type
    const data = event?.data || event

    if (f.syncTitle && type === 'session/title') {
      const title = String(data?.title || '').trim()
      if (title && title !== j.mapping.title) {
        Promise.resolve(gateway().sessionRename?.(j.mapping.jiuwenSessionId, title)
          ?? gateway().rpc?.('session.rename', { session_id: j.mapping.jiuwenSessionId, title }))
          .then(() => { try { sessions.update(j.id, { title }) } catch { /* ignore */ } })
          .catch(e => soft(logger, 'session.rename', e))
      }
    }

    if (f.syncWorkDir && type === 'working-directory/change') {
      const cwd = String(data?.cwd || '').trim()
      if (cwd) {
        try { sessions.update(j.id, { projectDir: cwd }) } catch (e) { soft(logger, 'workdir', e) }
      }
    }

    if (f.syncPlanMode && type === 'plan/mode') {
      const active = Boolean(data?.active)
      const chatMode = active ? PLAN_CHAT : (j.mapping.chatMode === PLAN_CHAT ? AGENT_CHAT : j.mapping.chatMode)
      try { sessions.update(j.id, { chatMode: active ? PLAN_CHAT : (chatMode || undefined) }) } catch (e) { soft(logger, 'plan→mode', e) }
    }

    if (f.syncModel && type === 'request/header') {
      const cfg = data?.config || data?.header?.config || data
      const provider = cfg?.provider
      const model = cfg?.model
      if (provider === j.cfg.provider && model) {
        const modelName = String(model)
        // Strip discovery prefix if present.
        const prefix = j.cfg.discoveryPrefix || 'jiuwen-model:'
        const bare = modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName
        // Catalog ids like jiuwen-default are not Jiuwen model_name — only forward non-catalog or explicit modelName.
        const catalog = (j.cfg.models || []).find(m => m.id === modelName)
        const forward = catalog?.modelName || (!catalog && bare && bare !== 'jiuwen-default' && bare !== 'jiuwen-swarm' ? bare : undefined)
        if (forward) {
          try { sessions.update(j.id, { modelName: String(forward) }) } catch (e) { soft(logger, 'model', e) }
        }
      }
    }

    if (f.syncPermissions && type === 'permission/preset') {
      const preset = String(data?.preset || '')
      const level = PRESET_LEVELS[preset]
      if (level) {
        // Safe subset only — update a few high-traffic tools, never set-all.
        for (const tool of ['bash', 'write_file', 'edit_file', 'Browser']) {
          rpcOk(gateway, 'permissions.tools.update', { tool, level }, logger, 'permissions').catch?.(() => {})
        }
      }
    }

    if (f.syncGoal && type === 'goal/change') {
      const goal = data?.goal
      const phase = goal?.phase
      const objective = goal?.objective
      const action = !goal || phase === 'complete' ? 'clear'
        : phase === 'paused' ? 'pause'
        : phase === 'active' && objective ? 'set'
        : null
      if (action === 'set') {
        rpcOk(gateway, 'command.goal', { session_id: j.mapping.jiuwenSessionId, action: 'set', objective: String(objective) }, logger, 'goal.set')
      } else if (action === 'pause') {
        rpcOk(gateway, 'command.goal', { session_id: j.mapping.jiuwenSessionId, action: 'pause' }, logger, 'goal.pause')
      } else if (action === 'clear') {
        rpcOk(gateway, 'command.goal', { session_id: j.mapping.jiuwenSessionId, action: 'clear' }, logger, 'goal.clear')
      }
    }
  })

  // ── goal/changed Cordis event (in addition to session log) ──
  on('goal/changed', (payload) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncGoal) return
    const agent = payload?.agent
    const session = agent?.session
    const j = jiuwenSession(session)
    if (!j) return
    const change = payload?.change
    const goal = change?.goal
    const objective = goal?.objective
    const phase = goal?.phase
    const op = change?.operation || change?.kind
    let action
    if (op === 'clear' || !goal) action = 'clear'
    else if (op === 'pause' || phase === 'paused') action = 'pause'
    else if (op === 'resume' || phase === 'active') action = objective ? 'set' : 'resume'
    else if (objective) action = 'set'
    if (!action) return
    const params = { session_id: j.mapping.jiuwenSessionId, action }
    if (action === 'set') params.objective = String(objective)
    rpcOk(gateway, 'command.goal', params, logger, 'goal/changed')
  })

  // ── pause/resume from host ──
  on('workspace/session-stop', (request) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncPause) return
    const id = request?.sessionId != null ? String(request.sessionId) : sidOf(request?.session)
    if (!id || !sessionUsesProvider({ id }, config().provider, sessions)) return
    const m = sessions.get(id)
    if (!m) return
    Promise.resolve(gateway().chatInterrupt?.(m.jiuwenSessionId, 'cancel')
      ?? gateway().rpc?.('chat.interrupt', { session_id: m.jiuwenSessionId, intent: 'cancel' }))
      .catch(e => soft(logger, 'pause', e))
  })

  // Host resume: agent/resume or similar — best-effort
  on('agent/resumed', (payload) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncPause) return
    const session = payload?.agent?.session || payload?.session
    const j = jiuwenSession(session)
    if (!j) return
    Promise.resolve(gateway().chatResume?.(j.mapping.jiuwenSessionId)
      ?? gateway().rpc?.('chat.resume', { session_id: j.mapping.jiuwenSessionId }))
      .catch(e => soft(logger, 'resume', e))
  })

  // ── session delete (api-session/removed) → session.delete; dispose keeps mapping ──
  on('api-session/removed', (sessionId) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncDelete) return
    const id = String(sessionId || '')
    if (!id) return
    const m = sessions.get(id)
    if (!m) return
    // Confirm rule: only delete when mapping had at least one turn (Jiuwen session exists remotely).
    const run = async () => {
      try {
        if ((m.turns || 0) > 0) {
          await gateway().sessionDelete?.(m.jiuwenSessionId)
            ?? gateway().rpc?.('session.delete', { session_id: m.jiuwenSessionId })
        }
      } catch (e) { soft(logger, 'session.delete', e) }
      try { sessions.remove(id) } catch (e) { soft(logger, 'unmap', e) }
    }
    run()
  })

  // ── fork: parentSession → session.fork + remap ──
  on('session/created', (session) => {
    const j = jiuwenSession(session)
    if (!j) return
    const f = resolveHostSyncFlags(j.cfg)
    // Seed cwd into mapping when present.
    if (f.syncWorkDir) {
      const cwd = session?.header?.cwd
      if (cwd) { try { sessions.update(j.id, { projectDir: String(cwd) }) } catch { /* ignore */ } }
    }
    if (f.syncFork) {
      const parent = session?.header?.parentSession
      if (parent) {
        const parentId = String(parent)
        const parentMap = sessions.get(parentId)
        if (parentMap?.jiuwenSessionId) {
          Promise.resolve()
            .then(() => gateway().sessionFork?.(parentMap.jiuwenSessionId)
              ?? gateway().rpc?.('session.fork', {
                session_id: parentMap.jiuwenSessionId,
                source_session_id: parentMap.jiuwenSessionId,
              }))
            .then((r) => {
              const newId = r?.session_id || r?.new_session_id
              if (newId) {
                // Remap child dsh session onto forked Jiuwen session.
                try {
                  sessions.remove(j.id)
                  sessions.ensure(j.id, { preferredJiuwenId: String(newId) })
                  if (parentMap.skills) sessions.update(j.id, { skills: parentMap.skills, chatMode: parentMap.chatMode, modelName: parentMap.modelName, projectDir: parentMap.projectDir })
                } catch (e) { soft(logger, 'fork.remap', e) }
              }
            })
            .catch(e => soft(logger, 'session.fork', e))
        }
      }
    }
    if (f.syncSkills) syncSkillsNow(session).catch(e => soft(logger, 'skills.onCreate', e))
    if (f.syncMcp) syncMcpForSession(j).catch(e => soft(logger, 'mcp.onCreate', e))
  })

  // ── group member changes → force persona reinject (clear systemHash) ──
  // FlyBot has no stable Cordis event; also clear when session event looks like group roster update.
  on('session/event', (session, event) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncGroup) return
    const type = event?.type
    if (type !== 'plugin:group' && type !== 'group/members' && type !== 'ds-bot/group') return
    const j = jiuwenSession(session)
    if (!j) return
    try { sessions.update(j.id, { systemHash: undefined }) } catch (e) { soft(logger, 'group.reinject', e) }
  })
  // Also: skills/change and injectSystem hash already cover persona text changes on next turn.

  // ── schedules → heartbeat / cron when Gateway routes them ──
  on('schedule/changed', (payload) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncSchedule) return
    // Best-effort: mirror interval schedules onto heartbeat conf; feature-detect.
    const rec = payload?.record || payload?.schedule || payload
    const every = Number(rec?.everySeconds || rec?.interval_seconds || rec?.every)
    if (!Number.isFinite(every) || every <= 0) return
    rpcOk(gateway, 'heartbeat.set_conf', { every, target: 'web' }, logger, 'heartbeat.set_conf')
  })

  // ── memory bridge: probe once, document gap via mapping flag ──
  let memoryProbed = false
  on('session/created', (session) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncMemory || memoryProbed) return
    const j = jiuwenSession(session)
    if (!j) return
    memoryProbed = true
    Promise.resolve(gateway().rpc?.('memory.status', { session_id: j.mapping.jiuwenSessionId }))
      .then(() => { try { sessions.update(j.id, { memoryBridge: 'rpc' }) } catch { /* ignore */ } })
      .catch(() => { try { sessions.update(j.id, { memoryBridge: 'gap' }) } catch { /* ignore */ } })
  })

  // ── plugins/capabilities soft sync ──
  on('permission-presets/catalog-changed', () => { /* no-op; permissions handled via session events */ })

  /** Register host MCP connectors into Jiuwen for a jiuwen session (session-level enable via chat.send mcp list). */
  async function syncMcpForSession(j) {
    const f = resolveHostSyncFlags(j.cfg)
    if (!f.syncMcp) return
    // Ensure dsh-tools proxy is prepared when toolPassthrough=mcp (existing bridge).
    if (j.cfg.toolPassthrough === 'mcp' && mcpBridge?.prepare) {
      try { await mcpBridge.prepare([], j.id) } catch (e) { soft(logger, 'mcp.prepare', e) }
    }
    // List Jiuwen MCP; stash names on mapping for chat.send overrides.
    try {
      const listed = await gateway().mcpList?.('all') ?? await gateway().rpc?.('mcp.list', { filter: 'all' })
      const names = (listed?.items || listed?.servers || []).map(x => x?.name).filter(Boolean)
      if (names.length) sessions.update(j.id, { mcpNames: names.map(String) })
    } catch (e) { soft(logger, 'mcp.list', e) }
  }

  on('session/disposed', (session) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncMcp) return
    const id = sidOf(session)
    if (!id) return
    // Session-level: do not delete_custom the shared proxy; only clear per-session mcpNames.
    try {
      const m = sessions.get(id)
      if (m) sessions.update(id, { mcpNames: undefined })
    } catch { /* ignore */ }
  })

  return () => { for (const off of offs) { try { off() } catch { /* ignore */ } } }
}

/** Soft-inject unknown skill bodies into a chat query (install gap path). */
export function applySkillBodyInjection(query, mapping) {
  try {
    const bodies = mapping?.skillBodies
    if (!Array.isArray(bodies) || !bodies.length) return query
    if (mapping.skillBodiesInjected) return query
    const block = bodies.map(b => `### Host skill: ${b.name}\n${b.content}`).join('\n\n')
    mapping.skillBodiesInjected = true
    return `[Host skill instructions — not installed in Jiuwen; body only]\n${block}\n[/Host skill instructions]\n\n${query}`
  } catch { return query }
}

export { PLAN_CHAT, AGENT_CHAT, PRESET_LEVELS }
