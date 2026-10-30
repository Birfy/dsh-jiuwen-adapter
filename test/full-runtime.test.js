/**
 * Round 7: role-less host messages (as dsh-agent-loop sends them) and the full-agent-runtime A/B
 * compatibility matrix. The matrix needs the dsh packages (DSH_NM) and is skipped without them;
 * JIUWEN_LIVE=1 adds the live-Gateway variants.
 */
import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { withInferredRoles } from '../src/messages.js'
import { buildQuery } from '../src/adapter.js'

const sys = Object.freeze({ role: 'system', content: [{ type: 'text', text: 'You are a test agent. create_goal may infer goals.' }], source: { kind: 'system-prompt' } })
const user = text => Object.freeze({ content: Object.freeze([{ type: 'text', text }]), source: Object.freeze({ kind: 'user' }) })

test('withInferredRoles: infers user/assistant/tool/system, keeps explicit roles, never mutates', () => {
  const msgs = Object.freeze([sys, user('hi'), Object.freeze({ content: [], source: { kind: 'model' } }), Object.freeze({ toolCallId: 'c1', content: [] }), Object.freeze({ role: 'developer', content: [] })])
  const out = withInferredRoles(msgs)
  assert.deepEqual(out.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'developer'])
  assert.equal(out[0], sys, 'messages with a role are passed through by reference')
  assert.equal(msgs[1].role, undefined, 'host message not mutated')
  const typed = [sys, { role: 'user', content: [] }]
  assert.equal(withInferredRoles(typed), typed, 'fully-typed arrays are returned unchanged')
  assert.equal(withInferredRoles(undefined), undefined)
})

test('buildQuery sends the role-less user text, not the system prompt (dsh-agent-loop shape)', () => {
  const options = { messages: withInferredRoles([sys, user('Reply with exactly: mixed-ok')]) }
  const q = buildQuery(options, { turns: 0 }, { historyMode: 'gateway', ignoreMessagePatterns: [] }, {})
  assert.equal(q, 'Reply with exactly: mixed-ok')
  const q2 = buildQuery({ messages: withInferredRoles([sys, user('first'), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, user('second')]) }, { turns: 1 }, { historyMode: 'gateway', ignoreMessagePatterns: [] }, {})
  assert.equal(q2, 'second')
})

const ROOT = new URL('..', import.meta.url).pathname
const NM = `${process.env.DSH_NM || '/workspace/fb-busyack3/core/dev/harness/node_modules'}/@deepseek-ai`
const hasRuntime = ['cordis', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm', 'dsh-session', 'dsh-tools', 'dsh-commands'].every(p => existsSync(`${NM}/${p}/lib/index.js`))

describe('full agent runtime A/B matrix', { skip: !hasRuntime && 'dsh agent runtime packages not found (set DSH_NM)' }, () => {
  it('every feature identical with and without the adapter (down/after, before, two, mixed)', () => {
    let out
    try { out = execFileSync(process.execPath, [`${ROOT}scripts/compat-matrix.mjs`, ...(process.env.JIUWEN_LIVE ? ['--live'] : [])], { encoding: 'utf8', timeout: 700_000, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { out = e.stdout }
    const m = JSON.parse(out)
    const bad = m.rows.filter(r => r.slice(1).some(c => c !== 'identical'))
    assert.deepEqual(bad, [], JSON.stringify(m.header))
    assert.ok(m.baseline.events > 100, 'scenario exercised the runtime')
    assert.equal(m.baseline.deepseek, 'loaded', 'dsh-llm-deepseek-api-key coexists')
    for (const [name, x] of Object.entries(m.extra)) {
      assert.deepEqual(x.nonNamespaced, [], name)
      assert.equal(x.serviceAfterDispose, 'gone', name)
      if (x.jwOut) assert.ok(x.jwOut.includes('jiuwenInAgentView:cmd=true') && !x.jwOut.some(s => s.startsWith('THROW')), `${name}: ${x.jwOut}`)
    }
    assert.match(String(m.extra['mock/mixed'].jwOut), /agent:gateway-mock: Reply with exactly: mixed-ok/, 'jiuwen agent in the real loop sends the user text')
    assert.equal(m.ok, true)
  })
  it('baseline scenario covers approval, tools, compaction, commands, retry, title, plan, goal', () => {
    const r = JSON.parse(execFileSync(process.execPath, [`${ROOT}scripts/compat-runtime.mjs`], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }))
    for (const t of ['approval/asked', 'approval/decided', 'tool/result', 'todo/write', 'compaction/summary', 'command/done', 'llm/retry', 'session/title', 'plan/mode', 'goal/change']) assert.ok(r.types.includes(t), t)
    assert.deepEqual(r.approvals, ['guarded:allowed-once', 'guarded:rejected'])
    assert.deepEqual(r.questions, ['q1'])
    assert.ok(r.results.some(x => x.startsWith('/compact => success')))
    assert.ok(r.tools.includes('mcp__echo__echo'))
    assert.deepEqual(r.failed, [])
  })
})
