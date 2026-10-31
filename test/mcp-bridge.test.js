import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createMcpBridge, matchesAllowlist, proxyRegistration, isProxyConnected, PROXY_PATH } from '../src/mcp-bridge.js'

const tmp = mkdtempSync(join(tmpdir(), 'jw-mcp-test-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const base = { toolAllowlist: ['read', 'web_*'], toolApproval: 'dsh', approvalTimeoutMs: 200, toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools', mcpStateDir: join(tmp, 'state'), jiuwenMcpStateFile: join(tmp, 'jiuwen-state.json') }
function bridge(services, cfg = {}) {
  const calls = []
  const b = createMcpBridge({ config: () => ({ ...base, ...cfg }), services: () => services, rpc: async (m, p) => { calls.push([m, p]); return {} } })
  return { b, calls }
}
const schemas = [{ name: 'read', description: 'r', parameters: { type: 'object' } }, { name: 'web_fetch', description: 'w' }, { name: 'bash', description: 'b' }]

test('allowlist: exact, prefix*, *', () => {
  assert.ok(matchesAllowlist('web_fetch', ['web_*']))
  assert.ok(!matchesAllowlist('bash', ['read']))
  assert.ok(matchesAllowlist('bash', ['*']))
  assert.ok(!matchesAllowlist('bash', []))
})

test('registers the stable stdio proxy once; dispose never disconnects; connected proxy is reused', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  await b.prepare(schemas, 's1')
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(r.result.tools.map(t => t.name), ['read', 'web_fetch'])
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].transport, 'stdio')
  assert.deepEqual(calls[0][1].args, [PROXY_PATH, join(tmp, 'state')])
  const ep = join(tmp, 'state', `ep-${process.pid}.json`)
  assert.ok(existsSync(ep))
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'state', 'schemas.json'), 'utf8')).map(t => t.name), ['read', 'web_fetch'])
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 2)
  await b.dispose()
  assert.equal(calls.length, 2, 'no mcp.disconnect / delete_custom on dispose')
  assert.ok(!existsSync(ep))
  // Next process: Jiuwen already has our proxy connected → no RPC at all.
  const reg = proxyRegistration('dsh-tools', join(tmp, 'state'), 1000)
  writeFileSync(join(tmp, 'jiuwen-state.json'), JSON.stringify({ mcp: { 'dsh-tools': { ...reg, state: 'connected' } } }))
  assert.ok(isProxyConnected({ ...reg, state: 'connected' }, reg))
  assert.ok(!isProxyConnected({ ...reg, state: 'connected', transport: 'streamable-http' }, reg))
  const next = bridge({})
  const r2 = await next.b.prepare(schemas, 's2')
  assert.equal(r2.reused, true)
  assert.equal(next.calls.length, 0)
  // A new tool name → reconnect (proxy alive) so Jiuwen re-lists.
  const more = bridge({}, { toolAllowlist: ['*'] })
  await more.b.prepare(schemas, 's3')
  assert.deepEqual(more.calls.map(c => c[0]), ['mcp.disconnect', 'mcp.connect'])
  await next.b.dispose(); await more.b.dispose()
  const u = await more.b.unregister()
  assert.ok(u.disconnect && u.delete)
})

test('proxy (stdio): lists the shared schemas, forwards tools/call to the live endpoint, errors when dsh is gone', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const tools = { get: (n) => ({ execute: async () => `ran ${n}` }) }
  const { b } = bridge({ tools }, { toolApproval: 'none' })
  await b.prepare(schemas, 's1')
  const p = spawn(process.execPath, [PROXY_PATH, join(tmp, 'state')], { stdio: ['pipe', 'pipe', 'inherit'] })
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

test('tools/call: approval allowed-once executes dsh tool; no approval UI → denied; non-allowlisted → error', async () => {
  const agent = { id: 's1' }
  const tools = { get: (n) => ({ execute: async (args) => ({ content: [{ type: 'text', text: `ran ${n} ${JSON.stringify(args)}` }] }) }) }
  const ok = bridge({ tools, agents: { get: () => agent }, approval: { request: async (r) => (r.agent === agent ? 'allowed-once' : 'rejected') } })
  await ok.b.prepare(schemas, 's1')
  let r = await ok.b._handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { path: 'x' } } })
  assert.equal(r.result.isError, false)
  assert.equal(r.result.content[0].text, 'ran read {"path":"x"}')
  r = await ok.b._handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: {} } })
  assert.equal(r.result.isError, true)
  await ok.b.dispose()
  const deny = bridge({ tools, agents: { get: () => agent } })
  await deny.b.prepare(schemas, 's1')
  r = await deny.b._handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /denied/)
  await deny.b.dispose()
  const none = bridge({ tools }, { toolApproval: 'none' })
  await none.b.prepare(schemas, 's1')
  r = await none.b._handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'web_fetch', arguments: {} } })
  assert.equal(r.result.isError, false)
  await none.b.dispose()
})

test('mcp-reset: unregister then next prepare restores the identical registration in the same process', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const { b, calls } = bridge({})
  await b.prepare(schemas, 's1')
  const first = calls.find(c => c[0] === 'mcp.register_custom')[1]
  await b.unregister()
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.deepEqual(calls[0][1], first)
  calls.length = 0
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 0, 'only once after a reset')
  await b.dispose()
})

test('schemas union drops tools of dead dsh processes', async () => {
  rmSync(join(tmp, 'jiuwen-state.json'), { force: true })
  const dir = join(tmp, 'state')
  writeFileSync(join(dir, 'schemas.json'), JSON.stringify([{ name: 'stale_tool', description: 's', inputSchema: {} }]))
  writeFileSync(join(dir, 'ep-999999999.json'), JSON.stringify({ pid: 999999999, url: 'x', token: 't', tools: ['stale_tool'] }))
  const { b } = bridge({})
  await b.prepare(schemas, 's1')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'schemas.json'), 'utf8')).map(t => t.name), ['read', 'web_fetch'])
  rmSync(join(dir, 'ep-999999999.json'), { force: true })
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

test('verify: mcp.show resolves the custom passthrough server even when mcp.list omits it', async () => {
  const { createMcpBridge } = await import('../src/mcp-bridge.js')
  const calls = []
  const b = createMcpBridge({ config: () => ({ mcpServerName: 'dsh-tools' }), services: () => ({}), logger: {}, rpc: async (m, p) => {
    calls.push([m, p])
    if (m === 'mcp.show' && p.name === 'dsh-tools') return { type: 'detail', item: { name: 'dsh-tools', category: 'custom', connection_state: 'connected', tools: [{ name: 'bash' }, { name: 'read' }] } }
    throw new Error('SkillHub asset not found: x')
  } })
  const v = await b.verify()
  assert.equal(v.registered, true); assert.equal(v.state, 'connected'); assert.deepEqual(v.tools, ['bash', 'read'])
  assert.deepEqual(calls[0], ['mcp.show', { name: 'dsh-tools' }])
  const b2 = createMcpBridge({ config: () => ({ mcpServerName: 'x' }), services: () => ({}), logger: {}, rpc: async () => { throw new Error('SkillHub asset not found: x') } })
  assert.equal((await b2.verify()).registered, false)
  const { createJiuwenCommand } = await import('../src/commands.js')
  const cmd = createJiuwenCommand({ sessions: { ensure: () => ({ jiuwenSessionId: 'j' }) }, gateway: () => ({ mcpList: async () => ({ items: [{ name: 'github', connection_state: 'disconnected' }] }) }), config: () => ({ mcpServerName: 'dsh-tools' }), mcpBridge: b })
  assert.match(await cmd.run('s', 'mcp'), /github \(disconnected\)\ndsh tool passthrough: dsh-tools \(custom, connected, 2 tools\)/)
})
