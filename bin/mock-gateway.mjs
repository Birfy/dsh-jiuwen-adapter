#!/usr/bin/env node
/**
 * Jiuwen Gateway WS mock: connection.ack, chat.send (+ media/tool/subtask events),
 * and unary RPCs (history/models/mcp/memory/files/session).
 */
import { WebSocketServer } from './_ws-server.mjs'

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
      return ok({ session_id: params.session_id, in_plan: false })
    }
    if (method === 'command.btw') {
      const q = String(params.question || '').trim()
      if (!q) return ok({ status: 'failed', error: 'Question is required' })
      return ok({ status: 'ok', answer: `btw-mock: ${q.slice(0, 200)}` })
    }
    if (method === 'command.recap') {
      return ok({ status: 'ok', recap: `mock recap for ${params.session_id || 'session'}` })
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
