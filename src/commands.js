/**
 * dsh slash command `/jiuwen <sub>` (ctx.commands, @deepseek-ai/dsh-commands) mapped to Jiuwen Gateway RPCs.
 * A single namespaced command avoids clashing with dsh built-ins (/compact, /goal, …).
 */

const isUnknownMethod = e => /unknown method/i.test(String(e?.message || e))

export const SUBCOMMANDS =
  'status | models | model <name|default> | model-info <id|name> | mode [name|default] | pause | resume | rename <title> | pin [on|off] | fork | switch | archive | unarchive | unmap | delete | goal [get|set <text>|pause|resume|clear] | workflows [list|get <id>] | history | btw <question> | recap | skill-toggle <name> <on|off> | plan-status | supplement <text> | teams | compact | interrupt | sessions | skills [installed] | agents | tools | hooks | permissions [set <tool> <allow|ask|deny>|unset <tool>] | plugins [enable|disable <name>] | projects [info|sessions [id]] | archived | assets | version | heartbeat [set <every> [target]|jobs] | path | locale | commands | templates | cron | updater [check|conf] | agent <name> | skill-info <name> | marketplaces | bindings | mcp | mcp-reset | help'

/**
 * @param {{ sessions: import('./session-store.js').SessionStore, gateway: () => import('./gateway-transport.js').GatewayTransport, config: () => any, mcpBridge?: any }} deps
 */
export const HELP_GROUPS = [
  ['Session', 'status, rename <title>, pin [on|off], fork, switch, archive, unarchive, unmap, delete, sessions, archived, assets, history'],
  ['Turn control', 'pause, resume, interrupt, compact, btw <question>, recap, supplement <text>, goal [get|set <text>|pause|resume|clear], plan-status, workflows [list|get <id>]'],
  ['Models & mode', 'models, model <name|default>, model-info <id|name>, mode [name|default]'],
  ['Skills & agents', 'skills [installed], skill-info <name>, skill-toggle <name> <on|off>, marketplaces, agents, agent <name>, tools, templates, teams, bindings'],
  ['Config & policy', 'hooks, permissions [set <tool> <allow|ask|deny>|unset <tool>], plugins [enable|disable <name>], heartbeat [set <every> [target]|jobs], cron, path, locale, commands, projects [info|sessions [id]]'],
  ['System', 'version, updater [check|conf], mcp, mcp-reset, help'],
]
export const helpText = () => `Usage: /jiuwen <subcommand>\n${HELP_GROUPS.map(([k, v]) => `${k}: ${v}`).join('\n')}`

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
      case 'model-info': {
        if (!arg) return 'Usage: /jiuwen model-info <id|name>'
        const listed = await g.modelsList()
        const models = listed?.models || []
        // 0.2.5b1 entries carry model_id/id/name; 0.2.7 only model_name/alias/origin_index.
        const keys = x => [x.model_id, x.model_name, x.id, x.name, x.alias, x.origin_index != null ? `#${x.origin_index}` : undefined].filter(v => v != null && v !== '').map(String)
        const hit = models.find(x => keys(x).includes(arg)) || models.find(x => keys(x).some(k => k.toLowerCase() === arg.toLowerCase()))
        const modelId = hit?.model_id || (arg.startsWith('mdl_') ? arg : undefined)
        if (!hit && !modelId) {
          const known = models.map(x => x.model_id || x.model_name || x.alias || x.id).filter(Boolean)
          return `Unknown model "${arg}". Try a name from /jiuwen models (e.g. ${known.slice(0, 5).join(', ') || 'none'}).`
        }
        let m = hit || {}
        if (modelId) {
          try { const r = await g.modelsGet(modelId); m = r?.model || r || m } catch (e) {
            if (!hit || !isUnknownMethod(e)) throw e
          }
        }
        const cfg = m?.model_client_config || {}
        const name = cfg.model_name || m?.model_name || hit?.model_name || arg
        const label = modelId || name
        const bits = [modelId ? `model-info ${modelId}: ${name}` : `model-info ${name}`]
        const alias = m?.alias || hit?.alias
        if (alias && alias !== label) bits.push(`alias=${alias}`)
        if (cfg.client_provider || m?.model_provider) bits.push(`provider=${cfg.client_provider || m.model_provider}`)
        if (cfg.api_base || m?.api_base) bits.push(`api_base=${cfg.api_base || m.api_base}`)
        if (cfg.endpoint_profile || m?.endpoint_profile) bits.push(`profile=${cfg.endpoint_profile || m.endpoint_profile}`)
        if (m?.context_window_tokens) bits.push(`context=${m.context_window_tokens}`)
        if (m?.is_default || hit?.is_default || (!modelId && name === listed?.active_model)) bits.push('default')
        // never print the key itself (0.2.7 models.list includes api_key in clear)
        const hasKey = cfg.has_api_key ?? m?.has_api_key ?? (typeof m?.api_key === 'string' ? m.api_key.length > 0 : undefined)
        if (hasKey !== undefined) bits.push(`api_key=${hasKey ? 'set' : 'missing'}`)
        return bits.join('; ')
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
      case 'switch': {
        const r = await g.sessionSwitch(sid)
        return `Switched Jiuwen session context to ${r?.session_id || sid}${r?.mode ? ` (mode=${r.mode})` : ''}${r?.switched === false ? ' (already active)' : ''}.`
      }
      case 'archive': {
        const r = await g.sessionArchive(sid)
        const row = r?.results?.[0]
        const ok = (r?.succeeded_count > 0) || row?.ok || row?.archived
        if (!ok) return `Archive failed for ${sid}: ${row?.error || r?.error || `failed_count=${r?.failed_count ?? '?'}`}`
        return `Archived Jiuwen session ${sid}.`
      }
      case 'unarchive': {
        const r = await g.sessionUnarchive(sid)
        const row = r?.results?.[0]
        const ok = (r?.succeeded_count > 0) || row?.ok || row?.restored
        if (!ok) return `Unarchive failed for ${sid}: ${row?.error || r?.error || `failed_count=${r?.failed_count ?? '?'}`}`
        return `Unarchived Jiuwen session ${sid}.`
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
      case 'btw': {
        if (!arg) return 'Usage: /jiuwen btw <question>'
        const r = await g.btw(sid, arg)
        const text = r?.answer ?? r?.content ?? r?.text ?? r?.result ?? r?.recap
          ?? (r?.status ? `status=${r.status}${r.error ? ` error=${r.error}` : ''}` : null)
          ?? JSON.stringify(r).slice(0, 300)
        return `btw: ${short(text, 400)}`
      }
      case 'recap': {
        const r = await g.recap(sid)
        const text = r?.recap ?? r?.summary ?? r?.answer ?? r?.content ?? r?.text ?? r?.result
          ?? (r?.status ? `status=${r.status}${r.error ? ` error=${r.error}` : ''}` : null)
          ?? JSON.stringify(r).slice(0, 400)
        return `recap: ${short(text, 500)}`
      }
      case 'skill-toggle': {
        const name = rest[0]
        const flag = String(rest[1] || '').toLowerCase()
        if (!name || !['on', 'off'].includes(flag)) return 'Usage: /jiuwen skill-toggle <name> <on|off>'
        const enabled = flag === 'on'
        const r = await g.skillsToggle(name, enabled)
        return `Skill ${r?.name || name} ${r?.enabled ?? enabled ? 'enabled' : 'disabled'}.`
      }
      case 'plan-status': {
        const r = await g.planStatus(sid)
        const bits = [`plan-status for ${sid}`]
        if (r?.in_plan !== undefined) bits.push(`in_plan=${r.in_plan}`)
        if (r?.plan_mode !== undefined) bits.push(`plan_mode=${r.plan_mode}`)
        if (r?.mode !== undefined) bits.push(`mode=${r.mode}`)
        if (r?.status !== undefined) bits.push(`status=${r.status}`)
        const known = r?.in_plan !== undefined || r?.plan_mode !== undefined || r?.mode !== undefined || r?.status !== undefined
        return known ? bits.join('; ') : `plan-status for ${sid}: ${JSON.stringify(r).slice(0, 300)}`
      }
      case 'supplement': {
        if (!arg) return 'Usage: /jiuwen supplement <text>'
        // Wire: chat.interrupt {intent:'supplement', new_input} (Jiuwen Gateway → AgentServer); not chat.send is_supplement.
        await g.chatInterrupt(sid, 'supplement', { new_input: arg })
        return `Sent chat.interrupt (supplement) to Jiuwen session ${sid}.`
      }
      case 'teams': {
        // 0.2.5b1: team.list; 0.2.7 dropped it — fall back to team.bindings.list ({ teams: [...] }).
        const teamsCall = g.teamList().catch(e => {
          if (!isUnknownMethod(e) || !g.teamBindingsList) throw e
          return g.teamBindingsList()
        })
        const [templates, teams] = await Promise.allSettled([g.teamTemplatesList(), teamsCall])
        const tNames = templates.status === 'fulfilled'
          ? names(templates.value?.templates || templates.value?.items, 'template_id')
          : []
        const teamNames = teams.status === 'fulfilled'
          ? names(teams.value?.teams || teams.value?.items, 'team_name')
          : []
        const lines = []
        if (tNames.length) lines.push(`templates: ${tNames.join(', ')}`)
        else if (templates.status === 'rejected') lines.push(`templates: unavailable (${String(templates.reason?.message || templates.reason).slice(0, 80)})`)
        else lines.push('templates: none')
        if (teamNames.length) lines.push(`teams: ${teamNames.join(', ')}`)
        else if (teams.status === 'rejected') lines.push(`teams: unavailable (${String(teams.reason?.message || teams.reason).slice(0, 80)})`)
        else lines.push('teams: none')
        return `Jiuwen teams:\n${lines.join('\n')}`
      }
      case 'skills': {
        if ((rest[0] || '').toLowerCase() === 'installed') {
          const r = await g.skillsInstalled()
          return `Jiuwen installed skills: ${names(r?.skills || r?.plugins || r?.items || r?.installed).join(', ') || 'none'}`
        }
        const r = await g.skillsList()
        return `Jiuwen skills: ${names(r?.skills || r?.items).join(', ') || 'none'}`
      }
      case 'agents': { const r = await g.agentsList(); return `Jiuwen agents: ${names(r?.agents || r?.items).join(', ') || 'none'}` }
      case 'tools': {
        const r = await g.agentsToolsList()
        const tools = Array.isArray(r?.tools) ? r.tools : []
        return `Jiuwen tools (${tools.length}): ${names(tools).join(', ') || 'none'}`
      }
      case 'hooks': {
        const r = await g.hooksList()
        const ev = Array.isArray(r?.events) ? r.events : []
        const total = ev.reduce((n, e) => n + (Number(e?.total_hooks) || 0), 0)
        const active = ev.filter(e => Number(e?.total_hooks) > 0).map(e => `${e.name}=${e.total_hooks}`)
        return `Jiuwen hooks: ${total} across ${ev.length} events${active.length ? ` (${active.join(', ')})` : ''}`
      }
      case 'permissions': {
        const action = (rest[0] || '').toLowerCase()
        if (action === 'set') {
          const tool = rest[1]
          const level = String(rest[2] || '').toLowerCase()
          if (!tool || !['allow', 'ask', 'deny'].includes(level)) return 'Usage: /jiuwen permissions set <tool> <allow|ask|deny>'
          const r = await g.permissionsToolsUpdate(tool, level)
          const got = r?.tools?.[tool]
          return `Permission ${tool}=${got || level}.`
        }
        if (action === 'unset') {
          const tool = rest[1]
          if (!tool) return 'Usage: /jiuwen permissions unset <tool>'
          await g.permissionsToolsDelete(tool)
          return `Removed permission override for ${tool}.`
        }
        if (action && !['get', 'list'].includes(action)) return 'Usage: /jiuwen permissions [set <tool> <allow|ask|deny>|unset <tool>]'
        const [tools, rules] = await Promise.allSettled([g.permissionsToolsGet(), g.permissionsRulesGet()])
        const lines = []
        if (tools.status === 'fulfilled') {
          const map = tools.value?.tools && typeof tools.value.tools === 'object' ? tools.value.tools : {}
          const by = {}
          for (const [k, v] of Object.entries(map)) (by[String(v)] ||= []).push(k)
          const ask = by.ask || []
          const deny = by.deny || []
          lines.push(`tools: ${Object.entries(by).map(([k, v]) => `${k}=${v.length}`).join(', ') || 'none'}`)
          if (ask.length) lines.push(`ask: ${ask.join(', ')}`)
          if (deny.length) lines.push(`deny: ${deny.join(', ')}`)
        } else lines.push(`tools: unavailable (${short(tools.reason?.message || tools.reason, 80)})`)
        if (rules.status === 'fulfilled') lines.push(`rules: ${(rules.value?.rules || []).length}`)
        else lines.push(`rules: unavailable (${short(rules.reason?.message || rules.reason, 80)})`)
        return `Jiuwen permissions:
${lines.join('\n')}`
      }
      case 'plugins': {
        const action = (rest[0] || 'list').toLowerCase()
        if (action === 'enable' || action === 'disable') {
          const name = rest[1]
          if (!name) return `Usage: /jiuwen plugins ${action} <name>`
          const r = action === 'enable' ? await g.pluginsEnable(name) : await g.pluginsDisable(name)
          if (r?.success === false) return `Plugin ${action} failed: ${r.detail || 'unknown'}`
          return `Plugin ${name} ${action}d.`
        }
        if (action !== 'list') return 'Usage: /jiuwen plugins [enable|disable <name>]'
        const r = await g.pluginsList()
        const list = (r?.plugins || []).map(p => `${p.plugin_name || p.name}${p.enabled === false ? ' (disabled)' : ''}`)
        return `Jiuwen plugins: ${list.join(', ') || 'none'}`
      }
      case 'projects': {
        const action = (rest[0] || 'list').toLowerCase()
        const resolveProjectId = async (raw) => {
          if (raw) return raw
          const listed = await g.projectList().catch(() => null)
          const projects = listed?.projects || []
          const def = projects.find(p => p.is_default) || projects[0]
          return def?.project_id || 'default'
        }
        if (action === 'info') {
          const id = await resolveProjectId(rest[1])
          const r = await g.projectInfo(id)
          const p = r?.project || r
          const pid = p?.project_id || r?.project_id || id || '?'
          const bits = [`project ${p?.name || pid} (${pid})`]
          if (p?.work_mode || r?.work_mode) bits.push(`mode=${p?.work_mode || r.work_mode}`)
          if (p?.is_default || r?.is_default) bits.push('default')
          if (p?.pinned || r?.pinned) bits.push('pinned')
          if ((p?.session_count ?? r?.session_count) != null) bits.push(`sessions=${p?.session_count ?? r.session_count}`)
          if (p?.project_dir || r?.project_dir) bits.push(`dir=${p?.project_dir || r.project_dir}`)
          return bits.join('; ')
        }
        if (action === 'sessions') {
          const id = await resolveProjectId(rest[1])
          const r = await g.projectGetSessions(id)
          const list = (r?.sessions || []).slice(0, 15).map(s => `- ${s.session_id || s.id}${s.title ? `  ${short(s.title, 40)}` : ''}`)
          return list.length
            ? `Project sessions (${r?.total ?? list.length}):
${list.join('\n')}`
            : `No sessions for project ${id || 'default'}`
        }
        if (action !== 'list') return 'Usage: /jiuwen projects [info|sessions [id]]'
        const r = await g.projectList()
        const seen = new Set()
        const list = (r?.projects || []).filter(p => { const k = p.project_id || p.name; if (seen.has(k)) return false; seen.add(k); return true }).map(p => `${p.name || p.project_id}${p.name && p.project_id ? ` (${p.project_id}${p.work_mode ? `, ${p.work_mode}` : ''})` : ''}${p.is_default ? ' [default]' : ''}${p.project_dir ? ` → ${p.project_dir}` : ''}`)
        return `Jiuwen projects: ${list.join('; ') || 'none'}`
      }
      case 'archived': {
        const r = await g.sessionArchivedList()
        const list = (r?.sessions || []).map(x => short(x.title || x.session_id || x.id, 60))
        return `Jiuwen archived sessions (${r?.total ?? list.length}): ${list.join(', ') || 'none'}`
      }
      case 'assets': {
        let r
        try { r = await g.sessionAssetsList(sid) } catch (e) {
          if (!isUnknownMethod(e)) throw e
          return `Jiuwen session assets: not available — this Gateway (JiuwenSwarm ≥0.2.7) no longer routes session.assets.list on /ws and has no replacement. Use /jiuwen projects info or the Jiuwen web UI to browse session files.`
        }
        const list = (r?.assets || []).map(x => x.name || x.path || x.asset_id || x.id).filter(Boolean)
        return `Jiuwen session assets (${sid}): ${list.join(', ') || 'none'}`
      }
      case 'version': {
        const r = await g.updaterStatus()
        const latest = r?.latest_version ? `, latest ${r.latest_version}${r.has_update ? ' (update available)' : ''}` : ''
        return `JiuwenSwarm ${r?.current_version || 'unknown'} (${r?.install_mode || '?'}, ${r?.platform || '?'})${latest}`
      }
      case 'heartbeat': {
        const action = (rest[0] || 'get').toLowerCase()
        if (action === 'set') {
          const every = Number(rest[1])
          if (!Number.isFinite(every) || every <= 0) return 'Usage: /jiuwen heartbeat set <every-seconds> [target]'
          const target = rest[2]
          const cur = await g.heartbeatConf().catch(() => ({}))
          const r = await g.heartbeatSetConf({
            every,
            ...(target ? { target } : (cur?.target ? { target: cur.target } : {})),
            ...(cur?.active_hours ? { active_hours: cur.active_hours } : {}),
          })
          return `Heartbeat set: every ${r?.every ?? every}s → ${r?.target || target || cur?.target || '?'}`
        }
        if (action === 'jobs') {
          const r = await g.heartbeatJobList()
          const jobs = r?.jobs || []
          if (!jobs.length) return 'Jiuwen heartbeat jobs: none'
          return `Jiuwen heartbeat jobs (${jobs.length}):
${jobs.slice(0, 15).map(j => `- ${j.id || j.job_id || j.name || JSON.stringify(j).slice(0, 80)}`).join('\n')}`
        }
        if (action !== 'get') return 'Usage: /jiuwen heartbeat [set <every> [target]|jobs]'
        const r = await g.heartbeatConf()
        const h = r?.active_hours ? `, active ${r.active_hours.start}-${r.active_hours.end}` : ''
        return `Jiuwen heartbeat: every ${r?.every ?? '?'}s → ${r?.target || '?'}${h}`
      }
      case 'path': {
        const r = await g.pathGet()
        const bits = []
        if (r?.chrome_path !== undefined) bits.push(`chrome=${r.chrome_path || '(empty)'}`)
        if (r?.headless !== undefined) bits.push(`headless=${r.headless}`)
        if (r?.decision_mode) bits.push(`decision=${r.decision_mode}${r.decision_provider ? `/${r.decision_provider}` : ''}${r.decision_model ? `:${r.decision_model}` : ''}`)
        return bits.length ? `Jiuwen path: ${bits.join('; ')}` : `Jiuwen path: ${JSON.stringify(r).slice(0, 300)}`
      }
      case 'locale': {
        const r = await g.localeGetConf()
        return `Jiuwen locale: ${r?.preferred_language || JSON.stringify(r).slice(0, 200)}`
      }
      case 'commands': {
        const r = await g.commandsList()
        const list = (r?.commands || []).map(c => c.name || c.id).filter(Boolean)
        return `Jiuwen gateway commands (${list.length}): ${list.slice(0, 40).join(', ') || 'none'}`
      }
      case 'templates': {
        const r = await g.agentTemplatesList()
        const list = (r?.templates || []).map(t => {
          const name = t.packageName || t.displayName?.zh || t.displayName?.en || t.id || t.name
          return typeof name === 'string' ? name : JSON.stringify(name)
        })
        return `Jiuwen agent templates (${list.length}): ${list.slice(0, 20).join(', ') || 'none'}`
      }
      case 'cron': {
        const r = await g.cronJobList()
        const jobs = r?.jobs || []
        if (!jobs.length) return 'Jiuwen cron jobs: none'
        return `Jiuwen cron jobs (${jobs.length}):
${jobs.slice(0, 15).map(j => `- ${j.id || j.job_id || j.name || JSON.stringify(j).slice(0, 80)}`).join('\n')}`
      }
      case 'mcp': { const r = await g.mcpList(); return `Jiuwen MCP servers: ${(r?.items || []).map(x => `${x.name}${x.connection_state ? ` (${x.connection_state})` : ''}`).join(', ') || 'none'}` }
      case 'mcp-reset': {
        if (!deps.mcpBridge?.unregister) return 'dsh tool passthrough is not available'
        const r = await deps.mcpBridge.unregister()
        const ok = (x) => (x && typeof x === 'object' ? (x.ok === false ? 'failed' : 'ok') : String(x))
        return `Removed Jiuwen MCP registration "${deps.config().mcpServerName}" (disconnect: ${ok(r.disconnect)}, delete: ${ok(r.delete)}); the next passthrough turn re-registers it`
      }
      case 'updater': {
        const action = (rest[0] || 'status').toLowerCase()
        if (action === 'conf') {
          const r = await g.updaterConf()
          return `Jiuwen updater: ${r?.enabled === false ? 'disabled' : 'enabled'}, source ${r?.release_api_type || '?'}${r?.repo_owner ? ` (${r.repo_owner}/${r.repo_name || '?'})` : ''}, install ${r?.install_mode || '?'}`
        }
        if (action !== 'status' && action !== 'check') return 'Usage: /jiuwen updater [check|conf]'
        const r = action === 'check' ? await g.updaterCheck() : await g.updaterStatus()
        const state = r?.has_update ? `update available: ${r.latest_version}` : (r?.latest_version ? `up to date (latest ${r.latest_version})` : 'no check result yet')
        return `Jiuwen updater ${action}: ${r?.current_version || 'unknown'} → ${state} [state=${r?.state || '?'}]${r?.error ? ` error: ${short(r.error, 100)}` : ''} (read-only; does not download or upgrade)`
      }
      case 'agent': {
        if (!arg) return 'Usage: /jiuwen agent <name> (see /jiuwen agents)'
        const r = await g.agentsGet(arg)
        const a = r?.agent || r || {}
        const tools = Array.isArray(a.tools) ? a.tools : []
        return `Jiuwen agent ${a.name || arg}: ${short(a.description, 160) || '(no description)'}${a.model ? `\nmodel: ${a.model}` : ''}${tools.length ? `\ntools: ${names(tools).join(', ')}` : ''}`
      }
      case 'skill-info': {
        if (!arg) return 'Usage: /jiuwen skill-info <name> (see /jiuwen skills)'
        const [info, vers] = await Promise.allSettled([g.skillsGet(arg), g.skillsVersionsList(arg)])
        if (info.status === 'rejected') throw info.reason
        const s = info.value || {}
        const v = vers.status === 'fulfilled' ? (vers.value?.versions || []) : []
        const vtxt = v.length ? names(v, 'version').join(', ') : 'none'
        return `Jiuwen skill ${s.name || arg}: ${short(s.description, 160) || '(no description)'}${s.enabled === false ? ' [disabled]' : ''}\nversions: ${vtxt}${vers.value?.default_version ? ` (default ${vers.value.default_version})` : ''}`
      }
      case 'marketplaces': {
        const r = await g.skillsMarketplaceList()
        const m = Array.isArray(r?.marketplaces) ? r.marketplaces : []
        return `Jiuwen skill marketplaces (${m.length}): ${m.map(x => `${x.name}${x.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`
      }
      case 'bindings': {
        const r = await g.teamBindingsList()
        const t = r?.teams || r?.bindings || []
        return `Jiuwen team bindings: ${names(t, 'team_name').join(', ') || 'none'}`
      }
      case 'help': return helpText()
      default: return `Unknown subcommand "${sub}".\n${helpText()}`
    }
  }
  return {
    run,
    definition: {
      name: 'jiuwen',
      description: 'JiuwenSwarm: status, models/model/model-info, mode, pause/resume, rename, pin, fork, switch, archive/unarchive, unmap/delete, goal, workflows, history, btw, recap, skill-toggle, plan-status, supplement, teams, compact, interrupt, sessions, skills, agents, tools, hooks, permissions, plugins, projects, archived, assets, version, heartbeat, path, locale, commands, templates, cron, updater, agent, skill-info, marketplaces, bindings, mcp, help',
      input: { hint: SUBCOMMANDS },
      async handler(invocation) {
        try {
          return { kind: 'success', text: await run(invocation.agent?.id, invocation.rawInput) }
        } catch (error) {
          const msg = String(error?.message || error)
          const hint = /unknown method/i.test(msg) ? ' (this Gateway build does not route it on /ws)' : (/timed? ?out|ETIMEDOUT/i.test(msg) ? ' (Gateway did not answer in time)' : (/ECONNREFUSED|connect|WebSocket/i.test(msg) ? ` (is the Gateway running at ${deps.config()?.gatewayURL || 'the configured URL'}?)` : ''))
          return { kind: 'error', text: `Jiuwen: ${msg.slice(0, 500)}${hint}` }
        }
      },
    },
  }
}
