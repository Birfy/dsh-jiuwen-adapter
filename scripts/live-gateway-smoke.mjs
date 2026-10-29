#!/usr/bin/env node
/**
 * Live smoke against a real JiuwenSwarm gateway with a minimal generic host
 * (no DSH/FlyBot). Skips (exit 0) if the gateway is not reachable.
 *   JIUWEN_GATEWAY_URL (default ws://127.0.0.1:19000/ws), auth via JIUWEN_* env.
 * Covers: plain chat, multi-turn continuity, Jiuwen-owned tool use (structured events),
 * usage, processing_status filtering, cancel → chat.interrupt, E2A RPCs.
 */
import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const url = new URL(process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws')
const up = await new Promise(r => {
  const s = connect(Number(url.port || 80), url.hostname, () => { s.end(); r(true) })
  s.on('error', () => r(false)); s.setTimeout(2000, () => { s.destroy(); r(false) })
})
if (!up) { console.log(`SKIP  gateway ${url.href} not reachable`); process.exit(0) }

const adapters = new Map()
const ctx = {
  llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
  logger: { info() {}, warn: console.warn, error: console.error }, provide(n, v) { this[n] = v }, on() {},
}
const dir = mkdtempSync(join(tmpdir(), 'jw-live-'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const sid = `live-${Date.now()}`
try {
  plugin.apply(ctx, { compat: 'none', gatewayURL: url.href, mappingPath: join(dir, 'm.json'), requestTimeoutMs: 180_000 })
  const a = adapters.get('jiuwen')
  const events = []
  ctx.jiuwenAdapter.onEvent(e => events.push(e))
  const run = async (messages, extra = {}) => {
    const cs = []
    for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages, ...extra })) cs.push(c)
    return {
      cs,
      text: cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''),
      reasoning: cs.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''),
      fin: cs.at(-1),
    }
  }
  const t1 = await run([{ role: 'user', content: 'Remember the codeword "tangerine-42". Reply with just OK.' }])
  check('turn1 plain chat', t1.fin.reason?.kind === 'stop' && t1.text.trim().length > 0, JSON.stringify(t1.text.slice(0, 80)))
  check('processing_status not leaked', !/processing_status|is_processing/.test(t1.text + t1.reasoning))
  check('usage chunk', !!t1.cs.find(c => c.type === 'usage'), JSON.stringify(t1.cs.find(c => c.type === 'usage')?.usage))

  const t2 = await run([
    { role: 'user', content: 'Remember the codeword "tangerine-42". Reply with just OK.' },
    { role: 'assistant', content: t1.text },
    { role: 'user', content: 'What was the codeword? Answer with only the codeword.' },
  ])
  check('turn2 continuity (Jiuwen session memory)', /tangerine-42/.test(t2.text), JSON.stringify(t2.text.slice(0, 80)))

  events.length = 0
  const t3 = await run([{ role: 'user', content: "Use your bash tool to run `echo live-tool-$((6*7))` and tell me the exact output." }])
  const call = events.find(e => e.type === 'tool_call')
  check('tool use: structured tool_call event', !!call, call ? `${call.name} ${call.arguments}` : '')
  check('tool use: tool_result + answer', events.some(e => e.type === 'tool_result') && /live-tool-42/.test(t3.text), JSON.stringify(t3.text.slice(0, 100)))
  check('tool activity in reasoning block', /🔧/.test(t3.reasoning))
  check('streamed (>1 text delta)', t3.cs.filter(c => c.type === 'text-delta').length > 1, `${t3.cs.filter(c => c.type === 'text-delta').length} deltas`)

  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 4000)
  const t4 = await run([{ role: 'user', content: 'Write a 2000-word essay about the history of tea.' }], { signal: ac.signal })
  check('cancel → aborted finish quickly', t4.fin.reason?.kind === 'aborted' && Date.now() - t0 < 10_000, `${Date.now() - t0}ms`)

  const g = ctx.jiuwenAdapter.gateway
  const sl = await g.sessionList()
  check('session.list includes our session', JSON.stringify(sl).includes(ctx.jiuwenAdapter.jiuwenSessionId(sid)))
  check('skills.list', Array.isArray((await g.skillsList()).skills))
  check('team.templates.list', Array.isArray((await g.teamTemplatesList()).templates))
  check('models.list', Array.isArray((await g.modelsList()).models))
} catch (e) {
  check('live run', false, String(e?.stack || e))
} finally { rmSync(dir, { recursive: true, force: true }) }
const ok = results.every(Boolean)
console.log(`\nlive: ${results.filter(Boolean).length}/${results.length} passed`)
process.exit(ok ? 0 : 1)
