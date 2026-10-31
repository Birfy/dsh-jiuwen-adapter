/**
 * Opt-in dsh → Jiuwen tool passthrough over MCP (toolPassthrough: 'mcp').
 *
 * Serves the allowlisted dsh tool schemas of the current turn (GenerateOptions.tools — built-ins,
 * other plugins' tools, dsh MCP-client tools) on a private 127.0.0.1 HTTP endpoint (random bearer
 * token) and executes tools/call inside dsh via ctx.tools.get(name).execute(). Each call is gated
 * by dsh approval unless toolApproval: 'none' (deny when unavailable).
 *
 * Jiuwen never connects to that endpoint directly. JiuwenSwarm spins its worker at 100 % CPU when
 * it closes a streamable-http MCP client whose server already exited (docs/known-issues.md), and a
 * dsh process can exit or be killed at any time. Instead one stable stdio MCP server,
 * bin/jiuwen-mcp-proxy.mjs, is registered once per Jiuwen backend under `mcpServerName` and owned
 * by Jiuwen; every dsh process only drops an endpoint file (ep-<pid>.json) into the shared state
 * dir and removes it on exit. No mcp.disconnect / delete_custom per process.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const PROXY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jiuwen-mcp-proxy.mjs')
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const writeAtomic = (f, data, mode = 0o600) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, data, { mode }); renameSync(t, f) }

/** Desired Jiuwen registration for the stable proxy. */
export function proxyRegistration(name, stateDir, callTimeoutMs) {
  return { name, transport: 'stdio', command: process.execPath, args: [PROXY_PATH, stateDir], timeout_s: Math.ceil(callTimeoutMs / 1000) }
}

/** Is Jiuwen's persisted record already our connected proxy (same command/args)? */
export function isProxyConnected(record, reg) {
  return Boolean(record && record.state === 'connected' && record.transport === 'stdio'
    && record.command === reg.command && JSON.stringify(record.args || []) === JSON.stringify(reg.args))
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }
/** Tool names advertised by live ep-<pid>.json endpoint files (dead pids ignored). */
export function liveToolNames(dir) {
  const out = new Set()
  let files = []
  try { files = readdirSync(dir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return out }
  for (const n of files) {
    const e = readJson(join(dir, n), null)
    if (e && Number(e.pid) && alive(Number(e.pid))) for (const t of e.tools || []) out.add(t)
  }
  return out
}

export function matchesAllowlist(name, list) {
  return (list || []).some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1))
    return p === name
  })
}


  const FS_HINT = new Set(['bash', 'write', 'edit', 'read', 'glob', 'grep'])
  const describeTool = (s) => {
    let d = String(s.description || s.name)
    if (FS_HINT.has(s.name)) d = `[PREFERRED sandboxed dsh path — use instead of Jiuwen built-in] ${d}`
    return d.slice(0, 4000)
  }

export function createMcpBridge({ config, services, rpc, logger }) {
  let server, url, token, ready
  /** Set by unregister(): the live proxy endpoint stays, but Jiuwen's registration must be re-created. */
  let needsRegister = false
  /** name → schema, refreshed from every turn. */
  const schemas = new Map()
  let currentSessionId
  /** sessionId → Set(tool names) offered on that session's latest turn (newest last). */
  const sessionTools = new Map()
  /** Pick the dsh session that owns `name`: the last-prepared one if it offers it, else the newest that does. */
  const ownerOf = (name) => {
    if (sessionTools.get(currentSessionId)?.has(name)) return currentSessionId
    let pick
    for (const [sid, names] of sessionTools) if (names.has(name)) pick = sid
    return pick ?? currentSessionId
  }

  const cfg = () => config()
  const toText = (v) => {
    if (typeof v === 'string') return v
    if (v && Array.isArray(v.content)) return v.content.map(b => (b?.type === 'text' ? b.text : JSON.stringify(b))).join('\n')
    try { return JSON.stringify(v) } catch { return String(v) }
  }

  async function callTool(name, args) {
    const c = cfg()
    if (!schemas.has(name) || !matchesAllowlist(name, c.toolAllowlist)) return { isError: true, text: `tool ${name} is not exposed by dsh` }
    const { tools, approval, agents } = services()
    const sid = ownerOf(name)
    let agent
    try { agent = agents?.get?.(sid) } catch { agent = undefined }
    // Session-scoped tools (e.g. dsh-superagent's orchestrator_*) live on agent.ctx.tools, not the
    // global registry: resolve there first, then fall back to the global service.
    // dsh ToolService.get(name, scope): scoped tools are only visible when the agent is passed as scope.
    let def
    try { def = agent ? tools?.get?.(name, agent) ?? agent.ctx?.tools?.get?.(name, agent) : undefined } catch { def = undefined }
    if (!def?.execute) def = tools?.get?.(name)
    if (!def?.execute) return { isError: true, text: `dsh tool ${name} not found (session=${sid})` }
    if (c.toolApproval !== 'none') {
      let outcome = 'unavailable'
      if (approval?.request && agent) {
        let timer
        try {
          outcome = await Promise.race([
            approval.request({ agent, toolName: name, reason: `JiuwenSwarm wants to run dsh tool ${name}` }),
            new Promise(r => { timer = setTimeout(() => r('timeout'), c.approvalTimeoutMs); timer.unref?.() }),
          ])
        } catch { outcome = 'unavailable' } finally { clearTimeout(timer) }
      }
      if (outcome !== 'allowed-once') return { isError: true, text: `dsh denied ${name} (${outcome})` }
    }
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), c.toolCallTimeoutMs)
    try {
      const result = await def.execute(args ?? {}, {
        callId: `jiuwen-${randomUUID()}`, name, arguments: args ?? {}, agent, signal: ac.signal,
        deferContext() {}, concludeTurn() {},
      })
      return { isError: false, text: toText(result) }
    } catch (error) {
      return { isError: true, text: `dsh tool ${name} failed: ${error?.message || error}` }
    } finally { clearTimeout(t) }
  }

  async function handle(msg) {
    const { id, method, params } = msg || {}
    const ok = (result) => ({ jsonrpc: '2.0', id, result })
    if (method === 'initialize') {
      return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: cfg().mcpServerName, version: '0.1.0' } })
    }
    if (method === 'ping') return ok({})
    if (method === 'tools/list') {
      const list = [...schemas.values()].filter(s => matchesAllowlist(s.name, cfg().toolAllowlist))
        .map(s => ({ name: s.name, description: describeTool(s), inputSchema: s.parameters || s.inputSchema || { type: 'object', properties: {} } }))
      return ok({ tools: list })
    }
    if (method === 'tools/call') {
      const r = await callTool(String(params?.name || ''), params?.arguments)
      return ok({ content: [{ type: 'text', text: r.text.slice(0, 200_000) }], isError: r.isError })
    }
    if (id === undefined) return null // notification
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }

  const stateDir = () => cfg().mcpStateDir || join(homedir(), '.cache', 'dsh-jiuwen', 'mcp', cfg().mcpServerName)
  const jiuwenState = () => cfg().jiuwenMcpStateFile || join(process.env.JIUWEN_HOME || join(homedir(), '.jiuwenswarm'), 'agent', 'workspace', 'mcp', 'state.json')
  let epFile
  const removeEp = () => { if (epFile) { try { unlinkSync(epFile) } catch { /* gone */ } epFile = undefined } }

  /** Merge this process's schemas into the shared union; true when names were added. */
  function publishSchemas() {
    const f = join(stateDir(), 'schemas.json')
    const prev = readJson(f, [])
    // Keep only names still served by a live dsh process: a dead process's tools would otherwise
    // stay listed forever (and resurface after an mcp-reset reconnect).
    // Keep every name ever served (stale names just error on call). Pruning made the union shrink and
    // regrow, and each regrowth forced mcp.disconnect/connect, which drops the server from every live
    // Jiuwen session (they never re-register: "Ability not found in resource_mgr").
    const byName = new Map(prev.map(t => [t.name, t]))
    const before = new Set(prev.map(t => t.name))
    let added = false
    for (const sch of schemas.values()) {
      if (!before.has(sch.name)) added = true
      byName.set(sch.name, { name: sch.name, description: describeTool(sch), inputSchema: sch.parameters || sch.inputSchema || { type: 'object', properties: {} } })
    }
    writeAtomic(f, JSON.stringify([...byName.values()]), 0o644)
    return added
  }

  async function ensureRegistered(added) {
    const c = cfg()
    const reg = proxyRegistration(c.mcpServerName, stateDir(), c.toolCallTimeoutMs)
    const record = readJson(jiuwenState(), {})?.mcp?.[c.mcpServerName]
    const timeoutMs = c.mcpRpcTimeoutMs ?? 30_000
    if (isProxyConnected(record, reg)) {
      // New tool names are only listed after a reconnect; safe because the proxy is alive.
      if (added) { await rpc('mcp.disconnect', { name: reg.name }, { timeoutMs }); await rpc('mcp.connect', { name: reg.name }, { timeoutMs }) }
      return { reused: !added, reconnected: added }
    }
    await rpc('mcp.register_custom', reg, { timeoutMs })
    const r = await rpc('mcp.connect', { name: reg.name }, { timeoutMs })
    return { registered: true, connect: r }
  }

  function start() {
    if (ready) return ready
    token = randomBytes(24).toString('hex')
    server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 10_000_000) req.destroy() })
      req.on('end', async () => {
        let msg
        try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
        const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg)
        if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      })
    })
    // Never keep a short-lived host (dsh headless) alive.
    server.unref?.()
    server.keepAliveTimeout = 1000
    server.on('connection', (sock) => sock.unref?.())
    ready = new Promise((resolve) => {
      server.once('error', (error) => resolve({ error: String(error?.message || error) }))
      server.listen(0, '127.0.0.1', async () => {
        url = `http://127.0.0.1:${server.address().port}/mcp`
        const name = cfg().mcpServerName
        try {
          mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
          epFile = join(stateDir(), `ep-${process.pid}.json`)
          writeAtomic(epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...schemas.keys()] }))
          // Crash-safety only; detached again in stop() so dispose leaves no process listener.
          process.off('exit', removeEp); process.once('exit', removeEp) // compat-allow: paired with off() in stop()
          const r = await ensureRegistered(publishSchemas())
          logger?.info?.(`[dsh-jiuwen] dsh tools exposed to Jiuwen via MCP proxy "${name}" (${schemas.size} schema(s)${r.reused ? ', reused registration' : ''})`)
          resolve({ url, ...r })
        } catch (error) {
          logger?.warn?.(`[dsh-jiuwen] MCP passthrough registration failed: ${error?.message || error}`)
          resolve({ url, error: String(error?.message || error) })
        }
      })
    })
    return ready
  }

  return {
    /** Refresh exposed schemas from this turn; start + register on first use. */
    async prepare(tools, sessionId) {
      currentSessionId = sessionId
      sessionTools.delete(sessionId)
      sessionTools.set(sessionId, new Set((tools || []).map(t => t?.name).filter(Boolean)))
      for (const t of tools || []) if (t?.name && matchesAllowlist(t.name, cfg().toolAllowlist)) schemas.set(t.name, t)
      if (!schemas.size) return null
      if (!ready) return start()
      let r = await ready
      // A failed first registration (Gateway down / restarting) used to be cached forever: every
      // later turn got the same {error}, the adapter never added `mcp` to chat.send, and Jiuwen
      // sessions never saw the passthrough tools. Retry the registration on every later turn
      // until it succeeds (the local endpoint itself is still alive).
      if (r?.error && url && epFile) {
        try {
          writeAtomic(epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...schemas.keys()] }))
          const out = { url, retried: true, ...(await ensureRegistered(publishSchemas())) }
          ready = Promise.resolve(out)
          logger?.info?.(`[dsh-jiuwen] MCP passthrough registration recovered after earlier failure`)
          return out
        } catch (error) { return { url, error: String(error?.message || error) } }
      }
      if (r?.error && !url) { ready = undefined; return start() } // listen() itself failed: rebuild
      if (needsRegister && epFile) {
        // After `/jiuwen mcp-reset` in this process: restore the identical stdio-proxy registration.
        try {
          writeAtomic(epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...schemas.keys()] }))
          publishSchemas()
          const out = { url, ...(await ensureRegistered(false)) }
          needsRegister = false
          return out
        } catch (error) { return { url, error: String(error?.message || error) } }
      }
      // Later turns of a long-lived host may expose more tools: refresh our endpoint + the union.
      const known = readJson(epFile || '', null)?.tools || []
      if (epFile && [...schemas.keys()].some(n => !known.includes(n))) {
        try {
          writeAtomic(epFile, JSON.stringify({ pid: process.pid, url, token, ts: Date.now(), tools: [...schemas.keys()] }))
          return { url, ...(await ensureRegistered(publishSchemas())) }
        } catch (error) { return { url, error: String(error?.message || error) } }
      }
      return r
    },
    exposed: () => [...schemas.keys()],
    /**
     * Verify the passthrough registration on the Gateway. JiuwenSwarm 0.2.7 `mcp.list` returns only
     * the hub catalog (custom servers are absent), but `mcp.show {name}` resolves custom servers
     * with their live connection state and tool list. Never throws.
     */
    async verify() {
      const name = cfg().mcpServerName
      try {
        const r = await rpc('mcp.show', { name }, { timeoutMs: cfg().mcpRpcTimeoutMs ?? 30_000 })
        const it = r?.item || r || {}
        const tools = (Array.isArray(it.tools) ? it.tools : []).map(t => t?.name || t).filter(Boolean).map(String)
        return { name, registered: true, state: it.connection_state || it.state || 'unknown', category: it.category, tools, exposed: [...schemas.keys()] }
      } catch (e) {
        const msg = String(e?.message || e)
        return { name, registered: /not found/i.test(msg) ? false : undefined, error: msg.slice(0, 200), tools: [], exposed: [...schemas.keys()] }
      }
    },
    /** Leave Jiuwen's registration in place (the proxy is owned by Jiuwen); drop only our endpoint. */
    async dispose() {
      removeEp()
      process.off('exit', removeEp)
      if (!server) return
      server.close(); server = undefined; ready = undefined
    },
    /** Explicit teardown (e.g. `/jiuwen mcp-reset`): disconnect while the proxy still answers, then delete. */
    async unregister() {
      const name = cfg().mcpServerName, timeoutMs = cfg().mcpRpcTimeoutMs ?? 30_000
      const out = {}
      try { out.disconnect = await rpc('mcp.disconnect', { name }, { timeoutMs }) } catch (e) { out.disconnect = String(e?.message || e) }
      try { out.delete = await rpc('mcp.delete_custom', { name }, { timeoutMs }) } catch (e) { out.delete = String(e?.message || e) }
      needsRegister = true
      return out
    },
    _handle: handle,
  }
}
