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
      const query = String(params.query || params.content || '')
      const sessionId = String(params.session_id || 's')
      const reply = /ping/i.test(query) ? 'pong-from-gateway-mock' : `gateway-mock: ${query.slice(0, 200)}`
      const turns = HISTORY.get(sessionId) || []
      turns.push({ role: 'user', content: query }, { role: 'assistant', content: reply })
      HISTORY.set(sessionId, turns)

      ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { accepted: true } }))

      if (params.media_items?.length || params.attachments?.media_items?.length) {
        ws.send(JSON.stringify({
          type: 'event', event: 'chat.media',
          payload: { event_type: 'chat.media', name: 'upload.png', content: 'media-ack' },
        }))
      }
      // Simulate a Jiuwen-owned tool hop
      ws.send(JSON.stringify({
        type: 'event', event: 'chat.tool_call',
        payload: { event_type: 'chat.tool_call', name: 'shell', content: '' },
      }))
      ws.send(JSON.stringify({
        type: 'event', event: 'chat.tool_result',
        payload: { event_type: 'chat.tool_result', name: 'shell', content: 'ok' },
      }))
      ws.send(JSON.stringify({
        type: 'event', event: 'chat.subtask_update',
        payload: { event_type: 'chat.subtask_update', content: 'swarm-step-1' },
      }))

      for (const piece of chunkText(reply, 20)) {
        ws.send(JSON.stringify({
          type: 'event', event: 'chat.delta',
          payload: { event_type: 'chat.delta', content: piece, request_id: frame.id },
        }))
      }
      ws.send(JSON.stringify({
        type: 'event', event: 'chat.final',
        payload: { event_type: 'chat.final', content: reply, request_id: frame.id, is_complete: true },
      }))
      ws.send(JSON.stringify({ type: 'event', event: 'stream.end', id: frame.id }))
      return
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
