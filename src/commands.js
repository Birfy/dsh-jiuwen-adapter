/**
 * dsh slash command `/jiuwen <sub>` (ctx.commands, @deepseek-ai/dsh-commands) mapped to Jiuwen Gateway RPCs.
 * A single namespaced command avoids clashing with dsh built-ins (/compact, /goal, …).
 */

export const SUBCOMMANDS =
  'status | models | model <name|default> | mode [name|default] | pause | resume | rename <title> | pin [on|off] | fork | unmap | delete | goal [get|set <text>|pause|resume|clear] | workflows [list|get <id>] | history | compact | interrupt | sessions | skills | agents | mcp | mcp-reset'

/**
 * @param {{ sessions: import('./session-store.js').SessionStore, gateway: () => import('./gateway-transport.js').GatewayTransport, config: () => any, mcpBridge?: any }} deps
 */
export function createJiuwenCommand(deps) {
  const names = (list, key = 'name') => (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x?.[key] || x?.name || x?.id)).filter(Boolean)
  const pinValue = (raw) => {
    const v = String(raw || 'on').toLowerCase()
    if (['on', 'true', '1'].includes(v)) return true
    if (['off', 'false', '0'].includes(v)) return false
    return undefined
  }
  const short = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  async function run(sessionId, rawInput) {
    const [sub = 'status', ...rest] = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const g = deps.gateway()
    const dshId = String(sessionId)
    const mapping = deps.sessions.ensure(dshId)
    const sid = mapping.jiuwenSessionId
    switch (sub) {
      case 'status': {
        const [models, meta] = await Promise.allSettled([g.modelsList(), g.sessionMetadata(sid)])
        const active = models.status === 'fulfilled' ? models.value?.active_model : undefined
        const m = meta.status === 'fulfilled' ? meta.value : undefined
        const title = m?.title || m?.metadata?.title || m?.session?.title
        return [
          `Jiuwen gateway: ${deps.config().gatewayURL}`,
          `dsh session ${sessionId} → Jiuwen session ${sid} (turns: ${mapping.turns || 0})`,
          `model: ${mapping.modelName || active || 'unknown'}${mapping.modelName ? ' (session override)' : ''}`,
          `mode: ${mapping.chatMode || m?.runtime?.mode || deps.config().chatMode || 'unknown'}${mapping.chatMode ? ' (session override)' : ''}`,
          ...(mapping.skills?.length ? [`skills: ${mapping.skills.join(', ')} (session override)`] : []),
          ...(mapping.agentTemplateName ? [`agentTemplate: ${mapping.agentTemplateName} (session override)`] : []),
          ...(title ? [`title: ${title}`] : []),
          ...(meta.status === 'rejected' ? [`metadata: unavailable (${String(meta.reason?.message || meta.reason).slice(0, 120)})`] : []),
        ].join('\n')
      }
      case 'models': {
        const r = await g.modelsList()
        const list = (r?.models || []).map(x => {
          const name = x.model_name || x.id || x.name
          return `${name === r.active_model ? '★' : ' '} ${name}${name === mapping.modelName ? '  ← this session' : ''}`
        })
        return list.length ? `Jiuwen models (★ = Jiuwen default):\n${list.join('\n')}` : 'Jiuwen reports no models'
      }
      case 'model': {
        if (!arg) return `model: ${mapping.modelName || 'Jiuwen default'} — usage: /jiuwen model <name|default>`
        if (arg === 'default') { deps.sessions.update?.(dshId, { modelName: undefined }); return 'This session now uses the Jiuwen default model.' }
        const r = await g.modelsList()
        const known = (r?.models || []).map(x => x.model_name || x.id || x.name).filter(Boolean)
        if (known.length && !known.includes(arg)) return `Unknown Jiuwen model "${arg}". Available: ${known.join(', ')}`
        deps.sessions.update?.(dshId, { modelName: arg })
        return `This session now sends model_name=${arg} to Jiuwen.`
      }
      case 'mode': {
        if (!arg) return `mode: ${mapping.chatMode || 'Jiuwen/config default'} — usage: /jiuwen mode <name|default>`
        if (arg === 'default') {
          deps.sessions.update?.(dshId, { chatMode: undefined })
          return 'This session now uses the Jiuwen/config default chat mode.'
        }
        deps.sessions.update?.(dshId, { chatMode: arg })
        return `This session now sends mode=${arg} to Jiuwen.`
      }
      case 'pause': {
        await g.chatInterrupt(sid, 'pause')
        return `Sent chat.interrupt (pause) to Jiuwen session ${sid}.`
      }
      case 'resume': {
        await g.chatInterrupt(sid, 'resume')
        return `Sent chat.interrupt (resume) to Jiuwen session ${sid}.`
      }
      case 'rename': {
        if (!arg) return 'Usage: /jiuwen rename <title>'
        const r = await g.sessionRename(sid, arg)
        const title = r?.title ?? arg
        return `Renamed Jiuwen session ${sid} → "${title}".`
      }
      case 'pin': {
        const pinned = pinValue(rest[0])
        if (pinned === undefined) return 'Usage: /jiuwen pin [on|off]'
        const r = await g.sessionPin(sid, pinned)
        return `Jiuwen session ${sid} ${r?.pinned ?? pinned ? 'pinned' : 'unpinned'}.`
      }
      case 'fork': {
        const r = await g.sessionFork(sid)
        const newId = r?.session_id || r?.new_session_id || r?.forked_session_id
        if (newId && newId !== sid) {
          // Report clearly; do not overwrite the current dsh→jiuwen mapping.
          return `Forked Jiuwen session ${sid} → new session_id=${newId} (local mapping unchanged; use a new dsh session or sessions.ensure to map it).`
        }
        return `Forked Jiuwen session ${sid}: ${JSON.stringify(r).slice(0, 300)}`
      }
      case 'unmap': {
        deps.sessions.remove?.(dshId)
        return `Removed local mapping for dsh session ${dshId} (Jiuwen session ${sid} left intact).`
      }
      case 'delete': {
        await g.sessionDelete(sid)
        deps.sessions.remove?.(dshId)
        return `Jiuwen session ${sid} deleted and local mapping cleared for dsh session ${dshId}.`
      }
      case 'goal': {
        const action = (rest[0] || 'get').toLowerCase()
        if (!['get', 'set', 'pause', 'resume', 'clear'].includes(action)) {
          return 'Usage: /jiuwen goal [get|set <text>|pause|resume|clear]'
        }
        const objective = action === 'set' ? rest.slice(1).join(' ') : undefined
        if (action === 'set' && !objective) return 'Usage: /jiuwen goal set <text>'
        const r = await g.goal(sid, { action, ...(objective !== undefined ? { objective } : {}) })
        const bits = [`goal ${action} on ${sid}`]
        if (r?.objective || objective) bits.push(`objective=${r?.objective || objective}`)
        if (r?.status) bits.push(`status=${r.status}`)
        if (r?.action && r.action !== action) bits.push(`echo=${r.action}`)
        return bits.join('; ') + (r && !r.objective && !r.status ? `: ${JSON.stringify(r).slice(0, 200)}` : '')
      }
      case 'workflows': {
        const action = (rest[0] || 'list').toLowerCase()
        if (action === 'list') {
          const r = await g.workflows(sid, 'list')
          const list = r?.workflows || r?.items || []
          if (!list.length) return `No workflows for session ${sid}`
          return `Workflows (${list.length}):\n${list.slice(0, 20).map(w => `- ${w.id || w.workflow_id || w.name || JSON.stringify(w).slice(0, 80)}`).join('\n')}`
        }
        if (action === 'get') {
          const id = rest[1]
          if (!id) return 'Usage: /jiuwen workflows get <id>'
          const r = await g.workflows(sid, 'get', { workflow_id: id, id })
          return `Workflow ${id}: ${JSON.stringify(r).slice(0, 400)}`
        }
        return 'Usage: /jiuwen workflows [list|get <id>]'
      }
      case 'history': {
        let r
        try { r = await g.historyListTurns(sid) } catch { r = await g.historyGet(sid) }
        const msgs = r?.messages || r?.turns || []
        const rows = (Array.isArray(msgs) ? msgs : []).slice(-15).map((m, i) => {
          if (typeof m === 'string') return `${i + 1}. ${short(m, 100)}`
          const role = m.role || m.type || '?'
          const content = m.content ?? m.text ?? m.message ?? ''
          const text = typeof content === 'string' ? content : Array.isArray(content)
            ? content.map(b => b?.text || '').join('') : JSON.stringify(content)
          return `${i + 1}. [${role}] ${short(text, 100)}`
        })
        return rows.length
          ? `History for ${sid} (last ${rows.length}):\n${rows.join('\n')}`
          : `No history for session ${sid}`
      }
      case 'compact': {
        const r = await g.compact(sid)
        return `Jiuwen compacted session ${sid}: ${r?.result || 'ok'}${r?.stats ? ` (${r.stats.total_messages} messages, ${r.stats.total_tokens} tokens)` : ''}`
      }
      case 'interrupt': {
        await g.chatInterrupt(sid, 'cancel')
        return `Sent chat.interrupt (cancel) to Jiuwen session ${sid}.`
      }
      case 'sessions': {
        const r = await g.sessionList()
        const list = (r?.sessions || r?.items || []).slice(0, 15).map(s => `- ${s.session_id || s.id}${s.title ? `  ${s.title}` : ''}`)
        return list.length ? `Jiuwen sessions (first ${list.length}):\n${list.join('\n')}` : 'No Jiuwen sessions'
      }
      case 'skills': { const r = await g.skillsList(); return `Jiuwen skills: ${names(r?.skills || r?.items).join(', ') || 'none'}` }
      case 'agents': { const r = await g.agentsList(); return `Jiuwen agents: ${names(r?.agents || r?.items).join(', ') || 'none'}` }
      case 'mcp': { const r = await g.mcpList(); return `Jiuwen MCP servers: ${(r?.items || []).map(x => `${x.name}${x.connection_state ? ` (${x.connection_state})` : ''}`).join(', ') || 'none'}` }
      case 'mcp-reset': {
        if (!deps.mcpBridge?.unregister) return 'dsh tool passthrough is not available'
        const r = await deps.mcpBridge.unregister()
        const ok = (x) => (x && typeof x === 'object' ? (x.ok === false ? 'failed' : 'ok') : String(x))
        return `Removed Jiuwen MCP registration "${deps.config().mcpServerName}" (disconnect: ${ok(r.disconnect)}, delete: ${ok(r.delete)}); the next passthrough turn re-registers it`
      }
      default: return `Unknown subcommand "${sub}". Usage: /jiuwen ${SUBCOMMANDS}`
    }
  }
  return {
    run,
    definition: {
      name: 'jiuwen',
      description: 'JiuwenSwarm: status, models/model, mode, pause/resume, rename, pin, fork, unmap/delete, goal, workflows, history, compact, interrupt, sessions, skills, agents, mcp',
      input: { hint: SUBCOMMANDS },
      async handler(invocation) {
        try {
          return { kind: 'success', text: await run(invocation.agent?.id, invocation.rawInput) }
        } catch (error) {
          return { kind: 'error', text: `Jiuwen: ${String(error?.message || error).slice(0, 500)}` }
        }
      },
    },
  }
}
