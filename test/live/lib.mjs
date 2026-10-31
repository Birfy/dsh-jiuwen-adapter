// Shared helpers for the opt-in live suites: env guards, stand-in model, Jiuwen snapshot + exact restore.
import { connect } from 'node:net'
import { spawn, execSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../../index.js'

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const GATEWAY = process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
export const STANDIN_PORT = Number(process.env.STANDIN_PORT || 18999)
export const STANDIN_LOG = process.env.STANDIN_LOG || '/tmp/standin.jsonl'
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const portUp = (port, host = '127.0.0.1') => new Promise(r => { const s = connect(port, host, () => { s.end(); r(true) }); s.on('error', () => r(false)) })
export const gatewayUp = () => { const u = new URL(GATEWAY); return portUp(Number(u.port), u.hostname) }
export function skip(why) { console.log(`SKIP ${why}`); process.exit(0) }

/** Start test/fixtures/stand-in.mjs unless something already listens on STANDIN_PORT. Returns stop(). */
export async function startStandin() {
  if (await portUp(STANDIN_PORT)) return { stop() {}, reused: true }
  const p = spawn(process.execPath, [join(ROOT, 'test/fixtures/stand-in.mjs')], { env: { ...process.env, PORT: String(STANDIN_PORT), STANDIN_LOG }, stdio: 'ignore', detached: true })
  for (let i = 0; i < 50 && !(await portUp(STANDIN_PORT)); i++) await sleep(100)
  return { stop() { try { process.kill(-p.pid) } catch { try { p.kill() } catch {} } }, reused: false }
}
export function sh(cmd) { if (cmd) execSync(cmd, { stdio: 'ignore', shell: '/bin/bash', timeout: 120_000 }) }
export async function waitGateway(ms = 90_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await gatewayUp()) { await sleep(2000); return true } await sleep(1000) } return false }

function gw() {
  const ctx = { llm: { registerAdapter() { return () => {} } }, logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() { return () => {} }, get() {} }
  plugin.apply(ctx, { gatewayURL: GATEWAY, mappingPath: `/tmp/jw-live-state-${process.pid}.json` })
  return ctx.jiuwenAdapter.gateway
}
/** Comparable global Jiuwen state (no secrets). */
export async function jiuwenState() {
  const g = gw(); const out = {}
  const q = async (k, m, p = {}) => { try { out[k] = await g.rpc(m, p, { timeoutMs: 10000 }) } catch (e) { out[k] = 'ERR ' + String(e.message).slice(0, 60) } }
  await q('sessions', 'session.list', { limit: 500 }); out.sessions = (out.sessions?.sessions || []).map(s => [s.session_id, s.title]).sort()
  await q('skills', 'skills.list'); out.skills = (out.skills?.skills || []).map(s => [s.name, s.enabled]).sort()
  await q('perm', 'permissions.tools.get'); await q('rules', 'permissions.rules.get'); await q('hb', 'heartbeat.get_conf')
  await q('hbjobs', 'heartbeat.job.list'); await q('cron', 'cron.job.list'); await q('mcp', 'mcp.list', { filter: 'all' })
  out.mcp = (out.mcp?.items || []).map(x => [x.name, x.connection_state]).sort()
  return out
}
const CONFIG_DIR = process.env.JIUWEN_CONFIG_DIR || join(homedir(), '.jiuwenswarm/config')
const MCP_STATE = process.env.JIUWEN_MCP_STATE || join(process.env.JIUWEN_HOME || join(homedir(), '.jiuwenswarm'), 'agent/workspace/mcp/state.json')
const MCP_KEYS = ['command', 'args', 'transport', 'timeout_s', 'state', 'enabled']
const mcpRecords = () => { try { const m = JSON.parse(readFileSync(MCP_STATE, 'utf8')).mcp || {}; return Object.fromEntries(Object.entries(m).map(([k, r]) => [k, Object.fromEntries(MCP_KEYS.map(x => [x, r[x]]))])) } catch { return {} } }
function readConfig() { const m = new Map(); try { for (const f of readdirSync(CONFIG_DIR)) { const p = join(CONFIG_DIR, f); if (statSync(p).isFile() && statSync(p).size < 4e6) m.set(f, readFileSync(p)) } } catch {} return m }

/** Snapshot Jiuwen (config bytes in memory only, never printed + RPC-visible state). */
export async function snapshot() { return { config: readConfig(), mcp: mcpRecords(), state: await jiuwenState() } }
/** Exact restore: config bytes, new sessions deleted, heartbeat/permissions reset; returns the remaining diff keys. */
export async function restore(snap) {
  const now = readConfig()
  for (const [f, buf] of snap.config) if (!now.get(f)?.equals(buf)) writeFileSync(join(CONFIG_DIR, f), buf)
  if (await gatewayUp()) {
    const g = gw(); const s = await jiuwenState(); const keep = new Set(snap.state.sessions.map(x => x[0]))
    for (const [id] of s.sessions) if (!keep.has(id)) await g.rpc('session.delete', { session_id: id }).catch(() => {})
    if (JSON.stringify(s.hb) !== JSON.stringify(snap.state.hb) && snap.state.hb && typeof snap.state.hb === 'object') await g.rpc('heartbeat.set_conf', snap.state.hb).catch(() => {})
    const perm = snap.state.perm?.tools || {}
    for (const [tool, v] of Object.entries(perm)) { const level = typeof v === 'string' ? v : v?.level; if (level && JSON.stringify(s.perm?.tools?.[tool]) !== JSON.stringify(v)) await g.rpc('permissions.tools.update', { tool, level }).catch(() => {}) }
    // custom MCP registrations (the dsh-tools proxy path is per dsh HOME): re-register the snapshot record
    const cur = mcpRecords()
    for (const [name, r] of Object.entries(snap.mcp)) {
      if (JSON.stringify(cur[name]) === JSON.stringify(r) || r.transport !== 'stdio') continue
      await g.rpc('mcp.register_custom', { name, transport: r.transport, command: r.command, args: r.args, timeout_s: r.timeout_s }).catch(() => {})
      await g.rpc(r.state === 'connected' ? 'mcp.connect' : 'mcp.disconnect', { name }).catch(() => {})
    }
    for (const name of Object.keys(cur)) if (!snap.mcp[name]) { await g.rpc('mcp.disconnect', { name }).catch(() => {}); await g.rpc('mcp.delete_custom', { name }).catch(() => {}) }
  }
  const after = await jiuwenState(); const cfg = readConfig(); const mcpNow = mcpRecords()
  if (JSON.stringify(mcpNow) !== JSON.stringify(snap.mcp)) { const d = Object.keys({ ...snap.mcp, ...mcpNow }).filter(k => JSON.stringify(snap.mcp[k]) !== JSON.stringify(mcpNow[k])); var mcpDiff = d.map(k => `mcp:${k}`) }
  const diff = Object.keys({ ...snap.state, ...after }).filter(k => JSON.stringify(snap.state[k]) !== JSON.stringify(after[k]))
  for (const [f, buf] of snap.config) if (!cfg.get(f)?.equals(buf)) diff.push(`config:${f}`)
  if (mcpDiff) diff.push(...mcpDiff)
  return diff
}
