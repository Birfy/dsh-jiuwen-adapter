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
const LAST_PARAMS = new Map()
const CANCELLED = new Set()
const INTERRUPTS = []

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
      let reply = /ping/i.test(query) ? 'pong-from-gateway-mock' : `gateway-mock: ${query.slice(0, 200)}`
      if (/echo-params/.test(query)) {
        reply = `params mode=${params.mode} model=${params.model_name ?? '-'} agent=${params.agent_template_name ?? '-'} group=${params.agent_group_name ?? '-'} skills=${(params.skills || []).join('|') || '-'} media=${(params.media_items || []).length} prior=${prior} query=${JSON.stringify(query)}`
      }
      turns.push({ role: 'user', content: query }, { role: 'assistant', content: reply })
      HISTORY.set(sessionId, turns)

      ws.send(JSON.stringify({ type: 'res', id: rid, ok: true, payload: { accepted: true } }))
      ev('chat.processing_status', { event_type: 'chat.processing_status', is_processing: true, is_complete: false })

      if (/ask me/i.test(query)) {
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
        ev('chat.processing_status', { event_type: 'chat.processing_status', is_processing: false, is_complete: true })
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
    if (method === 'chat.interrupt') {
      CANCELLED.add(String(params.session_id || ''))
      INTERRUPTS.push(params)
      return ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { accepted: true, intent: params.intent } }))
    }
    if (method === 'debug.state') {
      return ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {
        interrupts: INTERRUPTS, last: Object.fromEntries(LAST_PARAMS), history: Object.fromEntries(HISTORY),
      } }))
    }

    // Unary RPCs
    const ok = (payload) => ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }))
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
      return ok({ session_id: params.session_id, runtime: { mode: 'agent' }, mock_auth: urlAuth })
    }
    if (method === 'skills.list') return ok({ skills: [{ name: 'mock-skill', description: 'mock' }] })
    if (method === 'agents.list') return ok({ agents: [{ name: 'mock-agent' }] })
    if (method === 'team.templates.list') return ok({ templates: [{ template_id: 'jiuwen_team' }] })
    if (method === 'session.list') return ok({ sessions: [...HISTORY.keys()].map(id => ({ session_id: id, message_count: HISTORY.get(id).length })) })
    if (method === 'session.create') return ok({ session_id: `web_mock_${Date.now()}` })
    if (method === 'commands.list') return ok({ commands: [{ name: 'compact' }] })
    if (method === 'models.list') {
      return ok({
        models: [
          { id: 'jiuwen-default', name: 'Jiuwen Default' },
          { id: 'jiuwen-swarm', name: 'Jiuwen Swarm' },
        ],
        active_model: 'jiuwen-default',
      })
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
