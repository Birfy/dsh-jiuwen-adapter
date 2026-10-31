import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createMcpBridge, matchesAllowlist, proxyRegistration, isProxyConnected, sessionMcpName, PROXY_PATH } from '../src/mcp-bridge.js'

const tmp = mkdtempSync(join(tmpdir(), 'jw-mcp-test-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const base = { toolAllowlist: ['read', 'web_*', 'orchestrator_report'], toolApproval: 'dsh', approvalTimeoutMs: 200, toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools', mcpStateDir: join(tmp, 'state'), jiuwenMcpStateFile: join(tmp, 'jiuwen-state.json') }
function bridge(services, cfg = {}) {
  const calls = []
  const b = createMcpBridge({ config: () => ({ ...base, ...cfg }), services: () => services, rpc: async (m, p) => { calls.push([m, p]); return {} } })
  return { b, calls }
}
const schemas = [{ name: 'read', description: 'r', parameters: { type: 'object' } }, { name: 'web_fetch', description: 'w' }, { name: 'bash', description: 'b' }, { name: 'orchestrator_report', description: 'rep' }]

test('allowlist: exact, prefix*, *', () => {
  assert.ok(matchesAllowlist('web_fetch', ['web_*']))
  assert.ok(!matchesAllowlist('bash', ['read']))
  assert.ok(matchesAllowlist('bash', ['*']))
  assert.ok(!matchesAllowlist('bash', []))
})

test('sessionMcpName is stable and distinct per session', () => {
  const a = sessionMcpName('dsh-tools', 'worker-aaa')
  const b = sessionMcpName('dsh-tools', 'worker-bbb')
  assert.equal(a, sessionMcpName('dsh-tools', 'worker-aaa'))
  assert.notEqual(a, b)
  assert.match(a, /^dsh-tools-[a-f0-9]{16}$/)
})

test('registers a per-session stdio proxy; dispose never disconnects; reconnect on schema growth', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  const r0 = await b.prepare(schemas, 's1')
  const name = sessionMcpName('dsh-tools', 's1')
  assert.equal(r0.mcpServerName, name)
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 's1')
  assert.deepEqual(r.result.tools.map(t => t.name), ['read', 'web_fetch', 'orchestrator_report'])
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].name, name)
  assert.equal(calls[0][1].transport, 'stdio')
  const stateDir = join(tmp, 'state', 's', name.slice('dsh-tools-'.length))
  assert.deepEqual(calls[0][1].args, [PROXY_PATH, stateDir])
  const ep = join(stateDir, `ep-${process.pid}.json`)
  assert.ok(existsSync(ep))
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'schemas.json'), 'utf8')).map(t => t.name), ['read', 'web_fetch', 'orchestrator_report'])
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 2)
  await b.dispose()
  assert.equal(calls.length, 2, 'no mcp.disconnect / delete_custom on dispose')
  assert.ok(!existsSync(ep))
  // Next prepare with connected record → reuse
  const reg = proxyRegistration(name, stateDir, 1000)
  writeFileSync(join(tmp, 'jiuwen-state.json'), JSON.stringify({ mcp: { [name]: { ...reg, state: 'connected' } } }))
  assert.ok(isProxyConnected({ ...reg, state: 'connected' }, reg))
  const next = bridge({})
  const r2 = await next.b.prepare(schemas, 's1')
  assert.equal(r2.reused, true)
  assert.equal(next.calls.length, 0)
  // New tool name → reconnect
  const more = bridge({}, { toolAllowlist: ['*'] })
  await more.b.prepare(schemas, 's1')
  assert.deepEqual(more.calls.map(c => c[0]), ['mcp.disconnect', 'mcp.connect'])
  await next.b.dispose(); await more.b.dispose()
  const u = await more.b.unregister()
  assert.ok(u.disconnect && u.delete)
})

test('Bug 5: concurrent sessions attribute tools/call to their own agent (no ownerOf cross-talk)', async () => {
  const ran = []
  const agents = {
    get: (sid) => ({ id: sid, ctx: { tools: { get: () => null } } }),
  }
  const tools = {
    get: (n, agent) => ({
      execute: async (args) => {
        ran.push({ tool: n, agent: agent?.id, args })
        return `ok ${n} for ${agent?.id}`
      },
    }),
  }
  const { b, calls } = bridge({ tools, agents, approval: { request: async () => 'allowed-once' } }, { toolApproval: 'none', toolAllowlist: ['*'] })
  const ra = await b.prepare(schemas, 'worker-A')
  const rb = await b.prepare(schemas, 'worker-B')
  assert.notEqual(ra.mcpServerName, rb.mcpServerName)
  assert.equal(calls.filter(c => c[0] === 'mcp.register_custom').length, 2)

  let r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { ticket: 'A' } } }, 'worker-A')
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-A/)
  r = await b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'orchestrator_report', arguments: { ticket: 'B' } } }, 'worker-B')
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-B/)
  assert.deepEqual(ran.map(x => x.agent), ['worker-A', 'worker-B'])

  // Proxy forwards via per-session URL path
  const keyA = ra.mcpServerName.slice('dsh-tools-'.length)
  const stateA = join(tmp, 'state', 's', keyA)
  const p = spawn(process.execPath, [PROXY_PATH, stateA], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m) } })
  const call = (id, method, params) => new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  r = await call(3, 'tools/call', { name: 'orchestrator_report', arguments: { via: 'proxy' } })
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /worker-A/)
  p.stdin.end()
  await b.releaseSession('worker-A')
  assert.ok(calls.some(c => c[0] === 'mcp.delete_custom' && c[1].name === ra.mcpServerName))
  await b.dispose()
})

test('proxy (stdio): lists session schemas, forwards tools/call, errors when dsh is gone', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const tools = { get: (n) => ({ execute: async () => `ran ${n}` }) }
  const { b } = bridge({ tools }, { toolApproval: 'none' })
  const prep = await b.prepare(schemas, 's1')
  const stateDir = join(tmp, 'state', 's', prep.mcpServerName.slice('dsh-tools-'.length))
  const p = spawn(process.execPath, [PROXY_PATH, stateDir], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map(); let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m) } })
  const call = (id, method, params) => new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  assert.equal((await call(1, 'initialize', {})).result.serverInfo.name, 'dsh-jiuwen-proxy')
  assert.ok((await call(2, 'tools/list', {})).result.tools.some(t => t.name === 'read'))
  let r = await call(3, 'tools/call', { name: 'read', arguments: {} })
  assert.equal(r.result.isError, false); assert.equal(r.result.content[0].text, 'ran read')
  await b.dispose()
  r = await call(4, 'tools/call', { name: 'read', arguments: {} })
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /not running/)
  p.stdin.end()
})

test('tools/call: approval allowed-once executes; denied without UI; non-allowlisted errors', async () => {
  const agent = { id: 's1' }
  const tools = { get: (n) => ({ execute: async (args) => ({ content: [{ type: 'text', text: `ran ${n} ${JSON.stringify(args)}` }] }) }) }
  const ok = bridge({ tools, agents: { get: () => agent }, approval: { request: async (r) => (r.agent === agent ? 'allowed-once' : 'rejected') } })
  await ok.b.prepare(schemas, 's1')
  let r = await ok.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: 'x' } } }, 's1')
  assert.equal(r.result.isError, false)
  assert.equal(r.result.content[0].text, 'ran read {"path":"x"}')
  r = await ok.b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true)
  await ok.b.dispose()
  const deny = bridge({ tools, agents: { get: () => agent } })
  await deny.b.prepare(schemas, 's1')
  r = await deny.b._handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } }, 's1')
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /denied/)
  await deny.b.dispose()
  const none = bridge({ tools }, { toolApproval: 'none' })
  await none.b.prepare(schemas, 's1')
  r = await none.b._handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'web_fetch', arguments: {} } }, 's1')
  assert.equal(r.result.isError, false)
  await none.b.dispose()
})

test('mcp-reset: unregister then next prepare restores registration', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  await b.prepare(schemas, 's1')
  const first = calls.find(c => c[0] === 'mcp.register_custom')[1]
  await b.unregister()
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].name, first.name)
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 0, 'only once after a reset')
  await b.dispose()
})

test('releaseSession removes registration and state dir', async () => {
  const { b, calls } = bridge({})
  const r = await b.prepare(schemas, 'gone')
  const dir = join(tmp, 'state', 's', r.mcpServerName.slice('dsh-tools-'.length))
  assert.ok(existsSync(dir))
  await b.releaseSession('gone')
  assert.ok(calls.some(c => c[0] === 'mcp.disconnect' && c[1].name === r.mcpServerName))
  assert.ok(calls.some(c => c[0] === 'mcp.delete_custom' && c[1].name === r.mcpServerName))
  assert.ok(!existsSync(dir))
  await b.dispose()
})

test('/jiuwen mcp-reset requires a trailing confirm', async () => {
  const { createJiuwenCommand } = await import('../src/commands.js')
  let n = 0
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j' }) }, gateway: () => ({}), config: () => ({ mcpServerName: 'dsh-tools' }), mcpBridge: { unregister: async () => { n++; return { disconnect: {}, delete: {} } } } })
  assert.match(await cmd.run('s', 'mcp-reset'), /Refusing .*mcp-reset confirm/)
  assert.equal(n, 0)
  assert.match(await cmd.run('s', 'mcp-reset confirm'), /Removed Jiuwen MCP registration/)
  assert.equal(n, 1)
})

test('compat: prepare/dispose cycles leave no process exit listener behind', async () => {
  const n0 = process.listenerCount('exit')
  for (let i = 0; i < 3; i++) {
    const { b } = bridge({})
    await b.prepare(schemas, `leak-${i}`)
    assert.ok(process.listenerCount('exit') <= n0 + 1)
    await b.dispose()
  }
  assert.equal(process.listenerCount('exit'), n0)
})

test('verify: mcp.show resolves the custom passthrough server', async () => {
  const name = sessionMcpName('dsh-tools', 's1')
  const b = createMcpBridge({ config: () => ({ mcpServerName: 'dsh-tools' }), services: () => ({}), logger: {}, rpc: async (m, p) => {
    if (m === 'mcp.show' && p.name === name) return { type: 'detail', item: { name, category: 'custom', connection_state: 'connected', tools: [{ name: 'bash' }] } }
    throw new Error('SkillHub asset not found: x')
  } })
  // seed session entry via prepare with empty tools → null; use sessionServerName path
  const v = await b.verify('s1')
  assert.equal(v.name, name)
  assert.equal(v.registered, true)
})
