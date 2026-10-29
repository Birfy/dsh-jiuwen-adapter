/**
 * dsh slash command `/jiuwen <sub>` (ctx.commands, @deepseek-ai/dsh-commands) mapped to Jiuwen Gateway RPCs.
 * A single namespaced command avoids clashing with dsh built-ins (/compact, /goal, …).
 */

export const SUBCOMMANDS = 'status | models | model <name|default> | compact | interrupt | sessions | skills | agents | mcp'

/**
 * @param {{ sessions: import('./session-store.js').SessionStore, gateway: () => import('./gateway-transport.js').GatewayTransport, config: () => any }} deps
 */
export function createJiuwenCommand(deps) {
  const names = (list, key = 'name') => (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x?.[key] || x?.name || x?.id)).filter(Boolean)
  async function run(sessionId, rawInput) {
    const [sub = 'status', ...rest] = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const g = deps.gateway()
    const mapping = deps.sessions.ensure(String(sessionId))
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
          ...(title ? [`title: ${title}`] : []),
          ...(meta.status === 'rejected' ? [`metadata: unavailable (${String(meta.reason?.message || meta.reason).slice(0, 120)})`] : []),
        ].join('\n')
      }
      case 'models': {
        const r = await g.modelsList()
        const list = (r?.models || []).map(x => `${x.model_name === r.active_model ? '★' : ' '} ${x.model_name}${x.model_name === mapping.modelName ? '  ← this session' : ''}`)
        return list.length ? `Jiuwen models (★ = Jiuwen default):\n${list.join('\n')}` : 'Jiuwen reports no models'
      }
      case 'model': {
        if (!arg) return `model: ${mapping.modelName || 'Jiuwen default'} — usage: /jiuwen model <name|default>`
        if (arg === 'default') { deps.sessions.update?.(String(sessionId), { modelName: undefined }); return 'This session now uses the Jiuwen default model.' }
        const r = await g.modelsList()
        const known = (r?.models || []).map(x => x.model_name)
        if (known.length && !known.includes(arg)) return `Unknown Jiuwen model "${arg}". Available: ${known.join(', ')}`
        deps.sessions.update?.(String(sessionId), { modelName: arg })
        return `This session now sends model_name=${arg} to Jiuwen.`
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
      default: return `Unknown subcommand "${sub}". Usage: /jiuwen ${SUBCOMMANDS}`
    }
  }
  return {
    run,
    definition: {
      name: 'jiuwen',
      description: 'JiuwenSwarm: status, models, model switch, compact, interrupt, sessions, skills, agents, mcp',
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
