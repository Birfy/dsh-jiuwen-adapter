/**
 * Opt-in dsh → Jiuwen tool passthrough over MCP (toolPassthrough: 'mcp').
 *
 * Serves the allowlisted dsh tool schemas of the current turn (GenerateOptions.tools — built-ins,
 * other plugins' tools, dsh MCP-client tools) as a minimal Streamable-HTTP MCP server on 127.0.0.1
 * with a random bearer token, registers it in JiuwenSwarm (mcp.register_custom + mcp.connect), and
 * executes tools/call inside dsh via ctx.tools.get(name).execute(). Each call is gated by dsh
 * approval unless toolApproval: 'none' (deny when unavailable).
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

export function matchesAllowlist(name, list) {
  return (list || []).some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1))
    return p === name
  })
}

export function createMcpBridge({ config, services, rpc, logger }) {
  let server, url, token, ready
  /** name → schema, refreshed from every turn. */
  const schemas = new Map()
  let currentSessionId

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
    const def = tools?.get?.(name)
    if (!def?.execute) return { isError: true, text: `dsh tool ${name} not found` }
    let agent
    try { agent = agents?.get?.(currentSessionId) } catch { agent = undefined }
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
        .map(s => ({ name: s.name, description: String(s.description || s.name).slice(0, 4000), inputSchema: s.parameters || s.inputSchema || { type: 'object', properties: {} } }))
      return ok({ tools: list })
    }
    if (method === 'tools/call') {
      const r = await callTool(String(params?.name || ''), params?.arguments)
      return ok({ content: [{ type: 'text', text: r.text.slice(0, 200_000) }], isError: r.isError })
    }
    if (id === undefined) return null // notification
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
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
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'dsh' }).end(JSON.stringify(out))
      })
    })
    // Never keep a short-lived host (dsh headless) alive: Jiuwen holds keep-alive connections.
    server.unref?.()
    server.keepAliveTimeout = 1000
    server.on('connection', (sock) => sock.unref?.())
    ready = new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', async () => {
        url = `http://127.0.0.1:${server.address().port}/mcp`
        const name = cfg().mcpServerName
        try {
          await rpc('mcp.register_custom', { name, transport: 'streamable-http', url, headers: { Authorization: `Bearer ${token}` }, timeout_s: Math.ceil(cfg().toolCallTimeoutMs / 1000) })
          const r = await rpc('mcp.connect', { name }, { timeoutMs: 60_000 })
          logger?.info?.(`[dsh-jiuwen] dsh tools exposed to Jiuwen as MCP "${name}" (${schemas.size} schema(s))`)
          resolve({ url, connect: r })
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
      for (const t of tools || []) if (t?.name && matchesAllowlist(t.name, cfg().toolAllowlist)) schemas.set(t.name, t)
      if (!schemas.size) return null
      return start()
    },
    exposed: () => [...schemas.keys()],
    async dispose() {
      if (!server) return
      const name = cfg().mcpServerName
      try { await rpc('mcp.disconnect', { name }, { timeoutMs: 5000 }) } catch { /* ignore */ }
      try { await rpc('mcp.delete_custom', { name }, { timeoutMs: 5000 }) } catch { /* ignore */ }
      server.close(); server = undefined; ready = undefined
    },
    _handle: handle,
  }
}
