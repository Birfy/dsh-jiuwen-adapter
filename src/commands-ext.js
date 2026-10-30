/**
 * Extended `/jiuwen` subcommands (JiuwenSwarm 0.2.7 /ws). Each entry declares the Gateway methods it
 * needs so `/jiuwen help` hides entries whose methods this Gateway answered `unknown method` for.
 * Writes are reversible; deletes need an explicit trailing `confirm` argument.
 */

const SECRET_KEY = /(api_?key|token|secret|passw(or)?d|cookie|authorization|credential|private_?key|access_?key|client_?secret)/i

/** Deep-copy `value` replacing secret-looking fields with `***` (or `(empty)`). */
export function maskSecrets(value, depth = 0) {
  if (depth > 12) return '…'
  if (Array.isArray(value)) return value.map(v => maskSecrets(v, depth + 1))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).length ? '***' : '(empty)'
    else out[k] = maskSecrets(v, depth + 1)
  }
  return out
}

/** Split on whitespace, honouring "double" / 'single' quotes. */
export function tokenize(input) {
  const out = []
  const str = String(input || '')
  let cur = null
  let quote = null
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < str.length) { cur += str[++i]; continue }
      if (ch === quote) { quote = null; continue }
      cur += ch
    } else if (ch === '"' || ch === "'") { quote = ch; cur ??= '' } else if (/\s/.test(ch)) {
      if (cur !== null) { out.push(cur); cur = null }
    } else cur = (cur ?? '') + ch
  }
  if (cur !== null) out.push(cur)
  return out
}

/** `key=value` pairs (value may be quoted as a whole token: key="a b"). */
export function kv(tokens) {
  const o = {}
  for (const t of tokens) {
    const i = t.indexOf('=')
    if (i > 0) o[t.slice(0, i)] = t.slice(i + 1)
  }
  return o
}

const short = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const j = (v, n = 600) => short(JSON.stringify(v), n)
const label = (d) => (d && typeof d === 'object' ? (d.zh || d.en || Object.values(d)[0]) : d)
const onOff = (raw) => { const v = String(raw || '').toLowerCase(); return ['on', 'true', '1', 'enable', 'enabled'].includes(v) ? true : (['off', 'false', '0', 'disable', 'disabled'].includes(v) ? false : undefined) }
const getPath = (obj, path) => String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj)
const jobLine = j2 => `- ${j2.id || j2.job_id}${j2.name ? `  ${short(j2.name, 40)}` : ''}${j2.enabled === false ? ' [disabled]' : (j2.enabled ? ' [enabled]' : '')}${j2.cron_expr ? `  "${j2.cron_expr}"` : ''}`
const needConfirm = (tokens, what) => (tokens.some(t => t === 'confirm' || t === '--confirm') ? null : `Refusing to ${what} without confirmation: re-run with a trailing \`confirm\`.`)

/** One readable line per team.history record (0.2.7 records carry empty `content` for tool/team events). */
export function teamRecordLine(x) {
  const who = x?.member_name || x?.from_member || x?.role || '?'
  const text = (typeof x?.content === 'string' && x.content.trim()) ? x.content
    : x?.summary || x?.message
    || (x?.event_type === 'chat.tool_call' ? `🔧 ${x.tool_call?.name || x.tool_call?.function?.name || 'tool'}` : '')
    || (x?.event_type === 'chat.tool_result' ? `↳ ${x.tool_name || 'tool'} ${x.success === false ? 'failed' : 'ok'}` : '')
    || (x?.event_type ? `${x.event_type}${x.event?.type || typeof x.event === 'string' ? ` ${x.event?.type || x.event}` : ''}` : j(x, 100))
  return `[${who}] ${short(text, 120)}`
}

/**
 * @typedef {{ g: any, sid: string, dshId: string, rest: string[], tokens: string[], deps: any }} ExtCtx
 * @type {Record<string, { usage: string, group: string, methods: string[], run: (c: ExtCtx) => Promise<string> }>}
 */
export const EXT = {
  // ── P1 read-only ──
  'config': {
    usage: 'config [get] [dot.path]', group: 'Config & policy', methods: ['config.get'],
    async run({ g, tokens }) {
      const path = tokens[0] === 'get' ? tokens[1] : tokens[0]
      const r = maskSecrets(await g.rpc('config.get', {}))
      if (path) {
        const v = getPath(r, path)
        return v === undefined ? `Jiuwen config: no key "${path}"` : `Jiuwen config ${path} = ${j(v, 1500)}`
      }
      const lines = Object.entries(r || {}).slice(0, 60).map(([k, v]) => `${k}=${v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length} keys}`) : short(v, 80)}`)
      return `Jiuwen config (secrets masked; ${Object.keys(r || {}).length} keys):\n${lines.join('\n')}`
    },
  },
  'mcp show': {
    usage: 'mcp show <name|id>', group: 'System', methods: ['mcp.show'],
    async run({ g, rest }) {
      const q = rest[1]
      if (!q) return 'Usage: /jiuwen mcp show <name|id> (see /jiuwen mcp)'
      let id = q
      const listed = await g.rpc('mcp.list', { filter: 'all' }).catch(() => null)
      const hit = (listed?.items || []).find(x => [x.id, x.name, x.package_name].includes(q))
      if (hit?.id) id = hit.id
      const r = await g.rpc('mcp.show', { id })
      const it = maskSecrets(r?.item || r || {})
      return `Jiuwen MCP ${it.name || q}${it.display_name ? ` (${it.display_name})` : ''}: ${short(it.description, 200) || '(no description)'}${it.connection_state ? `\nstate: ${it.connection_state}` : ''}${it.category ? `\ncategory: ${it.category}` : ''}${Array.isArray(it.tools) ? `\ntools: ${it.tools.map(t => t.name || t).join(', ')}` : ''}`
    },
  },
  'skills search': {
    usage: 'skills search <query>', group: 'Skills & agents', methods: ['skills.retrieval.search'],
    async run({ g, tokens }) {
      const query = tokens.slice(1).join(' ')
      if (!query) return 'Usage: /jiuwen skills search <query>'
      const r = await g.rpc('skills.retrieval.search', { query })
      const text = typeof r?.result === 'string' ? r.result : j(r?.results || r, 1200)
      return `Jiuwen skill search "${query}" (${r?.mode || 'auto'}):\n${String(text).split('\n').slice(0, 15).map(l => short(l, 200)).join('\n') || 'no matches'}`
    },
  },
  'skills online': {
    usage: 'skills online <query>', group: 'Skills & agents', methods: ['skills.online_search.search'],
    async run({ g, tokens }) {
      const query = tokens.slice(1).join(' ')
      if (!query) return 'Usage: /jiuwen skills online <query>'
      const r = await g.rpc('skills.online_search.search', { query })
      const items = Array.isArray(r?.items) ? r.items : []
      return items.length
        ? `Jiuwen online skills "${query}" (${items.length}; read-only, nothing installed):\n${items.slice(0, 10).map(x => `- ${x.name}${x.source ? ` [${x.source}]` : ''}: ${short(x.display_name || x.description, 80)}`).join('\n')}`
        : `No online skills for "${query}"`
    },
  },
  'skills show': {
    usage: 'skills show <name>', group: 'Skills & agents', methods: ['skills.get'],
    async run({ g, rest }) {
      const name = rest[1]
      if (!name) return 'Usage: /jiuwen skills show <name>'
      const s = await g.rpc('skills.get', { name })
      return `Jiuwen skill ${s?.name || name}: ${short(s?.description, 200) || '(no description)'}${s?.category ? `\ncategory: ${s.category}` : ''}${Array.isArray(s?.tags) && s.tags.length ? `\ntags: ${s.tags.join(', ')}` : ''}${s?.author ? `\nauthor: ${s.author}` : ''}${s?.enabled === false ? '\n[disabled]' : ''}`
    },
  },
  'memory': {
    usage: 'memory [forbidden|context [status|config|services]]', group: 'Config & policy', methods: ['memory.forbidden.get', 'personal_context.runtime.status'],
    async run({ g, rest }) {
      const what = (rest[0] || 'forbidden').toLowerCase()
      if (what === 'forbidden') {
        const r = await g.rpc('memory.forbidden.get', {})
        return `Jiuwen memory forbidden-list: ${r?.enabled ? 'enabled' : 'disabled'}; patterns: ${(r?.patterns || []).join(', ') || 'none'}`
      }
      if (what === 'context') {
        const sub = (rest[1] || 'status').toLowerCase()
        if (sub === 'config') {
          const r = maskSecrets(await g.rpc('personal_context.runtime.get_config', {}))
          return `Jiuwen personal context config: configured=${r?.configured}, collection=${r?.collection_enabled}, agent_use=${r?.agent_use_enabled}, model=${r?.model_id || '?'}, fetch_services=${(r?.fetch_services || []).length}`
        }
        if (sub === 'services') {
          const r = await g.rpc('personal_context.fetch.list_services', {})
          const s = r?.services || []
          return `Jiuwen personal context fetch services (${s.length}): ${s.map(x => x.name || x.id || x.service_id).join(', ') || 'none'}`
        }
        const r = await g.rpc('personal_context.runtime.status', {})
        return `Jiuwen personal context: state=${r?.state || '?'}, configured=${r?.configured}, collection=${r?.collection_enabled}, agent_use=${r?.agent_use_enabled}, pipeline_running=${r?.pipeline_running}, context_ready=${r?.context_ready}${r?.last_error ? `, last_error=${short(r.last_error, 80)}` : ''}`
      }
      return 'Usage: /jiuwen memory [forbidden|context [status|config|services]]'
    },
  },
  'cron get': {
    usage: 'cron get <id>', group: 'Schedules', methods: ['cron.job.get'],
    async run({ g, rest }) {
      if (!rest[1]) return 'Usage: /jiuwen cron get <id>'
      const r = await g.rpc('cron.job.get', { id: rest[1] })
      const job = maskSecrets(r?.job || r)
      return `Jiuwen cron job ${job?.id || rest[1]}: ${j(job, 900)}`
    },
  },
  'cron preview': {
    usage: 'cron preview <id>', group: 'Schedules', methods: ['cron.job.preview'],
    async run({ g, rest }) {
      if (!rest[1]) return 'Usage: /jiuwen cron preview <id>'
      const r = await g.rpc('cron.job.preview', { id: rest[1] })
      const runs = r?.next || r?.next_runs || r?.runs || r?.items
      return `Jiuwen cron preview ${rest[1]}: ${Array.isArray(runs) ? runs.slice(0, 10).map(x => (typeof x === 'object' ? x.wake_at || x.at || x.time || j(x, 60) : x)).join(', ') : j(r, 600)}`
    },
  },
  'cron meta': {
    usage: 'cron meta', group: 'Schedules', methods: ['cron.job.meta'],
    async run({ g }) {
      const r = await g.rpc('cron.job.meta', {})
      return `Jiuwen cron meta: default_mode=${r?.default_mode || '?'}, default_timeout=${r?.default_timeout_seconds ?? '?'}s, modes: ${(r?.modes || []).join(', ')}`
    },
  },
  'heartbeat job': {
    usage: 'heartbeat job <id>', group: 'Schedules', methods: ['heartbeat.job.get'],
    async run({ g, sid, rest }) {
      if (!rest[1]) return 'Usage: /jiuwen heartbeat job <id>'
      const r = await g.rpc('heartbeat.job.get', { id: rest[1], session_id: sid })
      return `Jiuwen heartbeat job ${rest[1]}: ${j(maskSecrets(r?.job || r), 900)}`
    },
  },
  'heartbeat preview': {
    usage: 'heartbeat preview <id>', group: 'Schedules', methods: ['heartbeat.job.preview'],
    async run({ g, sid, rest }) {
      if (!rest[1]) return 'Usage: /jiuwen heartbeat preview <id>'
      return `Jiuwen heartbeat preview ${rest[1]}: ${j(await g.rpc('heartbeat.job.preview', { id: rest[1], session_id: sid }), 700)}`
    },
  },
  'heartbeat meta': {
    usage: 'heartbeat meta', group: 'Schedules', methods: ['heartbeat.job.meta'],
    async run({ g }) {
      const r = await g.rpc('heartbeat.job.meta', {})
      const l = r?.limits || {}
      return `Jiuwen heartbeat meta: min_interval=${l.min_interval_seconds ?? '?'}s, max_active/session=${l.max_active_jobs_per_session ?? '?'}, schedule_types=${(r?.schedule_types || []).join('/')}, concurrency=${(r?.concurrency_policies || []).join('/')}`
    },
  },
  'schedule': {
    usage: 'schedule [list|status|logs|check|create|run|cancel]', group: 'Schedules', methods: ['schedule.list'],
    async run({ g, rest, sid, tokens }) {
      const a = (rest[0] || 'list').toLowerCase()
      const method = { list: 'schedule.list', status: 'schedule.status', logs: 'schedule.logs', check: 'schedule.check_config', create: 'schedule.create', run: 'schedule.run', cancel: 'schedule.cancel' }[a]
      if (!method) return 'Usage: /jiuwen schedule [list|status|logs|check|create key=value…|run <id>|cancel <id>]'
      const params = { session_id: sid }
      if (a === 'create') Object.assign(params, kv(tokens.slice(1)))
      if (a === 'run' || a === 'cancel') { if (!rest[1]) return `Usage: /jiuwen schedule ${a} <id>`; params.id = rest[1] }
      return `Jiuwen schedule ${a}: ${j(await g.rpc(method, params), 900)}`
    },
  },
  'team': {
    usage: 'team [history|snapshot]', group: 'Skills & agents', methods: ['team.history.get', 'team.snapshot'],
    async run({ g, rest, sid }) {
      const a = (rest[0] || 'snapshot').toLowerCase()
      if (a === 'history') {
        const r = await g.rpc('team.history.get', { session_id: sid })
        const recs = r?.records || []
        return recs.length
          ? `Jiuwen team history for ${sid} (${r?.total ?? recs.length}):\n${recs.slice(-15).map((x, i) => `${i + 1}. ${teamRecordLine(x)}`).join('\n')}`
          : `No team history for session ${sid}`
      }
      if (a === 'snapshot') {
        const r = await g.rpc('team.snapshot', { session_id: sid })
        return `Jiuwen team snapshot for ${sid}: team=${r?.team_id || 'none'}, members=${(r?.members || []).length}, tasks=${(r?.tasks || []).length}${(r?.members || []).length ? `\nmembers: ${(r.members).map(m => m.name || m.member_id || m.id).join(', ')}` : ''}`
      }
      return 'Usage: /jiuwen team [history|snapshot]'
    },
  },
  'template': {
    usage: 'template show <id>', group: 'Skills & agents', methods: ['agent_templates.show'],
    async run({ g, rest }) {
      if ((rest[0] || '').toLowerCase() !== 'show' || !rest[1]) return 'Usage: /jiuwen template show <id|packageName> (see /jiuwen templates)'
      let id = rest[1]
      if (!/^[0-9a-f]{16,}$/i.test(id)) {
        const l = await g.rpc('agent_templates.list', {}).catch(() => null)
        const hit = (l?.templates || []).find(t => [t.id, t.packageName, label(t.displayName)].includes(id))
        if (hit?.id) id = hit.id
      }
      const r = await g.rpc('agent_templates.show', { id })
      const t = r?.template || r || {}
      return `Jiuwen agent template ${label(t.displayName) || t.packageName || id} (${t.id || id}): ${short(label(t.displayDescription), 200) || '(no description)'}${t.category ? `\ncategory: ${t.category}` : ''}${t.installed !== undefined ? `\ninstalled: ${t.installed}` : ''}`
    },
  },
  'group': {
    usage: 'group [list|show <id>]', group: 'Skills & agents', methods: ['agent_groups.list'],
    async run({ g, rest }) {
      const a = (rest[0] || 'list').toLowerCase()
      if (a === 'show') {
        if (!rest[1]) return 'Usage: /jiuwen group show <id>'
        const r = await g.rpc('agent_groups.show', { id: rest[1] })
        const gr = r?.group || r || {}
        const members = Array.isArray(gr.members) ? gr.members : []
        return `Jiuwen agent group ${gr.id || rest[1]} (${label(gr.displayName) || gr.name || ''}): ${short(label(gr.displayDescription), 160)}${members.length ? `\nmembers (${members.length}): ${members.map(m => label(m.displayName) || m.id).join(', ')}` : ''}`
      }
      if (a !== 'list') return 'Usage: /jiuwen group [list|show <id>]'
      const r = await g.rpc('agent_groups.list', {})
      const list = r?.agentGroups || r?.groups || []
      return `Jiuwen agent groups (${list.length}): ${list.map(x => `${x.id}${x.installed === false ? ' (not installed)' : ''}`).join(', ') || 'none'}`
    },
  },
  'git': {
    usage: 'git [status|diff] [project_id]', group: 'Config & policy', methods: ['project.git.status'],
    async run({ g, rest }) {
      const a = (rest[0] || 'status').toLowerCase()
      if (!['status', 'diff'].includes(a)) return 'Usage: /jiuwen git [status|diff] [project_id]'
      let pid = rest[1]
      if (!pid) {
        const l = await g.rpc('project.list', {}).catch(() => null)
        const ps = l?.projects || []
        pid = (ps.find(p => p.is_default) || ps[0])?.project_id || 'default'
      }
      const r = await g.rpc(a === 'diff' ? 'project.git.diff_status' : 'project.git.status', { project_id: pid })
      if (a === 'diff') {
        const files = r?.files || r?.changes || []
        return `Jiuwen git diff (${pid}): ${Array.isArray(files) && files.length ? files.slice(0, 30).map(f => `${f.status || '?'} ${f.path || f.file || j(f, 60)}`).join(', ') : j(r, 600)}`
      }
      return `Jiuwen git status (${pid}): branch=${r?.branch || '?'}${r?.is_dirty !== undefined ? `, dirty=${r.is_dirty}` : ''}${r?.repo_root ? `, root=${r.repo_root}` : ''}${r?.ahead != null ? `, ahead=${r.ahead}` : ''}${r?.behind != null ? `, behind=${r.behind}` : ''}`
    },
  },
  'models validate': {
    usage: 'models validate [model_provider=.. api_base=.. model=..]', group: 'Models & mode', methods: ['models.validate'],
    async run({ g, tokens }) {
      // Never takes or prints API keys: the Gateway uses its own stored credentials when it can.
      const p = kv(tokens.slice(1))
      if (Object.keys(p).some(k => SECRET_KEY.test(k))) return 'Refusing to pass credentials through a slash command; configure keys in Jiuwen itself.'
      const cfg = await g.rpc('config.get', {}).catch(() => ({}))
      const params = { model_provider: p.model_provider || cfg?.model_provider, api_base: p.api_base || cfg?.api_base, model: p.model || cfg?.model }
      const r = await g.rpc('models.validate', params)
      return `Jiuwen models.validate ${params.model || '?'}: ${r?.ok === false || r?.valid === false ? 'FAILED' : 'ok'}${r?.message || r?.error ? ` — ${short(r.message || r.error, 200)}` : ''}`
    },
  },
  'permissions overrides': {
    usage: 'permissions overrides', group: 'Config & policy', methods: ['permissions.approval_overrides.get'],
    async run({ g }) {
      const r = await g.rpc('permissions.approval_overrides.get', {})
      const o = r?.approval_overrides || []
      return `Jiuwen approval overrides (${o.length}): ${o.map(x => `${x.id}${x.tool ? `:${x.tool}` : ''}`).join(', ') || 'none'}`
    },
  },
  'permissions scopes': {
    usage: 'permissions scopes', group: 'Config & policy', methods: ['permissions.owner_scopes.get'],
    async run({ g }) {
      const r = await g.rpc('permissions.owner_scopes.get', {})
      return `Jiuwen owner scopes: ${r?.owner_scopes == null ? 'none' : j(maskSecrets(r.owner_scopes), 500)}${r?.deny_guidance_message ? `\ndeny guidance: ${short(r.deny_guidance_message, 200)}` : ''}`
    },
  },
  'document': {
    usage: 'document formats', group: 'System', methods: ['document.formats'],
    async run({ g, rest }) {
      if ((rest[0] || 'formats') !== 'formats') return 'Usage: /jiuwen document formats (persist a file with /jiuwen doc persist <absolute host path>)'
      const r = await g.rpc('document.formats', {})
      return `Jiuwen forbidden document formats (${(r?.forbidden_formats || []).length}): ${(r?.forbidden_formats || []).join(' ')}`
    },
  },

  // ── P2 safe writes (reversible; deletes need `confirm`) ──
  'cron create': {
    usage: 'cron create name=<n> expr="<m h dom mon dow>" [desc=..] [tz=..] [target=web] [mode=agent] [enabled=off]', group: 'Schedules', methods: ['cron.job.create'],
    async run({ g, tokens, sid }) {
      const p = kv(tokens.slice(1))
      const expr = p.expr || p.cron_expr
      if (!p.name || !expr) return 'Usage: /jiuwen cron create name=<name> expr="*/30 * * * *" [desc=<text>] [tz=Asia/Shanghai] [target=web] [mode=agent] [enabled=off]'
      const enabled = onOff(p.enabled) ?? false // created disabled unless asked: nothing runs by surprise
      const params = {
        name: p.name, cron_expr: expr, description: p.desc || p.description || p.name,
        timezone: p.tz || p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        targets: p.target || p.targets || 'web', enabled, session_id: sid, ...(p.mode ? { mode: p.mode } : {}),
      }
      const r = await g.rpc('cron.job.create', params)
      const job = r?.job || r || {}
      return `Created Jiuwen cron job ${job.id || '?'} "${job.name || p.name}" (${job.cron_expr || expr}, ${job.timezone || params.timezone}) ${job.enabled ?? enabled ? 'enabled' : 'disabled'}. Remove with /jiuwen cron delete ${job.id || '<id>'} confirm`
    },
  },
  'cron toggle': {
    usage: 'cron toggle <id> <on|off>', group: 'Schedules', methods: ['cron.job.toggle'],
    async run({ g, rest }) {
      const enabled = onOff(rest[2])
      if (!rest[1] || enabled === undefined) return 'Usage: /jiuwen cron toggle <id> <on|off>'
      const r = await g.rpc('cron.job.toggle', { id: rest[1], enabled })
      return `Jiuwen cron job ${rest[1]} ${(r?.job?.enabled ?? r?.enabled ?? enabled) ? 'enabled' : 'disabled'}.`
    },
  },
  'cron run': {
    usage: 'cron run <id>', group: 'Schedules', methods: ['cron.job.run_now'],
    async run({ g, rest }) {
      if (!rest[1]) return 'Usage: /jiuwen cron run <id>'
      const r = await g.rpc('cron.job.run_now', { id: rest[1] })
      return `Triggered Jiuwen cron job ${rest[1]} now${r?.run_id ? ` (run ${r.run_id})` : ''}.`
    },
  },
  'cron delete': {
    usage: 'cron delete <id> confirm', group: 'Schedules', methods: ['cron.job.delete'],
    async run({ g, rest, tokens }) {
      if (!rest[1] || rest[1] === 'confirm') return 'Usage: /jiuwen cron delete <id> confirm'
      const no = needConfirm(tokens.slice(2), `delete cron job ${rest[1]}`)
      if (no) return no
      await g.rpc('cron.job.delete', { id: rest[1] })
      return `Deleted Jiuwen cron job ${rest[1]}.`
    },
  },
  'heartbeat toggle': {
    usage: 'heartbeat toggle <id> <on|off>', group: 'Schedules', methods: ['heartbeat.job.toggle'],
    async run({ g, sid, rest }) {
      const enabled = onOff(rest[2])
      if (!rest[1] || enabled === undefined) return 'Usage: /jiuwen heartbeat toggle <id> <on|off>'
      const r = await g.rpc('heartbeat.job.toggle', { id: rest[1], session_id: sid, enabled })
      return `Jiuwen heartbeat job ${rest[1]} ${(r?.job?.enabled ?? enabled) ? 'enabled' : 'disabled'}.`
    },
  },
  'heartbeat run': {
    usage: 'heartbeat run <id>', group: 'Schedules', methods: ['heartbeat.job.run_now'],
    async run({ g, sid, rest }) { if (!rest[1]) return 'Usage: /jiuwen heartbeat run <id>'; await g.rpc('heartbeat.job.run_now', { id: rest[1], session_id: sid }); return `Triggered Jiuwen heartbeat job ${rest[1]} now.` },
  },
  'heartbeat cancel': {
    usage: 'heartbeat cancel <id>', group: 'Schedules', methods: ['heartbeat.job.cancel'],
    async run({ g, sid, rest }) { if (!rest[1]) return 'Usage: /jiuwen heartbeat cancel <id>'; await g.rpc('heartbeat.job.cancel', { id: rest[1], session_id: sid }); return `Cancelled the running Jiuwen heartbeat job ${rest[1]}.` },
  },
  'heartbeat delete': {
    usage: 'heartbeat delete <id> confirm', group: 'Schedules', methods: ['heartbeat.job.delete'],
    async run({ g, sid, rest, tokens }) {
      if (!rest[1] || rest[1] === 'confirm') return 'Usage: /jiuwen heartbeat delete <id> confirm'
      const no = needConfirm(tokens.slice(2), `delete heartbeat job ${rest[1]}`)
      if (no) return no
      await g.rpc('heartbeat.job.delete', { id: rest[1], session_id: sid })
      return `Deleted Jiuwen heartbeat job ${rest[1]}.`
    },
  },
  'permissions rule': {
    usage: 'permissions rule add tools=a,b pattern=<p> action=<allow|ask|deny> [severity=..] [desc=..] | rule update <id> key=value… | rule delete <id> confirm', group: 'Config & policy', methods: ['permissions.rules.create'],
    async run({ g, rest, tokens }) {
      const a = (rest[1] || '').toLowerCase()
      const fields = (p) => {
        const o = {}
        if (p.tools) o.tools = String(p.tools).split(',').map(x => x.trim()).filter(Boolean)
        for (const k of ['pattern', 'action', 'severity', 'match_type']) if (p[k] !== undefined) o[k] = p[k]
        if (p.desc ?? p.description) o.description = p.desc ?? p.description
        return o
      }
      if (a === 'add' || a === 'create') {
        const rule = fields(kv(tokens.slice(2)))
        if (!rule.tools?.length || !rule.pattern) return 'Usage: /jiuwen permissions rule add tools=<a,b> pattern=<pattern> action=<allow|ask|deny> [severity=LOW|MEDIUM|HIGH|CRITICAL] [desc=<text>]'
        const r = await g.rpc('permissions.rules.create', { rule })
        return `Created Jiuwen permission rule ${r?.rule?.id || '?'} (${(r?.rule?.tools || rule.tools).join(',')} ~ ${r?.rule?.pattern || rule.pattern} → ${r?.rule?.action || rule.action || 'default'}). Remove with /jiuwen permissions rule delete ${r?.rule?.id || '<id>'} confirm`
      }
      if (a === 'update') {
        const id = rest[2]
        const patch = fields(kv(tokens.slice(3)))
        if (!id || !Object.keys(patch).length) return 'Usage: /jiuwen permissions rule update <id> [tools=..] [pattern=..] [action=..] [severity=..] [desc=..]'
        const r = await g.rpc('permissions.rules.update', { id, patch })
        return `Updated Jiuwen permission rule ${id}: ${j(r?.rule || patch, 300)}`
      }
      if (a === 'delete') {
        const id = rest[2]
        if (!id || id === 'confirm') return 'Usage: /jiuwen permissions rule delete <id> confirm'
        const no = needConfirm(tokens.slice(3), `delete permission rule ${id}`)
        if (no) return no
        await g.rpc('permissions.rules.delete', { id })
        return `Deleted Jiuwen permission rule ${id}.`
      }
      return 'Usage: /jiuwen permissions rule [add|update|delete] …'
    },
  },
  'continue-queued': {
    usage: 'continue-queued', group: 'Turn control', methods: ['session.message.continue_queued'],
    async run({ g, sid }) {
      const r = await g.rpc('session.message.continue_queued', { session_id: sid })
      return `Asked Jiuwen to continue queued messages for ${sid}: ${j(r, 200)}`
    },
  },
  'swarm-stop': {
    usage: 'swarm-stop [run_id]', group: 'Turn control', methods: ['swarmflow.stop'],
    async run({ g, rest, sid, mapping }) {
      const runId = rest[0] || mapping?.swarmRunId
      if (!runId) return 'Usage: /jiuwen swarm-stop <run_id> (no SwarmFlow run seen for this session yet)'
      const r = await g.rpc('swarmflow.stop', { session_id: sid, run_id: runId })
      return `Sent swarmflow.stop for run ${runId}${r?.ok === false ? ` — ${short(r.reason || r.error, 120)}` : ''}.`
    },
  },
  'doc': {
    usage: 'doc persist <host-path>', group: 'System', methods: ['document.persist'],
    async run({ g, rest, sid }) {
      if ((rest[0] || '').toLowerCase() !== 'persist' || !rest[1]) return 'Usage: /jiuwen doc persist <absolute host path>'
      const path = rest.slice(1).join(' ')
      const filename = path.split(/[\\/]/).pop()
      const r = await g.rpc('document.persist', { session_id: sid, documents: [{ type: 'document', path, filename, name: filename }] })
      const items = r?.media_items || []
      const errs = r?.document_errors || []
      return `Jiuwen document.persist: ${items.map(x => x.path || x.filename).join(', ') || 'nothing stored'}${errs.length ? `; errors: ${errs.map(e => `${e.filename}: ${short(e.error, 80)}`).join('; ')}` : ''}`
    },
  },
  'media': {
    usage: 'media discard <uploads-path> confirm', group: 'System', methods: ['media.discard'],
    async run({ g, rest, tokens, sid }) {
      if ((rest[0] || '').toLowerCase() !== 'discard' || !rest[1] || rest[1] === 'confirm') return 'Usage: /jiuwen media discard <session uploads path> confirm'
      const no = needConfirm(tokens.slice(2), `discard ${rest[1]}`)
      if (no) return no
      await g.rpc('media.discard', { session_id: sid, path: rest[1] })
      return `Discarded unsent Jiuwen upload ${rest[1]}.`
    },
  },
}

/** Resolve an extension handler for `sub rest…` (two-word keys win). */
export function findExt(sub, rest) {
  const two = `${sub} ${String(rest[0] || '').toLowerCase()}`
  if (EXT[two]) return EXT[two]
  return EXT[sub]
}

/** Help lines for extensions, hiding those whose methods are all cached unsupported. */
export function extHelp(isUnsupported = () => false) {
  const groups = new Map()
  for (const e of Object.values(EXT)) {
    if (e.methods.length && e.methods.every(m => isUnsupported(m))) continue
    if (!groups.has(e.group)) groups.set(e.group, [])
    groups.get(e.group).push(e.usage)
  }
  return [...groups].map(([k, v]) => `${k} (more): ${v.join(', ')}`)
}
