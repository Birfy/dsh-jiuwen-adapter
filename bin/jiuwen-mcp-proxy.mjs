#!/usr/bin/env node
/**
 * Stable stdio MCP server that JiuwenSwarm spawns and owns (toolPassthrough: 'mcp').
 *
 * Why: JiuwenSwarm spins its worker event loop at 100 % CPU forever when it closes a
 * streamable-http MCP client whose server is already gone (see docs/known-issues.md). dsh
 * headless processes are short-lived and can be killed, so Jiuwen must never hold a client to
 * them directly. This proxy lives as long as Jiuwen keeps it, always answers (also on close), and
 * forwards tools/call to the newest live dsh process that registered an endpoint file in <dir>.
 *
 * Usage (spawned by Jiuwen): node jiuwen-mcp-proxy.mjs <stateDir>
 *   <stateDir>/schemas.json      union of exposed tool schemas  [{name, description, inputSchema}]
 *   <stateDir>/ep-<pid>.json     {pid, url, token, ts} for each live dsh process (0600)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const CALL_TIMEOUT_MS = Number(process.env.DSH_JIUWEN_PROXY_CALL_TIMEOUT_MS || 600_000)

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }

export function liveEndpoints(stateDir) {
  let names = []
  try { names = readdirSync(stateDir).filter(n => /^ep-\d+\.json$/.test(n)) } catch { return [] }
  return names.map(n => readJson(join(stateDir, n), null)).filter(e => e?.url && e?.token && alive(e.pid))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
}

async function forward(dir, msg) {
  const eps = liveEndpoints(dir).filter(e => !e.tools || e.tools.includes(msg.params?.name))
  if (!eps.length) return { content: [{ type: 'text', text: 'dsh is not running (no live dsh process serves this tool); the call was not executed' }], isError: true }
  const ep = eps[0]
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS)
  try {
    const r = await fetch(ep.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` }, body: JSON.stringify(msg), signal: ac.signal })
    const j = await r.json()
    return j.result ?? { content: [{ type: 'text', text: `dsh error: ${j.error?.message || r.status}` }], isError: true }
  } catch (e) {
    return { content: [{ type: 'text', text: `dsh process unreachable: ${e?.message || e}` }], isError: true }
  } finally { clearTimeout(t) }
}

export async function handle(dir, msg) {
  const { id, method, params } = msg || {}
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-jiuwen-proxy', version: '0.1.0' } })
  if (method === 'ping') return ok({})
  if (method === 'tools/list') return ok({ tools: readJson(join(dir, 'schemas.json'), []) })
  if (method === 'tools/call') return ok(await forward(dir, msg))
  if (id === undefined) return null
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]
  if (!dir) { process.stderr.write('usage: jiuwen-mcp-proxy.mjs <stateDir>\n'); process.exit(2) }
  const rl = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    let msg; try { msg = JSON.parse(line) } catch { return }
    const out = await handle(dir, msg)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  })
  rl.on('close', () => process.exit(0))
}
