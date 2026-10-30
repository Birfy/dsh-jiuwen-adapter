#!/usr/bin/env node
/**
 * Stress probe on a real Cordis host + dsh-llm: 10 concurrent sessions × 3 turns, 50 rapid
 * `/jiuwen` commands, a reconnect storm (Gateway killed 3×), then a leak check after dispose.
 * Default target: a private bin/mock-gateway.mjs on a random port (restarted for the storm).
 * `--live` uses JIUWEN_GATEWAY_URL / ws://127.0.0.1:19000/ws for the first two phases only (the
 * storm always uses the mock) and deletes every session it created.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const LIVE = process.argv.includes('--live')
const NM = process.env.DSH_NM || '/workspace/fb-busyack3/core/dev/harness/node_modules'
const ROOT = new URL('..', import.meta.url).pathname
const tick = ms => new Promise(r => setTimeout(r, ms))
const keep = setInterval(() => {}, 1000)
const unhandled = []
process.on('unhandledRejection', e => unhandled.push(String(e?.message || e)))
const PORT = 20000 + Math.floor(Math.random() * 20000)
let mock
async function startMock() {
  mock = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], { env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise(r => mock.stdout.on('data', d => /listening/.test(String(d)) && r()))
}
const stopMock = () => new Promise(r => { mock.once('exit', r); mock.kill('SIGKILL') })
await startMock()
const URL_ = LIVE ? (process.env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws') : `ws://127.0.0.1:${PORT}/ws`

const resBefore = process.getActiveResourcesInfo().length
const procBefore = process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).join()
const { Context } = await import(pathToFileURL(join(NM, '@deepseek-ai/cordis/lib/index.js')).href)
const llmMod = await import(pathToFileURL(join(NM, '@deepseek-ai/dsh-llm/lib/index.js')).href)
const ctx = new Context()
ctx.plugin(llmMod.default)
const dir = mkdtempSync(join(tmpdir(), 'jw-stress-'))
const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
const mk = url => ctx.plugin(plugin, { gatewayURL: url, mappingPath: join(dir, `${url.length}-${Date.now()}.json`), requestTimeoutMs: 120_000, mode: 'gateway' })
let fork = mk(URL_)
await tick(300)
const api = () => ctx.get?.('jiuwenAdapter') ?? ctx.jiuwenAdapter
async function turn(sid, text) {
  let out = ''
  for await (const c of ctx.llm.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages: [{ role: 'user', content: [{ type: 'text', text }] }] })) {
    if (c.type === 'text-delta') out += c.text; else if (c.type === 'finish' && c.reason?.kind === 'error') out += '[finish:error]'
  }
  return out
}
const report = { live: LIVE }
const created = []
// Phase 1: 10 sessions × 3 sequential turns, sessions concurrent.
let t0 = Date.now()
const p1 = await Promise.allSettled(Array.from({ length: 10 }, async (_, i) => {
  const sid = `stress-${process.pid}-${i}`; created.push(sid)
  const outs = []
  for (let k = 0; k < 3; k++) outs.push(await turn(sid, `Reply with exactly: s${i}t${k}`))
  return outs
}))
const outs = p1.map(r => r.status === 'fulfilled' ? r.value : [`REJ ${r.reason?.message}`])
const mapping = await Promise.all(created.map(async sid => String(await api().command(sid, 'status')).match(/Jiuwen session (\S+)/)?.[1]))
report.concurrent = { ms: Date.now() - t0, ok: outs.flat().filter(o => o && !/error|REJ/.test(o)).length, of: 30, distinctJiuwenSessions: new Set(mapping.filter(Boolean)).size, crossTalk: outs.some((o, i) => o.some(x => /s\d+t\d+/.test(x) && !x.includes(`s${i}t`))) }
// Phase 2: 50 rapid slash commands (mixed reads), all concurrent.
const cmds = ['status', 'version', 'models', 'help', 'mode', 'tools', 'sessions', 'skills', 'cron', 'path']
t0 = Date.now()
const p2 = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => api().command(created[i % 10], cmds[i % cmds.length])))
report.rapidCommands = { ms: Date.now() - t0, fulfilled: p2.filter(r => r.status === 'fulfilled').length, threw: p2.filter(r => r.status === 'rejected').map(r => String(r.reason?.message).slice(0, 60)), errText: p2.filter(r => r.status === 'fulfilled' && /^Jiuwen: /.test(String(r.value))).length }
if (LIVE) { for (const sid of created) try { await api().command(sid, 'delete confirm') } catch {} ; fork.dispose(); await tick(300); fork = mk(`ws://127.0.0.1:${PORT}/ws`); await tick(300) }
// Phase 3: reconnect storm against the mock: kill it 3×, a turn during the outage must fail soft, a turn after restart must succeed.
const storm = []
for (let k = 0; k < 3; k++) {
  await stopMock(); await tick(200)
  const down = await turn(`storm-${k}`, 'x').catch(e => `THROW ${e.message}`)
  await startMock(); await tick(300)
  const up = await turn(`storm-${k}`, `Reply with exactly: up${k}`).catch(e => `THROW ${e.message}`)
  storm.push({ down: down.slice(0, 40), up: up.slice(0, 40) })
}
report.reconnectStorm = storm
// Phase 4: leak check after dispose.
fork.dispose(); await tick(1500)
await stopMock(); await tick(200)
clearInterval(keep)
const res = process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap')
report.leak = { resourcesBefore: resBefore, resourcesAfter: res.length, after: res, procListenersSame: procBefore === process.eventNames().map(n => `${String(n)}:${process.listenerCount(n)}`).join(), providersAfter: ctx.llm.listProviders().map(p => p.id), serviceGone: (ctx.get?.('jiuwenAdapter') ?? undefined) === undefined }
report.unhandled = unhandled
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 1))
process.exit(0)
