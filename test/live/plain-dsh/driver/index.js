// Test driver for a real plain dsh web profile: drives the Host services the web API uses
// (sessionController, schedule, permissionPresets, workspaceController, skills, goals, planMode)
// and writes normalized results to $DRIVER_OUT. Test-only (test/live/plain-dsh.mjs), not part of the plugin.
import { writeFileSync, mkdirSync } from 'node:fs'
import * as FS from 'node:fs'
const require_fs = () => FS
import { createHash, randomUUID } from 'node:crypto'
export const name = 'plain-driver'
const tick = ms => new Promise(r => setTimeout(r, ms))
const textOf = m => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
const DROP = new Set(['time', 'ts', 'at', 'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'durationMs', 'elapsedMs', 'latencyMs', 'firstTokenMs', 'scheduledAt', 'nextAt', 'nextRunAt', 'lastRunAt', 'createdAtMs', 'mtime', 'timestamp', 'clientTimeZone', 'date', 'dt'])
function normalizer() {
  const ids = new Map(); const tok = s => { if (!ids.has(s)) ids.set(s, `<id${ids.size}>`); return ids.get(s) }
  const UUIDISH = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|dsh-[0-9a-f]{16}|web_[0-9a-z_]+|call[-_][\w-]+|schedule-<id\d+>)/gi
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) { if (DROP.has(k)) continue; o[k] = walk(v[k]) } return o }
    if (typeof v === 'string') return v.replace(UUIDISH, tok).replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d(\[[^\]]+\])?)/g, '<ts>').replace(/\/tmp\/[\w./-]+/g, '<tmp>')
    if (typeof v === 'number' && v > 1e12) return '<epoch>'
    return v
  }
  return walk
}
export function apply(ctx) {
  const OUT = process.env.DRIVER_OUT
  if (!OUT) return
  const MODE = process.env.DRIVER_MODE || 'ref'
  const SANDBOX = process.env.DRIVER_CWD || '/tmp'
  const out = { mode: MODE, steps: [], errors: [], jw: [] }
  const step = (k, v) => out.steps.push([k, v])
  let log = () => {}
  const err = (k, e) => out.errors.push(`${k}: ${String(e?.message || e).slice(0, 200)}`)
  const unhandled = []
  process.on('unhandledRejection', e => unhandled.push(String(e?.message || e).slice(0, 200)))
  const L = () => process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).sort().join()
  const flush0 = () => { try { mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true }); writeFileSync(OUT + '.partial', JSON.stringify(out, null, 1)) } catch {} }
  log = (...a) => { console.error('[driver]', ...a); flush0() }
  setTimeout(async () => {
    log('start')
    const g = n => ctx.get(n)
    const sc = g('sessionController'), agents = g('agents'), sessions = g('sessions')
    out.services = Object.fromEntries(['sessionController', 'schedule', 'permissionPresets', 'workspaceController', 'workspaceRegistry', 'skills', 'goals', 'planMode', 'sessionTitle', 'workingDirectory', 'llm', 'jiuwenAdapter', 'mcpResources', 'agentPresets', 'sessionPersistence'].map(n => [n, g(n) !== undefined]))
    out.providers = (g('llm')?.listProviders?.() || []).map(p => p.id).sort()
    out.listeners0 = L()
    const norm = normalizer()
    const agentOf = id => agents.get?.(id) || sessions.get(id)?.agent
    const waitIdle = async (id, ms = 60_000) => { const t = Date.now() + ms; await tick(300); while (Date.now() < t) { const a = agentOf(id); if (a && typeof a.whenIdle === 'function') { await Promise.race([a.whenIdle(), tick(ms)]); return } await tick(200) } }
    const prompt = async (id, text) => { await sc.prompt({ requestId: `r-${randomUUID()}`, sessionId: id, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal); await waitIdle(id) }
    const evs = id => { try { return sessions.get(id)?.snapshotEvents?.() || [] } catch { return [] } }
    const lastReply = id => evs(id).filter(e => e.type === 'assistant/message').map(e => textOf(e.data.message)).at(-1) || ''
    const scenario = async (label, model) => {
      const r = {}
      log(label, 'create'); const { sessionId: id } = await sc.create({ cwd: SANDBOX }, new AbortController().signal)
      r.id = id
      if (model) { try { await sc.selectModel({ sessionId: id, ...model }, new AbortController().signal) } catch (e) { err(`${label} selectModel`, e) } }
      log(label, 'prompt1', id); await prompt(id, `TAG:${label}1 hello`); log(label, 'reply1', lastReply(id))
      r.reply1 = lastReply(id)
      const agent = agentOf(id)
      try { await sc.rename({ sessionId: id, title: `${label} 标题 ✓` }, new AbortController().signal) } catch (e) { err(`${label} rename`, e) }
      try { const pm = g('agentPresets')?.serviceFor?.(agent, 'planMode') ?? g('planMode'); r.planSvc = !!pm; pm?.set(agent, true); await tick(200); pm?.set(agent, false) } catch (e) { err(`${label} plan`, e) }
      try {
        const gl = g('goals'); let s = gl.create(agent, { objective: `${label} goal`, maxGoalRounds: 3 }); await tick(300)
        const ref = () => { const x = gl.get?.(agent)?.goal ?? gl.get?.(agent) ?? s?.goal ?? s; return { id: x.id, revision: x.revision } }
        const ph = () => (gl.get?.(agent)?.goal ?? gl.get?.(agent))?.phase ?? (gl.get?.(agent)?.goal ?? gl.get?.(agent))?.status
        r.goalPhase0 = ph()
        if (r.goalPhase0 === 'active') { s = gl.pause(agent, ref()); await tick(300); s = gl.resume(agent, ref()); await tick(300) }
        gl.clear(agent, ref()); await tick(300)
      } catch (e) { err(`${label} goal`, e) }
      log(label, 'ops done'); await waitIdle(id, 30_000)
      try { const s = await g('schedule').create(id, { title: `${label} sched`, prompt: 'ping', every_seconds: 7200 }); r.schedule = norm(s); r.scheduleList = norm(await g('schedule').list({ sessionId: id })) } catch (e) { err(`${label} schedule`, e) }
      try { const pp = g('permissionPresets'); r.presetCatalog = norm(pp.catalog()); r.presetBefore = pp.current(sessions.get(id)); pp.set(sessions.get(id), 'read-only'); await tick(500); r.presetAfter = pp.current(sessions.get(id)) } catch (e) { err(`${label} preset`, e) }
      try { const live = agentOf(id); const reg = g('agentPresets')?.serviceFor?.(live, 'skills') ?? g('skills'); r.skills = (await reg.list({ cwd: SANDBOX, scope: live })).map(s => s.name).filter(n => /probe/.test(n)).sort() } catch (e) { err(`${label} skills`, e) }
      log(label, 'prompt2'); await prompt(id, `TAG:${label}2 again`)
      r.reply2 = lastReply(id)
      log(label, 'fork'); try { const f = await sc.fork({ sessionId: id }, new AbortController().signal); r.fork = f.sessionId; await prompt(f.sessionId, `TAG:${label}f on fork`); r.forkReply = lastReply(f.sessionId); r.forkEvents = norm(evs(f.sessionId).map(e => ({ type: e.type, data: e.data }))) } catch (e) { err(`${label} fork`, e) }
      try { const s = (await g('schedule').list({ sessionId: id })); for (const x of (s.schedules || s.items || s || [])) if (x?.id) await g('schedule').delete({ sessionId: id, id: x.id }) } catch (e) { err(`${label} schedule.delete`, e) }
      r.events = norm(evs(id).map(e => ({ type: e.type, data: e.data })))
      r.types = [...new Set(evs(id).map(e => e.type))].sort()
      r.hash = createHash('sha1').update(JSON.stringify(r.events)).digest('hex').slice(0, 16)
      return r
    }
    try {
      // (a) non-jiuwen session on the pi-ai stand-in route: must be identical with / without the adapter.
      out.plain = await scenario('plain', { provider: 'standin', model: 'standin-m1' })
      // (b) jiuwen session: plugin effects read back from Jiuwen.
      const api = g('jiuwenAdapter')
      if (MODE === 'jw' && api) {
        const ok = (n, p, d = '') => out.jw.push(`${p ? 'PASS' : 'FAIL'} ${n}${d ? ` — ${String(d).slice(0, 180)}` : ''}`)
        const hb0 = await api.gateway.heartbeatConf().catch(() => null)
        const perm0 = await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)
        const j = await scenario('jw', { provider: 'jiuwen', model: 'jiuwen-default' })
        out.jwScenario = { planSvc: j.planSvc, reply1: j.reply1, reply2: j.reply2, forkReply: j.forkReply, types: j.types, skills: j.skills, presetAfter: j.presetAfter }
        const m = api.sessions.get(j.id)
        const rows = (await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []
        const row = rows.find(x => x.session_id === m?.jiuwenSessionId)
        ok('turns reach Jiuwen (stand-in)', /stand-in reply jw1/.test(j.reply1) && /stand-in reply jw2/.test(j.reply2), `${j.reply1} | ${j.reply2}`)
        ok('title (session controller rename) → Jiuwen', row?.title === 'jw 标题 ✓', row?.title)
        ok('workdir (create cwd) → mapping.projectDir', m?.projectDir === SANDBOX, m?.projectDir)
        const hb1 = await api.gateway.heartbeatConf().catch(() => null)
        ok('dsh-schedule every 7200 → Jiuwen heartbeat', Number(hb1?.every) === 7200, JSON.stringify(hb1))
        const perm1 = await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)
        ok('dsh-permission-presets read-only → Jiuwen bash/write/edit deny (explicit change)', JSON.stringify(perm1) !== JSON.stringify(perm0) && /deny/.test(JSON.stringify(perm1)), JSON.stringify(perm1).slice(0, 160))
        const fm = api.sessions.get(j.fork)
        ok('session controller fork → Jiuwen fork', fm?.forkedFrom === m?.jiuwenSessionId && rows.concat((await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []).some(x => x.session_id === fm?.jiuwenSessionId), JSON.stringify(fm || {}).slice(0, 160))
        ok('fork turn on Jiuwen fork', /stand-in reply jwf/.test(j.forkReply || ''), j.forkReply)
        ok('dsh-plan-mode (preset-scoped) on/off → Jiuwen chat mode cleared', j.planSvc && api.sessions.get(j.id)?.chatMode !== 'agent.plan', api.sessions.get(j.id)?.chatMode)
        const g0 = await api.gateway.rpc('command.goal', { session_id: m.jiuwenSessionId, action: 'get' }).catch(e => ({ e: e.message }))
        ok('goal cleared in Jiuwen after dsh clear', !g0?.goal, JSON.stringify(g0).slice(0, 120))
        // agent dispose / archive must NOT delete the Jiuwen session (dsh has no delete).
        try { await g('workspaceController')?.archiveSession?.({ sessionId: j.fork, stopActivity: true }) } catch (e) { err('archive', e) }
        try { const h = agentOf(j.id); await (agents.dispose?.(j.id) ?? h?.dispose?.()) } catch (e) { err('dispose', e) }
        await tick(3000)
        const rows2 = (await api.gateway.rpc('session.list', { limit: 200 }))?.sessions || []
        ok('agent dispose keeps the Jiuwen session + mapping', rows2.some(x => x.session_id === m.jiuwenSessionId) && !!api.sessions.get(j.id), m.jiuwenSessionId)
        ok('archive keeps the Jiuwen fork', rows2.some(x => x.session_id === fm?.jiuwenSessionId), fm?.jiuwenSessionId)
        // restore Jiuwen globals touched by sync
        if (hb0) await api.gateway.rpc('heartbeat.set_conf', hb0).catch(e => err('hb restore', e))
        if (perm0) for (const [tool, v] of Object.entries(perm0.tools || perm0)) { const level = typeof v === 'string' ? v : v?.level; if (level && ['bash', 'write_file', 'edit_file'].includes(tool)) await api.gateway.rpc('permissions.tools.update', { tool, level }).catch(e => err('perm restore', e)) }
        ok('heartbeat restored', JSON.stringify(await api.gateway.heartbeatConf().catch(() => null)) === JSON.stringify(hb0))
        ok('permissions restored', JSON.stringify(await api.gateway.rpc('permissions.tools.get', {}).catch(() => null)) === JSON.stringify(perm0))
        const sl = (() => { try { return require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }) } catch { return [] } })()
        const t1 = sl.filter(x => x.tag === 'jw1').at(-1), t2 = sl.filter(x => x.tag === 'jw2').at(-1), tf = sl.filter(x => x.tag === 'jwf').at(-1)
                ok('agent-preset skill body (dsh-skill-filesystem) reaches Jiuwen', [t1, t2].some(t => (t?.marks || []).includes('MARKSKILLBODY')), JSON.stringify([t1?.marks, t2?.marks]))
        ok('fork turn continues the Jiuwen fork (not a transcript resend)', tf && !/user: /.test(tf.last || '') && tf.users > 2, JSON.stringify({ users: tf?.users, last: (tf?.last || '').slice(-80) }))
        try {
          const { sessionId: mid } = await sc.create({ cwd: SANDBOX, agentPreset: 'minimal' }, new AbortController().signal)
          await sc.selectModel({ sessionId: mid, provider: 'jiuwen', model: 'jiuwen-default' }, new AbortController().signal)
          await prompt(mid, 'TAG:jwm1 hi'); await prompt(mid, 'TAG:jwm2 again')
          const sl2 = require_fs().readFileSync((process.env.STANDIN_LOG || '/tmp/standin.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
          const m1 = sl2.filter(x => x.tag === 'jwm1').at(-1), m2 = sl2.filter(x => x.tag === 'jwm2').at(-1)
          ok('dsh-persona preset (minimal, complete prompt) → forwarded once; web default persona not forwarded', m1?.persona && !m2?.persona && !t1?.persona, JSON.stringify({ m1: m1?.persona, m2: m2?.persona, def: t1?.persona }))
          out.minimalId = api.sessions.get(mid)?.jiuwenSessionId
        } catch (e) { err('minimal preset', e) }
        out.jwIds = [m?.jiuwenSessionId, fm?.jiuwenSessionId]
      }
    } catch (e) { err('driver', e.stack || e) }
    out.listeners1 = L()
    out.unhandled = unhandled
    mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true })
    writeFileSync(OUT, JSON.stringify(out, null, 1))
  }, Number(process.env.DRIVER_DELAY || 6000))
}
