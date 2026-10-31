/**
 * Host → Jiuwen sync for jiuwen-provider sessions only.
 * Namespaced, fail-soft, feature-detected Gateway methods. Defaults ON via hostSync.
 */
import { sessionUsesProvider } from './bridges.js'

const PLAN_CHAT = 'agent.plan'
/** Jiuwen tools a permission preset touches (never permissions.tools.set). */
const PERMISSION_TOOLS = Object.freeze(['bash', 'write_file', 'edit_file'])
const AGENT_CHAT = 'agent'

/** Safe permission preset → Jiuwen tools.level map (never uses permissions.tools.set). */
const PRESET_LEVELS = Object.freeze({
  'read-only': 'deny',
  'workspace-write': 'ask',
  'full-access': 'allow',
  'danger-full-access': 'allow',
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
  let disposed = false
  // Skills/permission syncs are serialized (one socket per RPC would otherwise race: a rapid
  // on→off could land off→on). Global skill syncs coalesce: one queued run picks up the latest state.
  let skillsTail = Promise.resolve()
  let skillsQueued = null
  const queueSkills = (session) => {
    if (!session && skillsQueued) return skillsQueued
    const run = skillsTail.then(() => { if (!session) skillsQueued = null; return disposed ? undefined : syncSkillsNow(session) })
    skillsTail = run.catch(e => soft(logger, 'skills', e))
    if (!session) skillsQueued = run
    return run
  }
  let permTail = Promise.resolve()
  let permWanted = null
  const queuePermissions = (level) => {
    const first = permWanted === null
    permWanted = level
    if (!first) return permTail // a queued run applies the latest level
    permTail = permTail.then(async () => {
      const lvl = permWanted; permWanted = null
      if (disposed || !lvl) return
      for (const tool of PERMISSION_TOOLS) await rpcOk(gateway, 'permissions.tools.update', { tool, level: lvl }, logger, 'permissions')
    }).catch(e => soft(logger, 'permissions', e))
    return permTail
  }
  // goal/change (session log) and goal/changed (agent event) both fire for one change: dedupe.
  const goalSent = new Map()
  /** Last goal action we sent per Jiuwen session: dsh `resume` maps to Jiuwen `resume` only after our `pause`. */
  const goalLast = new Map()
  const resumeOrSet = (jwSid, objective) => goalLast.get(jwSid) === 'pause' ? 'resume' : (objective ? 'set' : 'resume')
  const sendGoal = (params, label) => {
    const key = JSON.stringify(params)
    const now = Date.now()
    if (goalSent.get(params.session_id)?.key === key && now - goalSent.get(params.session_id).at < 2000) return
    goalSent.set(params.session_id, { key, at: now })
    goalLast.set(params.session_id, params.action)
    return rpcOk(gateway, 'command.goal', params, logger, label)
  }
  const on = (name, fn) => {
    try {
      const off = ctx.on?.(name, (...args) => {
        try { fn(...args) } catch (e) { soft(logger, name, e) }
      })
      if (typeof off === 'function') offs.push(off)
    } catch { /* host has no such event */ }
  }

  // Fork remaps are async; a title (or other rename) for the child must target the forked session.
  const forkPending = new Map()
  // Renames are serialized per session and latest-wins (a deferred fallback title must not land
  // after a newer user title).
  const renameQueue = new Map()
  const wantedTitle = new Map()
  const renameSoon = (id, wanted) => {
    wantedTitle.set(id, wanted)
    const prev = renameQueue.get(id) || Promise.resolve()
    const next = prev.then(() => forkPending.get(id)).then(async () => {
      if (disposed) return
      const title = wantedTitle.get(id)
      const m = sessions.get(id)
      if (!m || !title || title === m.title) return
      // Renaming a session Jiuwen has not created yet would create an empty orphan session.
      if (!((m.turns || 0) > 0)) { sessions.update(id, { pendingTitle: title }); return }
      await (gateway().sessionRename?.(m.jiuwenSessionId, title)
        ?? gateway().rpc?.('session.rename', { session_id: m.jiuwenSessionId, title }))
      sessions.update(id, { title, pendingTitle: undefined })
    }).catch(e => soft(logger, 'session.rename', e))
    renameQueue.set(id, next)
    next.finally(() => { if (renameQueue.get(id) === next) { renameQueue.delete(id); wantedTitle.delete(id) } })
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
    queueSkills().catch(() => {})
  })

  async function syncSkillsNow(session) {
    const f = resolveHostSyncFlags(config())
    if (!f.syncSkills) return
    const { skills } = services()
    if (!skills?.list) return
    let hostSkills = []
    try { hostSkills = await skills.list(session ? { cwd: session.header?.cwd } : {}) } catch { return }
    const enabled = []
    for (const s of hostSkills || []) {
      const name = s?.name
      if (!name) continue
      const onModel = s.invocation?.modelInvocable !== false
      if (onModel) enabled.push(String(name))
    }
    // Apply to all mapped jiuwen sessions (skills are host-global; session filter when provided).
    const targets = session
      ? (() => { const j = jiuwenSession(session); return j ? [j] : [] })()
      : sessions.list().map(m => ({ id: m.dshSessionId, mapping: m, cfg: config() }))
        .filter(t => sessionUsesProvider({ id: t.id }, t.cfg.provider, sessions))
    if (!targets.length) return // no jiuwen session: never touch the Gateway

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

    // chat.send `skills` is Jiuwen's per-turn "skills_to_use" hint: only names Jiuwen knows.
    const known = enabled.filter(n => jwNames.has(n))
    // dsh skills.list() returns summaries without bodies: load bodies of unknown skills via skills.get().
    let unknown = []
    if (f.syncSkillInstall) {
      for (const name of enabled.filter(n => !jwNames.has(n)).slice(0, 20)) {
        try {
          const full = typeof skills.get === 'function' ? await skills.get(name, session ? { cwd: session.header?.cwd } : {}) : undefined
          const content = full?.content
          if (typeof content === 'string' && content.trim()) unknown.push({ name, content: content.slice(0, 4000) })
        } catch (e) { soft(logger, 'skills.get', e) }
      }
    }
    for (const t of targets) {
      // Snapshot what we synced last time BEFORE updating (update mutates the mapping in place).
      const prevKnown = Array.isArray(t.mapping?.skills) ? [...t.mapping.skills] : []
      const prevBodies = JSON.stringify(t.mapping?.skillBodies || [])
      const patch = { skills: known.length ? known : undefined }
      if (unknown.length) {
        patch.skillBodies = unknown
        if (JSON.stringify(unknown) !== prevBodies) patch.skillBodiesInjected = undefined
      } else {
        patch.skillBodies = undefined
        patch.skillBodiesInjected = undefined
      }
      try { sessions.update(t.id, patch) } catch (e) { soft(logger, 'skills.map', e) }
      for (const name of known) {
        if (prevKnown.includes(name)) continue
        await rpcOk(gateway, 'skills.toggle', { name, enabled: true }, logger, 'skills.toggle')
      }
      // Disable Jiuwen skills the host no longer enables — only those we synced onto this mapping.
      for (const name of prevKnown) {
        if (known.includes(name) || !jwNames.has(name)) continue
        await rpcOk(gateway, 'skills.toggle', { name, enabled: false }, logger, 'skills.toggle.off')
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
      if (title) renameSoon(j.id, title)
    }
    // A title set before the first turn waits for the Jiuwen session to exist (Jiuwen creates it lazily).
    if (f.syncTitle && type === 'turn/end') {
      const m = sessions.get(j.id)
      if (m?.pendingTitle && (m.turns || 0) > 0) renameSoon(j.id, m.pendingTitle)
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

    if (f.syncModel && (type === 'request/header' || type === 'model/selection')) {
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
          if (forward !== j.mapping.modelName) {
            try { sessions.update(j.id, { modelName: String(forward), modelNameSynced: true }) } catch (e) { soft(logger, 'model', e) }
          }
        } else if (j.mapping.modelNameSynced && j.mapping.modelName) {
          // Picker went back to a catalog/default entry: drop the model we synced (not a /jiuwen model pin).
          try { sessions.update(j.id, { modelName: undefined, modelNameSynced: undefined }) } catch (e) { soft(logger, 'model', e) }
        }
      }
    }

    if (f.syncPermissions && type === 'permission/preset') {
      const preset = String(data?.preset || '')
      const level = PRESET_LEVELS[preset]
      // The first preset of a session is the host default (dsh-permission-presets seeds it on every
      // new session): record it as the baseline and only forward later, explicit changes.
      let baseline = j.mapping.permissionPreset
      if (baseline === undefined) {
        // The mapping may be newer than the seed (a brand-new session is not known as jiuwen at
        // session/created): take the baseline from earlier permission/preset events in the log.
        try {
          const prior = (session?.snapshotEvents?.() || []).filter(e => e?.type === 'permission/preset' && e !== event
            && (event?.seq === undefined || e.seq < event.seq))
          if (prior.length) baseline = String(prior.at(-1).data?.preset || '') || undefined
        } catch { /* ignore */ }
      }
      if (preset && preset !== baseline) { try { sessions.update(j.id, { permissionPreset: preset }) } catch { /* ignore */ } }
      if (level && baseline !== undefined && preset !== baseline) {
        // Safe subset only — update a few high-traffic tools, never set-all.
        queuePermissions(level)
      }
    }

    if (f.syncGoal && type === 'goal/change') {
      const goal = data?.goal
      const phase = goal?.phase
      const objective = goal?.objective
      const op = data?.operation
      const action = !goal || phase === 'complete' || op === 'clear' ? 'clear'
        : phase === 'paused' ? 'pause'
        : op === 'resume' && phase === 'active' ? resumeOrSet(j.mapping.jiuwenSessionId, objective)
        : phase === 'active' && objective ? 'set'
        : null
      if (action === 'resume') {
        sendGoal({ session_id: j.mapping.jiuwenSessionId, action: 'resume' }, 'goal.resume')
      } else if (action === 'set') {
        sendGoal({ session_id: j.mapping.jiuwenSessionId, action: 'set', objective: String(objective) }, 'goal.set')
      } else if (action === 'pause') {
        sendGoal({ session_id: j.mapping.jiuwenSessionId, action: 'pause' }, 'goal.pause')
      } else if (action === 'clear') {
        sendGoal({ session_id: j.mapping.jiuwenSessionId, action: 'clear' }, 'goal.clear')
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
    else if (op === 'resume') action = resumeOrSet(j.mapping.jiuwenSessionId, objective)
    else if (phase === 'active') action = objective ? 'set' : 'resume'
    else if (objective) action = 'set'
    if (!action) return
    const params = { session_id: j.mapping.jiuwenSessionId, action }
    if (action === 'set') params.objective = String(objective)
    sendGoal(params, 'goal/changed')
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
      // Deleted while a turn is in flight: interrupt it and wait for it to settle, so the Jiuwen
      // session the turn creates is deleted too (not orphaned) and the mapping is not re-recorded.
      if (sessions.isActive?.(id)) {
        try { await (gateway().chatInterrupt?.(m.jiuwenSessionId, 'cancel') ?? gateway().rpc?.('chat.interrupt', { session_id: m.jiuwenSessionId, intent: 'cancel' })) } catch (e) { soft(logger, 'delete.interrupt', e) }
        await sessions.idle(id, 15_000)
        m.turns = Math.max(m.turns || 0, sessions.get(id)?.turns || 0, 1) // the turn reached Jiuwen
      }
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
      const parent = session?.header?.origin === 'subagent' ? undefined : session?.header?.parentSession
      if (parent) {
        const parentId = String(parent)
        const parentMap = sessions.get(parentId)
        if (parentMap?.jiuwenSessionId) {
          const pending = Promise.resolve()
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
                  // The fork already holds the parent's history: keep turns (incremental sends, and
                  // api-session/removed deletes it) and the per-session options.
                  sessions.update(j.id, {
                    turns: parentMap.turns || 1, forkedFrom: parentMap.jiuwenSessionId,
                    skills: parentMap.skills, chatMode: parentMap.chatMode, modelName: parentMap.modelName,
                    projectDir: parentMap.projectDir || session?.header?.cwd, systemHash: parentMap.systemHash,
                  })
                } catch (e) { soft(logger, 'fork.remap', e) }
              }
            })
            .catch(e => soft(logger, 'session.fork', e))
            .finally(() => { if (forkPending.get(j.id) === pending) forkPending.delete(j.id) })
          forkPending.set(j.id, pending)
        }
      }
    }
    if (f.syncSkills) queueSkills(session).catch(() => {})
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
  // dsh-schedule emits a payload-less `schedule/changed`; the record is in the session log
  // event `schedule/change` ({ operation: 'create', schedule: { kind: 'every', everySeconds } }).
  const mirrorSchedule = async (rec) => {
    const every = Number(rec?.everySeconds || rec?.interval_seconds || rec?.every)
    if (!Number.isFinite(every) || every <= 0) return
    // Merge onto the current conf so target/active_hours are kept.
    let cur = {}
    try { cur = (await gateway().heartbeatConf?.()) || {} } catch { /* unrouted */ }
    if (Number(cur.every) === every) return
    const { every: _e, type: _t, ...rest } = cur || {}
    await rpcOk(gateway, 'heartbeat.set_conf', { ...rest, target: rest.target || 'web', every }, logger, 'heartbeat.set_conf')
  }
  on('session/event', (session, event) => {
    if (event?.type !== 'schedule/change') return
    const j = jiuwenSession(session)
    if (!j) return
    const f = resolveHostSyncFlags(j.cfg)
    if (!f.syncSchedule) return
    const data = event?.data || {}
    if (data.operation !== 'create' || data.schedule?.kind !== 'every') return
    mirrorSchedule(data.schedule).catch(e => soft(logger, 'schedule', e))
  })
  on('schedule/changed', (payload) => {
    const f = resolveHostSyncFlags(config())
    if (!f.syncSchedule) return
    const rec = payload?.record || payload?.schedule || payload
    if (rec?.everySeconds || rec?.interval_seconds || rec?.every) mirrorSchedule(rec).catch(e => soft(logger, 'schedule', e))
  })

  // ── memory bridge: probe once per mapping, document gap via mapping flag ──
  // A brand-new dsh session has no request header at session/created (provider unknown), so the
  // probe (and the MCP name sync) also run on the session's first jiuwen request/header.
  const probing = new Set()
  const probeMemory = (j) => {
    const f = resolveHostSyncFlags(j.cfg)
    if (!f.syncMemory || j.mapping.memoryBridge || probing.has(j.id)) return
    probing.add(j.id)
    Promise.resolve()
      .then(() => gateway().memoryStatus?.(j.mapping.jiuwenSessionId) ?? gateway().rpc?.('memory.status', { session_id: j.mapping.jiuwenSessionId }))
      .then(() => 'rpc', () => 'gap')
      .then((v) => { try { if (sessions.get(j.id)) sessions.update(j.id, { memoryBridge: v }) } catch { /* ignore */ } })
      .finally(() => probing.delete(j.id))
  }
  on('session/created', (session) => {
    const j = jiuwenSession(session)
    if (j) probeMemory(j)
  })
  on('session/event', (session, event) => {
    if (event?.type !== 'request/header') return
    const j = jiuwenSession(session)
    if (!j) return
    probeMemory(j)
    if (j.mapping.mcpNames === undefined && !j.mapping.mcpSynced && resolveHostSyncFlags(j.cfg).syncMcp) {
      try { sessions.update(j.id, { mcpSynced: true }) } catch { /* ignore */ }
      syncMcpForSession(j).catch(e => soft(logger, 'mcp.onHeader', e))
    }
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
      // mcp.list returns the whole hub catalog (installed:false, disconnected): only forward
      // servers that are actually usable, never the catalog.
      const names = (listed?.items || listed?.servers || [])
        .filter(x => x && (x.installed === true || x.enabled === true || x.state === 'connected' || x.connection_state === 'connected'))
        .map(x => x.name).filter(Boolean)
      sessions.update(j.id, { mcpNames: names.length ? names.map(String) : undefined })
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

  const dispose = () => {
    disposed = true
    for (const off of offs) { try { off() } catch { /* ignore */ } }
    offs.length = 0
    goalSent.clear(); goalLast.clear(); wantedTitle.clear(); forkPending.clear(); renameQueue.clear(); probing.clear()
  }
  /** Test/diagnostic hook: settle queued skills/permission syncs. */
  dispose.idle = () => Promise.all([skillsTail, permTail]).then(() => {})
  return dispose
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

export { PLAN_CHAT, AGENT_CHAT, PRESET_LEVELS, PERMISSION_TOOLS }
