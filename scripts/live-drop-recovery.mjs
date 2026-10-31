#!/usr/bin/env node
/**
 * Live gateway drop/reconnect check against a real JiuwenSwarm gateway (generic host, no dsh).
 * Needs a controllable gateway: GW_KILL / GW_START are shell commands that kill / start it.
 * Use a scripted stand-in model whose reply is slow when the query contains SLOW<ms>.
 * Skips (exit 0) when GW_KILL/GW_START are unset or the gateway is unreachable.
 */
import { connect } from 'node:net'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const url = new URL(process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws')
const probe = () => new Promise(r => {
  const s = connect(Number(url.port || 80), url.hostname, () => { s.end(); r(true) })
  s.on('error', () => r(false)); s.setTimeout(1500, () => { s.destroy(); r(false) })
})
const { GW_KILL, GW_START } = process.env
if (!GW_KILL || !GW_START || !(await probe())) { console.log('SKIP  need GW_KILL, GW_START and a reachable gateway'); process.exit(0) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitUp = async (ms = 60_000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await probe()) { await sleep(3000); return true } await sleep(500) } return false }

const adapters = new Map()
const ctx = {
  llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
  logger: { info() {}, warn() {}, error() {} }, provide(n, v) { this[n] = v }, on() {},
}
const dir = mkdtempSync(join(tmpdir(), 'jw-drop-'))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
try {
  plugin.apply(ctx, { gatewayURL: url.href, mappingPath: join(dir, 'm.json'), requestTimeoutMs: 120_000, recoverWindowMs: 3000 })
  const a = adapters.get('jiuwen')
  const run = async (sid, q, extra = {}) => {
    const cs = []
    const t0 = Date.now()
    try { for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages: [{ role: 'user', content: q }], ...extra })) cs.push(c) }
    catch (e) { return { threw: e, ms: Date.now() - t0, cs } }
    return { cs, ms: Date.now() - t0, text: cs.filter(c => c.type === 'text-delta').map(c => c.text).join(''), fin: cs.at(-1) }
  }
  const store = () => ctx.jiuwenAdapter?.sessions
  const sid = `drop-${Date.now()}`

  const t1 = await run(sid, 'TAG:one hello')
  check('baseline turn', t1.fin?.reason?.kind === 'stop' && /stand-in reply one/.test(t1.text), JSON.stringify(t1.text))
  const jw1 = store()?.get?.(sid)?.jiuwenSessionId

  // Mid-turn drop: kill the gateway while the model is still streaming.
  const p = run(sid, 'TAG:two SLOW12000')
  await sleep(3000); execSync(GW_KILL, { stdio: 'ignore' })
  const t2 = await p
  check('mid-turn drop fails soft (no throw, error finish)', !t2.threw && t2.fin?.type === 'finish' && t2.fin.reason?.kind === 'error', `${t2.ms}ms ${JSON.stringify(t2.fin?.reason)?.slice(0, 160)}`)

  // While down: a turn fails fast and soft.
  const t3 = await run(sid, 'TAG:three')
  check('turn while gateway down fails soft and fast', !t3.threw && t3.fin?.reason?.kind === 'error' && t3.ms < 15_000, `${t3.ms}ms`)

  execSync(GW_START, { stdio: 'ignore' }); check('gateway restarted', await waitUp())
  const t4 = await run(sid, 'TAG:four after restart')
  check('turn after restart succeeds (reconnect)', t4.fin?.reason?.kind === 'stop' && /stand-in reply four/.test(t4.text), JSON.stringify(t4.text))
  check('session mapping kept (same Jiuwen session)', !jw1 || store()?.get?.(sid)?.jiuwenSessionId === jw1, `${jw1}`)
  check('Jiuwen conversation continued (n>1 user msgs seen by model)', /n=([2-9]|\d\d)/.test(t4.text || ''), JSON.stringify(t4.text))

  // Idle drop: restart with no turn in flight, then RPC + turn.
  execSync(GW_KILL, { stdio: 'ignore' }); await sleep(1500); execSync(GW_START, { stdio: 'ignore' }); await waitUp()
  let rpcOk = false
  try { await ctx.jiuwenAdapter.gateway.rpc('session.list', {}); rpcOk = true } catch { /* fail */ }
  check('idle restart: unary RPC works', rpcOk)
  const t5 = await run(sid, 'TAG:five idle')
  check('idle restart: turn succeeds', t5.fin?.reason?.kind === 'stop' && /stand-in reply five/.test(t5.text), JSON.stringify(t5.text))
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
console.log(`\nlive drop: ${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
