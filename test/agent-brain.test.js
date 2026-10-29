import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareBrainRequest } from '../src/agent-brain.js'
import { createToolBridge } from '../src/tool-bridge.js'
import { resolveConfig } from '../src/config.js'

test('gateway brain strips DSH tools so local loop cannot own them', () => {
  const cfg = resolveConfig({ mode: 'gateway' }, { env: { DSH_HOME: '/tmp' } })
  const bridge = createToolBridge(cfg)
  assert.equal(bridge.jiuwenOwnsTools(), true)
  assert.equal(bridge.shouldForwardDshTools(), false)
  const out = prepareBrainRequest({
    provider: 'jiuwen',
    model: 'm',
    messages: [],
    tools: [{ name: 'shell', description: 'x', parameters: {} }],
    toolHistory: { tools: [] },
  }, cfg, bridge)
  assert.equal(out.tools, undefined)
  assert.equal(out.toolHistory, undefined)
})

test('openai allowDshAgentLoop keeps tools (diagnostics escape hatch)', () => {
  const cfg = resolveConfig({ mode: 'openai', allowDshAgentLoop: true }, { env: { DSH_HOME: '/tmp' } })
  const bridge = createToolBridge(cfg)
  assert.equal(bridge.shouldForwardDshTools(), true)
  const tools = [{ name: 'shell', description: 'x', parameters: {} }]
  const out = prepareBrainRequest({
    provider: 'jiuwen', model: 'm', messages: [], tools,
  }, cfg, bridge)
  assert.equal(out.tools, tools)
})
