import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMcpBridge, matchesAllowlist } from '../src/mcp-bridge.js'

const base = { toolAllowlist: ['read', 'web_*'], toolApproval: 'dsh', approvalTimeoutMs: 200, toolCallTimeoutMs: 1000, mcpServerName: 'dsh-tools' }
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

test('tools/list exposes only allowlisted dsh schemas; registers + connects once', async () => {
  const { b, calls } = bridge({})
  await b.prepare(schemas, 's1')
  const r = await b._handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.deepEqual(r.result.tools.map(t => t.name), ['read', 'web_fetch'])
  assert.deepEqual(calls.map(c => c[0]), ['mcp.register_custom', 'mcp.connect'])
  assert.equal(calls[0][1].transport, 'streamable-http')
  assert.match(calls[0][1].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  await b.prepare(schemas, 's1')
  assert.equal(calls.length, 2)
  await b.dispose()
  assert.deepEqual(calls.slice(2).map(c => c[0]), ['mcp.disconnect', 'mcp.delete_custom'])
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
