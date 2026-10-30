#!/usr/bin/env node
/**
 * Jiuwen Gateway WS mock: connection.ack, chat.send (+ media/tool/subtask events),
 * and unary RPCs (history/models/mcp/memory/files/session).
 */
import { WebSocketServer } from './_ws-server.mjs'

const SHAPE = { v: process.env.JIUWEN_GATEWAY_MOCK_SHAPE || '0.2.5' }
const PORT = Number(process.env.JIUWEN_GATEWAY_MOCK_PORT || 19000)
const wss = await WebSocketServer({ port: PORT, host: '127.0.0.1' })
console.log(`[mock-gateway] listening on ws://127.0.0.1:${PORT}/ws`)

const HISTORY = new Map() // session_id -> turns[]
const PERM_TOOLS = { bash: 'allow', acp_chat: 'ask', rm_rf: 'deny' }
const PLUGINS = [
  { plugin_name: 'skill-creator', enabled: true },
  { plugin_name: 'old-plugin', enabled: false },
]
const ARCHIVED = [{ session_id: 's-old', title: 'Old chat' }]
let HEARTBEAT = { every: 3600, target: 'web', active_hours: { start: '08:00', end: '22:00' } }

const LAST_PARAMS = new Map()
const CANCEL_AT = new Map()
const CANCELLED = new Set()
const INTERRUPTS = []
const ANSWERS = []
const RENAMES = []
const EXTLOG = []
const SWARM_WAIT = new Map()
const PLAN_ON = new Set() // P1/P2 extended-method calls
const CRON = new Map()
const HB = new Map([['hb-job-1', { id: 'hb-job-1', name: 'mock-hb', enabled: true }]])
const RULES = [{ id: 'shell_allow_ls', tools: ['bash'], pattern: 'ls', action: 'allow' }]

wss.on('connection', (ws, req) => {
  // Echo whether access_token / user_id arrived (query) for auth smoke
  let urlAuth = {}
  try {
    const u = new URL(req?.url || '/ws', `http://127.0.0.1:${PORT}`)
    urlAuth = {
      user_id: u.searchParams.get('user_id'),
      has_token: Boolean(u.searchParams.get('access_token') || u.searchParams.get('token')),
    }
  } catch { /* ignore */ }

  ws.send(JSON.stringify({
    type: 'event',
    event: 'connection.ack',
    payload: { ok: true, mock_auth: urlAuth },
  }))

  ws.on('message', (raw) => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (frame.type !== 'req') return
    const method = frame.method
    const params = frame.params || {}

    if (method === 'chat.send') {
      const query = String(params.content || params.query || '')
      const sessionId = String(params.session_id || 's')
      const rid = frame.id
      const ev = (event, payload) => ws.send(JSON.stringify({ type: 'event', event, payload: { session_id: sessionId, request_id: rid, ...payload } }))
      LAST_PARAMS.set(sessionId, params)
      if (/plan-on/.test(query)) PLAN_ON.add(sessionId)
      const turns = HISTORY.get(sessionId) || []
      const prior = turns.filter(t => t.role === 'user').length
      const answered = Array.isArray(params.answers) && params.request_id
      if (answered) ANSWERS.push({ via: 'chat.send', ...params })
      let reply = answered ? `answered ${params.source}: ${params.answers.map(a => (a.selected_options || []).join('+') || a.custom_input).join(';')}`
        : /ping/i.test(query) ? 'pong-from-gateway-mock' : `gateway-mock: ${query.slice(0, 200)}`
      if (/echo-params/.test(query)) {
        reply = `params mode=${params.mode} model=${params.model_name ?? '-'} agent=${params.agent_template_name ?? '-'} group=${params.agent_group_name ?? '-'} skills=${(params.skills || []).join('|') || '-'} media=${(params.media_items || []).length} prior=${prior} query=${JSON.stringify(query)}`
      }
      turns.push({ role: 'user', content: query }, { role: 'assistant', content: reply })
      HISTORY.set(sessionId, turns)

      ws.send(JSON.stringify({ type: 'res', id: rid, ok: true, payload: { accepted: true } }))
      ev('chat.processing_status', { event_type: 'chat.processing_status', is_processing: true, is_complete: false })
      // Real JiuwenSwarm race: a send that lands within ~300 ms of chat.interrupt on the same session is
      // accepted but never runs. Emulated so the adapter's post-cancel settle stays covered.
      if (Date.now() - (CANCEL_AT.get(sessionId) || 0) < Number(process.env.MOCK_CANCEL_RACE_MS ?? 300)) return

      if (!answered && /need permission/i.test(query)) {
        ev('chat.ask_user_question', { event_type: 'chat.ask_user_question', request_id: 'perm-1', source: 'permission_interrupt', questions: [{ question: 'Allow bash rm?', tool_name: 'bash', card_id: 'card-1', options: [{ value: 'allow_once', label: '本次允许' }, { value: 'reject', label: '拒绝' }] }] })
        return
      }
      if (!answered && /swarm-human/i.test(query)) {
        ev('swarmflow.run_started', { event_type: 'swarmflow.run_started', run_id: 'run-42' })
        ev('chat.ask_user_question', { event_type: 'chat.ask_user_question', request_id: 'swarmflow:run-42:p1:review:1', source: 'swarmflow_human', questions: [{ question: 'Approve the outline?', header: 'Lead · review', options: [], multi_select: false }], swarmflow_meta: { run_id: 'run-42', correlation_id: 'p1:review:1', agent_id: 'lead', agent_name: 'Lead' } })
        SWARM_WAIT.set(sessionId, () => { ev('chat.final', { content: 'swarm resumed' }); ev('chat.final', { content: '' }); ev('chat.processing_status', { event_type: 'chat.processing_status', is_processing: false, is_complete: true }) })
        return
      }
      if (!answered && /swarm-run/i.test(query)) {
        ev('swarmflow.run_started', { event_type: 'swarmflow.run_started', run_id: 'run-77', workflow_run_id: 'run-77' })
        // never finishes on its own → host abort path
        return
      }
      if (!answered && /ask me/i.test(query) && params.supports_user_interaction) {
        ev('chat.ask_user_question', { event_type: 'chat.ask_user_question', request_id: 'q-1', source: 'ask_user_interrupt', questions: [{ question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] }] })
        return
      }
      if (!answered && /ask me/i.test(query)) {
        ev('chat.ask_user_question', { event_type: 'chat.ask_user_question', questions: [{ question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] }] })
        return
      }
      if (params.media_items?.length || params.attachments?.media_items?.length) {
        ev('chat.media', { event_type: 'chat.media', name: 'upload.png', content: 'media-ack' })
      }
      ev('chat.reasoning', { content: 'thinking about it' })
      // Jiuwen-owned tool hop (real wire shape: nested tool_call, rendered_result)
      ev('chat.tool_call', { event_type: 'chat.tool_call', tool_call: { name: 'bash', arguments: '{"command":"echo ok"}', tool_call_id: 'call_1' } })
      ev('chat.tool_update', { event_type: 'chat.tool_update', tool_name: 'bash', tool_call_id: 'call_1', status: 'in_progress' })
      ev('chat.tool_result', { event_type: 'chat.tool_result', tool_name: 'bash', tool_call_id: 'call_1', success: true, rendered_result: 'ok', result: 'success=True' })
      ev('chat.subtask_update', { event_type: 'chat.subtask_update', content: 'swarm-step-1' })

      if (/drop-mid/i.test(query)) {
        // Stream part of the answer, then drop the socket; history already holds the full reply.
        ev('chat.delta', { content: reply.slice(0, 12) })
        setTimeout(() => ws.socket?.destroy ? ws.socket.destroy() : ws.close(), 30)
        return
      }
      if (/drop-lost/i.test(query)) {
        // Drop before any answer exists in history.
        turns.pop(); HISTORY.set(sessionId, turns)
        setTimeout(() => ws.socket?.destroy ? ws.socket.destroy() : ws.close(), 30)
        return
      }
      const pieces = chunkText(reply, 20)
      const slow = /slow/i.test(query)
      let i = 0
      const finish = () => {
        ev('chat.final', { content: reply, final_mode: 'patch_segment' })
        ev('chat.usage_summary', { event_type: 'chat.usage_summary', usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }, model: 'mock' })
        ev('chat.final', { content: '' })
        // Real JiuwenSwarm emits processing_status{is_complete} ~0.7 s after the terminal final.
        const done = () => ev('chat.processing_status', { event_type: 'chat.processing_status', is_processing: false, is_complete: true })
        if (/late-status/.test(query)) setTimeout(done, 3000); else done()
        if (process.env.MOCK_STREAM_END === '1') ws.send(JSON.stringify({ type: 'event', event: 'stream.end', id: rid }))
      }
      const step = () => {
        if (CANCELLED.has(sessionId)) {
          CANCELLED.delete(sessionId)
          ev('chat.interrupt_result', { event_type: 'chat.interrupt_result', intent: 'cancel' })
          return
        }
        if (i >= pieces.length) return finish()
        ev('chat.delta', { content: pieces[i++] })
        if (slow) setTimeout(step, 300); else step()
      }
      step()
      return
    }
    if (method === 'chat.user_answer') {
      ANSWERS.push({ via: 'chat.user_answer', ...params })
      return ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { accepted: true } }))
    }
    if (method === 'chat.interrupt') {
      CANCELLED.add(String(params.session_id || ''))
      CANCEL_AT.set(String(params.session_id || ''), Date.now())
      INTERRUPTS.push(params)
      return ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { accepted: true, intent: params.intent } }))
    }
    if (method === 'debug.state') {
      return ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {
        interrupts: INTERRUPTS, answers: ANSWERS, renames: RENAMES, last: Object.fromEntries(LAST_PARAMS), history: Object.fromEntries(HISTORY),
      } }))
    }

    // Unary RPCs
    const ok = (payload) => ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }))
    const err = (message) => ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message } }))
    if (method === 'history.get' && SHAPE.v === '0.2.7') {
      // 0.2.7: ack, then stream `history.message` records (page_idx 1-based, newest first) + done.
      const sid = String(params.session_id || '')
      ok({ accepted: true, session_id: sid })
      const msgs = HISTORY.get(sid) || []
      const evt = (payload) => ws.send(JSON.stringify({ type: 'event', event: payload.event_type || 'history.message', payload }))
      if (!msgs.length || Number(params.page_idx ?? 0) < 1) return evt({ event_type: 'chat.error', error: 'invalid page_idx or session history not found', is_complete: true, session_id: sid, request_id: frame.id })
      for (const m of msgs.slice().reverse()) {
        const rec = m.role === 'assistant' ? { ...m, event_type: 'chat.final' } : m
        const text = String(rec.content ?? '')
        if (text.length > 40) {
          // exercise `_part` reassembly on long records
          const parts = [text.slice(0, 20), text.slice(20)]
          parts.forEach((c, i) => evt({ event_type: 'history.message', session_id: sid, message: { ...rec, content: c, _part: { record_id: `r-${text.length}`, part_idx: i, total_parts: 2 } } }))
        } else evt({ event_type: 'history.message', session_id: sid, message: rec })
      }
      return evt({ event_type: 'history.message', status: 'done', session_id: sid, total_pages: 1, page_idx: 1 })
    }
    if (method === 'history.list_turns' && SHAPE.v === '0.2.7') return err('unknown method: history.list_turns')
    if (method === 'history.get') {
      const sid = String(params.session_id || '')
      return ok({ session_id: sid, messages: HISTORY.get(sid) || [], has_more: false })
    }
    if (method === 'history.list_turns') {
      const sid = String(params.session_id || '')
      const msgs = HISTORY.get(sid) || []
      return ok({ session_id: sid, turns: Math.ceil(msgs.length / 2), messages: msgs })
    }
    if (method === 'session.get_metadata') {
      return ok({ session_id: params.session_id, title: `mock-${params.session_id}`, runtime: { mode: 'agent' }, mock_auth: urlAuth })
    }
    if (method === 'skills.list') return ok({ skills: [{ name: 'mock-skill', description: 'mock' }] })
    if (method === 'agents.list') return ok({ agents: [{ name: 'mock-agent' }] })
    if (method === 'team.templates.list') return ok({ templates: [{ template_id: 'jiuwen_team' }] })
    if (method === 'session.list') return ok({ sessions: [...HISTORY.keys()].map(id => ({ session_id: id, message_count: HISTORY.get(id).length })) })
    if (method === 'session.create') return ok({ session_id: `web_mock_${Date.now()}` })
    if (method === 'commands.list') return ok({ commands: [{ name: 'compact' }, { name: 'fork' }, { name: 'goal' }] })
    if (method === 'debug.set_shape') { SHAPE.v = String(params.shape || '0.2.5'); return ok({ shape: SHAPE.v }) }
    // JiuwenSwarm 0.2.7 web handler table: no session.assets.list / team.list / models.get;
    // models.list entries carry model_name/alias/origin_index/is_default but no model_id.
    if (SHAPE.v === '0.2.7' && ['session.assets.list', 'team.list', 'models.get'].includes(method)) return err(`unknown method: ${method}`)
    if (method === 'models.list' && SHAPE.v === '0.2.7') {
      return ok({
        models: [
          { model_name: 'jiuwen-default', api_base: 'https://example.test/v1', api_key: 'sk-secret-mock', model_provider: 'OpenAI', is_default: true, alias: 'primary', origin_index: 0, endpoint_profile: 'openai', context_window_tokens: 128000 },
          { model_name: 'jiuwen-swarm', api_base: 'https://example.test/v1', api_key: '', model_provider: 'OpenAI', is_default: false, alias: '', origin_index: 1, endpoint_profile: '' },
        ],
        active_model: 'jiuwen-default',
      })
    }
    if (method === 'models.list') {
      return ok({
        models: [
          { model_id: 'mdl_default_primary', id: 'jiuwen-default', model_name: 'jiuwen-default', name: 'Jiuwen Default', is_default: true },
          { model_id: 'mdl_swarm', id: 'jiuwen-swarm', model_name: 'jiuwen-swarm', name: 'Jiuwen Swarm' },
        ],
        active_model: 'jiuwen-default',
      })
    }
    if (method === 'models.get') {
      const id = String(params.model_id || '')
      const catalog = {
        mdl_default_primary: { model_id: 'mdl_default_primary', model_name: 'jiuwen-default', is_default: true, model_client_config: { model_name: 'jiuwen-default', client_provider: 'OpenAI', api_base: 'https://example.test/v1', endpoint_profile: 'openai', has_api_key: true } },
        mdl_swarm: { model_id: 'mdl_swarm', model_name: 'jiuwen-swarm', model_client_config: { model_name: 'jiuwen-swarm', client_provider: 'OpenAI', api_base: 'https://example.test/v1', endpoint_profile: 'openai', has_api_key: false } },
      }
      const hit = catalog[id]
      if (!hit) {
        ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: `unknown model_id '${id}'` } }))
        return
      }
      return ok({ model: hit })
    }
    if (method === 'mcp.list') {
      return ok({
        filter: params.filter || 'builtin',
        items: [{ name: 'mock-mcp', enabled: true, description: 'mock connector' }],
      })
    }
    if (method === 'memory.list' || method === 'memory.status') {
      return ok({ session_id: params.session_id, entries: [], enabled: true })
    }
    if (method === 'files.list') {
      return ok({ session_id: params.session_id, files: [] })
    }
    if (method === 'chat.interrupt') {
      return ok({ interrupted: true, session_id: params.session_id })
    }
    if (method === 'command.workflows') {
      return ok({ type: 'list', workflows: [], session_id: params.session_id, total: 0 })
    }
    if (method === 'swarmflow.pause' || method === 'swarmflow.resume' || method === 'swarmflow.stop') {
      if (method === 'swarmflow.stop') EXTLOG.push({ method, params })
      return ok({ ok: true, method })
    }
    if (method === 'session.rename') {
      RENAMES.push({ session_id: params.session_id, title: params.title ?? '' })
      return ok({ session_id: params.session_id, title: params.title ?? '', previous_title: '' })
    }
    if (method === 'session.pin') {
      return ok({ pinned: Boolean(params.pinned), pin_order: params.pinned ? 1 : null })
    }
    if (method === 'session.fork') {
      if (SHAPE.v === '0.2.7' && !params.source_session_id) return err('source_session_id is required')
      return ok({ session_id: `fork_${params.session_id || 's'}_${Date.now().toString(36)}`, source_session_id: params.session_id })
    }
    if (method === 'session.delete') {
      const sid = String(params.session_id || '')
      HISTORY.delete(sid)
      return ok({ session_id: sid, accepted: true })
    }
    if (method === 'command.goal') {
      return ok({ action: params.action || 'get', objective: params.objective, session_id: params.session_id, status: params.action === 'clear' ? 'cleared' : 'ok' })
    }
    if (method === 'command.compact') {
      return ok({ result: 'compressed', stats: { total_messages: 2, total_tokens: 10 } })
    }
    if (method === 'skills.toggle') {
      return ok({ name: params.name, enabled: Boolean(params.enabled) })
    }
    if (method === 'skills.installed') {
      return ok({ skills: [{ name: 'installed-skill', description: 'mock installed' }] })
    }
    if (method === 'agents.tools_list') return ok({ tools: [{ name: 'Read', internal_name: 'read_file' }, { name: 'Bash', internal_name: 'bash' }] })
    if (method === 'hooks.list') return ok({ events: [{ name: 'PreToolUse', total_hooks: 2, matchers: [] }, { name: 'Stop', total_hooks: 0, matchers: [] }] })
    if (method === 'permissions.tools.get') return ok({ tools: { ...PERM_TOOLS } })
    if (method === 'permissions.tools.update') {
      if (!params.tool) { ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'tool is required' } })); return }
      if (!params.level) { ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'level is required' } })); return }
      PERM_TOOLS[String(params.tool)] = String(params.level)
      return ok({ tools: { ...PERM_TOOLS } })
    }
    if (method === 'permissions.tools.delete') {
      if (!params.tool) { ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'tool is required' } })); return }
      delete PERM_TOOLS[String(params.tool)]
      return ok({ tools: { ...PERM_TOOLS } })
    }
    if (method === 'permissions.rules.get') return ok({ rules: [{ id: 'shell_allow_ls' }] })
    if (method === 'plugins.list') return ok({ plugins: PLUGINS.map(p => ({ ...p })) })
    if (method === 'plugins.enable' || method === 'plugins.disable') {
      const name = params.name
      if (!name) return ok({ success: false, detail: '缺少参数: name' })
      const plug = PLUGINS.find(p => p.plugin_name === name)
      if (!plug) return ok({ success: false, detail: `未找到插件: ${name}` })
      plug.enabled = method === 'plugins.enable'
      return ok({ success: true, plugin_name: name, enabled: plug.enabled })
    }
    if (method === 'project.list') return ok({ projects: [{ project_id: 'default', name: 'Default', is_default: true, project_dir: '', work_mode: 'work' }] })
    if (method === 'project.info') {
      return ok({ project: { project_id: params.project_id || 'default', name: 'Default', is_default: true, project_dir: '', work_mode: 'work', session_count: HISTORY.size, pinned: false } })
    }
    if (method === 'project.get_sessions') {
      const sessions = [...HISTORY.keys()].map(id => ({ session_id: id, title: `mock-${id}` }))
      return ok({ sessions, total: sessions.length })
    }
    if (method === 'session.archived.list') return ok({ sessions: ARCHIVED.map(s => ({ ...s })), total: ARCHIVED.length })
    if (method === 'session.archive') {
      const ids = Array.isArray(params.session_ids) ? params.session_ids : []
      if (!ids.length) { ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'session_ids is required' } })); return }
      const results = ids.map(session_id => {
        ARCHIVED.push({ session_id, title: `archived-${session_id}` })
        return { session_id, ok: true, archived: true }
      })
      return ok({ succeeded_count: results.length, failed_count: 0, results })
    }
    if (method === 'session.unarchive') {
      const ids = Array.isArray(params.session_ids) ? params.session_ids : []
      if (!ids.length) { ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'session_ids is required' } })); return }
      const results = ids.map(session_id => {
        const i = ARCHIVED.findIndex(s => s.session_id === session_id)
        if (i >= 0) ARCHIVED.splice(i, 1)
        return { session_id, ok: true, restored: true, project_id: 'default' }
      })
      return ok({ succeeded_count: results.length, failed_count: 0, results })
    }
    if (method === 'session.switch') {
      return ok({ session_id: params.session_id, mode: 'agent.work.normal', switched: true, moa_enabled: false })
    }
    if (method === 'session.assets.list') return ok({ assets: [{ name: `asset-${params.session_id}` }] })
    if (method === 'updater.get_status') return ok({ current_version: '9.9.9', install_mode: 'pip', platform: 'linux', latest_version: '10.0.0', has_update: true })
    if (method === 'heartbeat.get_conf') return ok({ ...HEARTBEAT, active_hours: { ...HEARTBEAT.active_hours } })
    if (method === 'heartbeat.set_conf') {
      if (params.every != null) HEARTBEAT.every = Number(params.every)
      if (params.target) HEARTBEAT.target = String(params.target)
      if (params.active_hours) HEARTBEAT.active_hours = { ...params.active_hours }
      return ok({ ...HEARTBEAT, active_hours: { ...HEARTBEAT.active_hours } })
    }
    if (method === 'updater.check') return ok({ current_version: '9.9.9', latest_version: '10.0.0', has_update: true, state: 'update_available' })
    if (method === 'updater.get_conf') return ok({ enabled: true, release_api_type: 'pypi', repo_owner: 'openJiuwen', repo_name: 'jiuwenswarm', install_mode: 'pip' })
    if (method === 'agents.get') return params.name === 'mock-agent' ? ok({ agent: { name: 'mock-agent', description: 'Mock agent', tools: ['bash'] } }) : err(`Agent 不存在: ${params.name}`)
    if (method === 'skills.get') return ok({ name: params.name, description: 'Mock skill', enabled: true })
    if (method === 'skills.versions.list') return ok({ success: true, name: params.name, default_version: '1.0', versions: [{ version: '1.0' }] })
    if (method === 'skills.marketplace.list') return ok({ marketplaces: [{ name: 'anthropic', enabled: false }, { name: 'builtin', enabled: true }] })
    if (method === 'team.bindings.list') return ok({ teams: [{ team_name: 'mock-team' }] })
    if (method === 'debug.hang') return
    if (method === 'heartbeat.job.list') return ok({ jobs: [{ id: 'hb-job-1', name: 'mock-hb' }] })
    if (method === 'path.get') return ok({ chrome_path: '', headless: true, decision_mode: 'llm', decision_provider: 'openrouter', decision_model: 'typesafe/jev-1.13' })
    if (method === 'locale.get_conf') return ok({ preferred_language: 'zh' })
    if (method === 'cron.job.list') return ok({ jobs: [{ id: 'cron-1', name: 'mock-cron' }] })
    if (method === 'agent_templates.list') return ok({ templates: [{ id: 't1', packageName: 'engineering-quality-mentor', displayName: { zh: '工程质量顾问', en: 'EQM' } }] })
    if (method === 'team.list') {
      return ok({ teams: [{ name: 'mock-team', id: 'team-1' }] })
    }
    if (method === 'session.plan_status') {
      return ok({ session_id: params.session_id, in_plan: PLAN_ON.has(String(params.session_id)) })
    }
    if (method === 'command.btw') {
      const q = String(params.question || '').trim()
      if (!q) return ok({ status: 'failed', error: 'Question is required' })
      return ok({ status: 'ok', answer: `btw-mock: ${q.slice(0, 200)}` })
    }
    if (method === 'command.recap') {
      return ok({ status: 'ok', recap: `mock recap for ${params.session_id || 'session'}` })
    }


    // ── extended methods (0.2.7 /ws shapes) ──
    {
      const reply = (payload) => ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }))
      const fail = (message) => ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: message }))
      const log = () => EXTLOG.push({ method, params })
      const sid = String(params.session_id || '')
      switch (method) {
        case 'debug.ext': return reply({ log: EXTLOG.slice(), cron: [...CRON.values()], hb: [...HB.values()], rules: RULES.slice() })
        case 'schedule.list': case 'schedule.status': case 'schedule.logs': case 'schedule.check_config':
        case 'schedule.create': case 'schedule.run': case 'schedule.cancel':
          return fail(`unknown method: ${method}`)
        case 'config.get': return reply({ model_provider: 'OpenAI', model: 'mock-model', api_base: 'http://x', api_key: 'sk-secret-123', nested: { access_token: 'tok', ok: 1 }, video_api_key: '' })
        case 'mcp.show': return params.id === 'mcp-1' ? reply({ type: 'detail', item: { id: 'mcp-1', name: 'mock-mcp', description: 'Mock MCP', connection_state: 'connected', tools: [{ name: 't1' }] } }) : fail('SkillHub asset not found: ' + params.id)
        case 'skills.retrieval.search': return reply({ success: true, mode: 'auto', query: params.query, result: `- [skill] mock-skill desc: about ${params.query}` })
        case 'skills.online_search.search': return reply({ success: true, items: [{ source: 'hub', name: 'online-skill', display_name: 'Online' }] })
        case 'memory.forbidden.get': return reply({ enabled: true, patterns: ['height', 'weight'] })
        case 'personal_context.runtime.status': return reply({ state: 'CREATED', configured: false })
        case 'personal_context.runtime.get_config': return reply({ configured: false, model_id: 'openai:mock' })
        case 'personal_context.fetch.list_services': return reply({ services: [] })
        case 'cron.job.meta': return reply({ modes: ['agent'], default_mode: 'agent', default_timeout_seconds: 3600 })
        case 'cron.job.get': return CRON.has(params.id) ? reply({ job: CRON.get(params.id) }) : fail('job not found')
        case 'cron.job.preview': return CRON.has(params.id) ? reply({ next_runs: ['2026-11-01T09:00:00+08:00'] }) : fail('job not found')
        case 'cron.job.create': {
          log()
          for (const k of ['name', 'cron_expr', 'timezone', 'description', 'targets']) if (!params[k]) return fail(`${k} is required`)
          const job = { id: `cron-${CRON.size + 1}`, name: params.name, cron_expr: params.cron_expr, timezone: params.timezone, description: params.description, targets: params.targets, enabled: Boolean(params.enabled) }
          CRON.set(job.id, job); return reply({ job })
        }
        case 'cron.job.toggle': log(); if (!CRON.has(params.id)) return fail('job not found'); CRON.get(params.id).enabled = Boolean(params.enabled); return reply({ job: CRON.get(params.id) })
        case 'cron.job.run_now': log(); return CRON.has(params.id) ? reply({ accepted: true, run_id: 'cr-1' }) : fail('job not found')
        case 'cron.job.delete': log(); return CRON.delete(params.id) ? reply({ ok: true }) : fail('job not found')
        case 'heartbeat.job.meta': return reply({ limits: { min_interval_seconds: 60 }, schedule_types: ['interval'] })
        case 'heartbeat.job.get': if (SHAPE.v === '0.2.7' && !params.session_id) return fail('job belongs to another session'); return HB.has(params.id) ? reply({ job: HB.get(params.id) }) : fail('job not found')
        case 'heartbeat.job.preview': return HB.has(params.id) ? reply({ next_runs: [] }) : fail('job not found')
        case 'heartbeat.job.toggle': log(); if (SHAPE.v === '0.2.7' && !params.session_id) return fail('job belongs to another session'); if (!HB.has(params.id)) return fail('job not found'); HB.get(params.id).enabled = Boolean(params.enabled); return reply({ job: HB.get(params.id) })
        case 'heartbeat.job.run_now': case 'heartbeat.job.cancel': log(); if (SHAPE.v === '0.2.7' && !params.session_id) return fail('job belongs to another session'); return HB.has(params.id) ? reply({ accepted: true }) : fail('job not found')
        case 'heartbeat.job.delete': log(); if (SHAPE.v === '0.2.7' && !params.session_id) return fail('job belongs to another session'); return HB.delete(params.id) ? reply({ ok: true }) : fail('job not found')
        case 'team.history.get': return sid ? reply({ records: [{ summary: 'lead assigned task' }], total: 1 }) : fail('session_id is required')
        case 'team.snapshot': return reply({ members: [{ name: 'lead' }], tasks: [], team_id: 't1' })
        case 'agent_templates.show': return params.id === 't1' ? reply({ template: { id: 't1', displayName: { zh: '工程质量顾问' }, displayDescription: { zh: 'desc' }, installed: true } }) : fail('asset_id is required')
        case 'agent_groups.list': return reply({ agentGroups: [{ id: 'designer', installed: true }] })
        case 'agent_groups.show': return params.id ? reply({ group: { id: params.id, displayName: { zh: '设计' }, members: [{ id: 'lead' }] } }) : fail('asset_id is required')
        case 'project.git.status': return reply({ branch: 'main', is_dirty: false, repo_root: '/r' })
        case 'project.git.diff_status': return reply({ files: [{ status: 'M', path: 'a.js' }] })
        case 'models.validate': return reply({ ok: true, message: 'reachable' })
        case 'permissions.approval_overrides.get': return reply({ approval_overrides: [] })
        case 'permissions.owner_scopes.get': return reply({ owner_scopes: null, deny_guidance_message: '' })
        case 'document.formats': return reply({ forbidden_formats: ['.exe'] })
        case 'permissions.rules.create': {
          log(); const r = params.rule; if (!r || typeof r !== 'object') return fail('rule must be object')
          if (!r.tools || !r.pattern) return fail('tools and pattern are required')
          const rule = { id: r.id || `ui_rule_${RULES.length}`, ...r }; RULES.push(rule); return reply({ rule })
        }
        case 'permissions.rules.update': {
          log(); const r = RULES.find(x => x.id === params.id); if (!r) return fail('rule not found'); Object.assign(r, params.patch || {}); return reply({ rule: r })
        }
        case 'permissions.rules.delete': {
          log(); const i = RULES.findIndex(x => x.id === params.id); if (i < 0) return fail('rule not found'); RULES.splice(i, 1); return reply({ ok: true })
        }
        case 'session.message.continue_queued': log(); return reply({ continued: 0, session_id: sid })
        case 'chat.swarmflow_reply': {
          log(); ANSWERS.push({ via: 'chat.swarmflow_reply', ...params })
          reply({ ok: true })
          const k = SWARM_WAIT.get(sid); if (k) { SWARM_WAIT.delete(sid); k() }
          return
        }
        case 'document.persist': log(); return reply({ media_items: (params.documents || []).map(d => ({ type: 'document', path: `/uploads/${d.filename || d.name}`, filename: d.filename || d.name })) })
        case 'media.discard': log(); return params.path ? reply({ ok: true, path: params.path }) : fail('path is required')
        case 'skills.files.list': return params.name ? reply({ name: params.name, files: [{ path: 'SKILL.md', type: 'file', size: 12, mime_type: 'text/markdown' }, { path: 'refs', type: 'directory', size: null }] }) : fail('缺少参数: name')
        case 'skills.files.get': {
          if (!params.name) return fail('缺少参数: name')
          if (!params.path) return fail('缺少参数: path')
          if (params.path === 'refs') return fail('不允许预览目录')
          return reply({ name: params.name, path: params.path, type: 'file', mime_type: 'text/markdown', size: 20, preview: '# mock skill file\n' })
        }
        case 'skills.retrieval.status': return reply({ enabled: true, index_enabled: false, mode: 'auto', candidate_scale: 'small', estimated_candidate_tokens: 100, candidate_budget_tokens: 2000, effective_strategy: 'legacy' })
        case 'skills.retrieval.tree': return reply({ success: false, unsupported: true, tree_supported: false, nodes: [], detail: 'use list' })
        case 'skills.graph.status': return reply({ success: true, exists: false, stale: true, skill_count: 3, added_count: 3, removed_count: 0, graph_dir: '/mock/graph' })
        case 'skills.graph.get': return reply({ success: false, detail: '技能总谱不存在或不完整', graph_dir: '/mock/graph' })
        case 'skills.evolution.status': return params.name ? reply({ name: params.name, exists: false }) : fail('缺少参数: name')
        case 'skills.evolution.get': return params.name ? reply({ name: params.name, exists: false, valid: true, version: '1.0.0', entries: [] }) : fail('缺少参数: name')
        case 'skills.experience.list': return reply({ success: true, enabled: false, candidates: [] })
        case 'agent_templates.file.list': return params.id ? reply({ tree: [{ path: 'persona/', type: 'dir', children: [{ path: 'persona/a.md', type: 'file', size: 10, previewable: true }] }] }) : fail('invalid agent_template name: empty')
        case 'agent_templates.file.read': return (params.id && params.path) ? reply({ path: params.path, preview: 'template body', size: 12 }) : fail('path required')
        case 'agent_groups.file.list': return params.id ? reply({ tree: [{ path: 'agents/', type: 'dir', children: [{ path: 'agents/x.md', type: 'file', size: 5 }] }] }) : fail('invalid agent_group name: empty')
        case 'agent_groups.file.read': return (params.id && params.path) ? reply({ path: params.path, preview: 'group body', size: 10 }) : fail('path required')
        case 'plugin_packages.list': return reply({ packages: [{ id: 'pkg1', packageName: 'mock-pkg', displayName: { en: 'Mock Pkg' }, installed: true }] })
        case 'plugin_packages.show': return params.id === 'pkg1' || params.id === 'mock-pkg' ? reply({ package: { id: 'pkg1', packageName: 'mock-pkg', displayName: { en: 'Mock Pkg' }, displayDescription: { en: 'desc' }, installed: true } }) : fail('SkillHub asset not found: ' + params.id)
        case 'extensions.list': return reply({ extensions: [] })
        case 'vendors.list': return reply({ vendors: { reasoning: { protocol_defaults: {} }, openai: { plans: ['custom_api'] } } })
        case 'vendors.fetch_models': {
          log()
          if (!params.vendor_key || !params.plan) return fail('invalid plan: ')
          if (!['token_plan', 'coding_plan', 'custom_api'].includes(params.plan)) return fail('invalid plan: ' + params.plan)
          // never require api_key in mock — preset fallback
          return reply({ models: ['mock-model-a', 'mock-model-b'], source: 'preset', reason: params.api_key ? 'remote' : 'api_key required for fetch' })
        }
        case 'openai_account.auth.status': return reply({ authenticated: false, has_refresh_token: false, needs_refresh: false, error: 'openai_account_auth_missing', base_url: 'https://chatgpt.com/backend-api/codex', access_token: '' })
        case 'openai_account.models.list': return reply({ models: ['gpt-mock'], base_url: 'https://chatgpt.com/backend-api/codex', auth: { authenticated: false } })
        case 'health_check.get_conf': return reply({ every: 3600, target: 'web', active_hours: { start: '08:00', end: '22:00' } })
        case 'project.pinned_sessions': return reply({ sessions: [] })
        case 'project.get_cron_sessions': return params.project_id ? reply({ sessions: [], total: 0 }) : fail('project_id is required')
        case 'project.git.probe': case 'project.git.turn_diff_list': case 'project.git.turn_diff':
          return fail('git operations not available for this project')
        case 'assets.publish.describe': case 'assets.publish.status': case 'assets.publish.records':
          return fail('AUTH_REQUIRED')
        case 'assets.publish.local_status':
          if (!params.kind || !params.local_id) return fail('INVALID_PARAMETERS')
          return fail('RESOURCE_NOT_FOUND')
        case 'mcp.cancel_connect': return params.name ? reply({ name: params.name, cancelled: true }) : fail('mcp name is required')
        case 'mcp.wait_auth': return params.name ? reply({ name: params.name, type: 'connected' }) : fail('mcp name is required')
        case 'permissions.tools.set': {
          log()
          if (!params.tools || typeof params.tools !== 'object') return fail('tools must be object')
          return reply({ ok: true })
        }
        case 'cron.job.update': {
          log()
          if (!params.id || !params.patch || typeof params.patch !== 'object') return fail('id and patch required')
          if (!CRON.has(params.id)) return fail('job not found')
          Object.assign(CRON.get(params.id), params.patch)
          return reply({ job: CRON.get(params.id) })
        }
        case 'heartbeat.job.create': {
          log()
          if (!params.name || !params.prompt) return fail('name and prompt required')
          const job = { id: `hb-${HB.size + 1}`, name: params.name, prompt: params.prompt, enabled: Boolean(params.enabled), schedule: params.schedule }
          HB.set(job.id, job); return reply({ job })
        }
        case 'heartbeat.job.update': {
          log()
          if (!params.id || !params.patch || typeof params.patch !== 'object') return fail('id and patch required')
          if (SHAPE.v === '0.2.7' && !params.session_id) return fail('job belongs to another session')
          if (!HB.has(params.id)) return fail('job not found')
          Object.assign(HB.get(params.id), params.patch)
          return reply({ job: HB.get(params.id) })
        }
        case 'channel.get': return reply({ channels: [{ channel_id: 'web' }, { channel_id: 'tui' }] })
        case 'channel.feishu.get_conf': return reply({ config: { enabled: false, apps: [{ name: 'a', app_id: 'cli_1', app_secret: 'very-secret', encrypt_key: 'ek', verification_token: 'vt' }] } })
        case 'rsi.task.list': return reply({ tasks: [{ task_id: 'rt1', status: 'done' }] })
        case 'rsi.harness.versions.list': return reply({ active_installation_id: null, versions: [] })
        case 'rsi.task.get': case 'rsi.report.get': case 'rsi.tree.get': case 'rsi.usage.get': case 'rsi.artifact.files.list':
          return params.task_id === 'rt1' ? reply({ task_id: 'rt1', ok: true, token: 'tok-x' }) : fail(params.task_id ? `任务不存在: ${params.task_id}` : 'task_id 必填')
        case 'personal_context.context.search_pages': return reply({ results: [{ title: `page about ${params.query}` }] })
        case 'personal_context.fetch.get_run_status': return reply({ services: [] })
        case 'personal_context.fetch.get_authorization_status': return params.provider ? reply({ provider: params.provider, authorized: false }) : fail('请求参数无效')
        case 'issue.matrix': case 'issue.state.list': return fail(`unknown method: ${method}`)
        case 'harness.packages': return reply({ error: '缺少 GitCode Access Token' })
        case 'skills.teamskillshub.search': return reply({ issues: [{ title: 'team-skill' }] })
        case 'skills.teamskillshub.info': return reply({ packages: [], active_package_ids: [], native_version: { id: 'native', extension_name: 'Native Agent' } })
        case 'skills.swarmskillshub.detail': return reply({ success: false, detail: 'asset_id 无效' })
        case 'skills.swarmskillshub.recommend': return reply({ items: [{ name: 'rec-1' }] })
        case 'skills.skillnet.search': case 'skills.clawhub.search': return params.q ? reply({ success: true, items: [{ name: `${method.split('.')[1]}-hit` }] }) : reply({ success: false, detail: '缺少参数: q' })
        case 'skills.marketplace.toggle': log(); return reply({ name: params.name, enabled: Boolean(params.enabled) })
        case 'extensions.toggle': log(); return reply({ name: params.name, enabled: Boolean(params.enabled) })
        case 'project.rename': log(); return params.project_id === 'default' ? fail('default project cannot be renamed') : reply({ project: { project_id: params.project_id, name: params.name } })
        case 'project.pin': log(); return reply({ project: { project_id: params.project_id, pinned: Boolean(params.pinned) } })
        default: break
      }
    }
    ws.send(JSON.stringify({
      type: 'res', id: frame.id, ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: `mock has no handler for ${method}` },
    }))
  })
})

function chunkText(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length ? out : ['']
}
