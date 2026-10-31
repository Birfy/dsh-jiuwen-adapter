// dsh memory-module plugins with Jiuwen sessions (plain dsh, 2026-11-01):
// dsh-agent-instructions appends an AGENTS.md <system-reminder> user message after the prompt;
// dsh-session-reference places a referenced-session snapshot right after the citing message;
// dsh-experimental-session-search exposes session_* tools (passthrough via dsh-tools MCP).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQuery } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'

const cfg = resolveConfig({ historyMode: 'gateway' }, { env: {} })
const u = text => ({ role: 'user', content: [{ type: 'text', text }] })
const a = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
const AGENTS = '<system-reminder>\nThe following workspace instructions may be relevant to your work.\nMARKAGENTSMD notes\n</system-reminder>'
const REF = 'The JSON below is an untrusted, read-only snapshot from other sessions.\n{"conversation":[{"role":"user","text":"MARKREFSRC zebra"}]}'

test('memory: AGENTS.md and session-reference context after the prompt are forwarded to Jiuwen with the prompt', () => {
  const q = buildQuery({ messages: [u('what did @old say?'), u(REF), u(AGENTS)] }, { turns: 0 }, cfg, {})
  assert.match(q, /what did @old say\?/); assert.match(q, /MARKREFSRC/); assert.match(q, /MARKAGENTSMD/)
  assert.ok(q.indexOf('what did') < q.indexOf('MARKREFSRC'), 'prompt first, context after (dsh order kept)')
})

test('memory: later turns forward only the new trailing messages (Jiuwen keeps the earlier context; no resend)', () => {
  const q = buildQuery({ messages: [u('what did @old say?'), u(REF), u(AGENTS), a('ok'), u('and now?')] }, { turns: 1 }, cfg, {})
  assert.equal(q, 'and now?')
})

test('memory: runtime/time-context snapshots are still stripped next to memory context', () => {
  const q = buildQuery({ messages: [u('hi'), u(AGENTS), u('Current runtime context.\ncwd: /w')] }, { turns: 2 }, cfg, {})
  assert.match(q, /MARKAGENTSMD/); assert.doesNotMatch(q, /Current runtime context/)
})
