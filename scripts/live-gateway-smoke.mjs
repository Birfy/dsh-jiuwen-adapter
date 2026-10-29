#!/usr/bin/env node
/**
 * Live smoke against a real JiuwenSwarm gateway using a minimal generic host
 * (no DSH/FlyBot). Skips (exit 0) if the gateway is not reachable.
 *   JIUWEN_GATEWAY_URL (default ws://127.0.0.1:19000/ws), auth via JIUWEN_* env.
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
  llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => ids.forEach(i => adapters.delete(i)) } },
  logger: console, provide() {}, on() {},
}
const dir = mkdtempSync(join(tmpdir(), 'jw-live-'))
let ok = false
try {
  plugin.apply(ctx, { compat: 'none', gatewayURL: url.href, mappingPath: join(dir, 'm.json'), requestTimeoutMs: 120_000 })
  const a = adapters.get('jiuwen')
  const chunks = []
  for await (const c of a.stream({
    provider: 'jiuwen', model: 'jiuwen-default', sessionId: `live-${Date.now()}`,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  })) chunks.push(c)
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  const fin = chunks.at(-1)
  console.log('deltas=', chunks.filter(c => c.type === 'text-delta').length, 'finish=', JSON.stringify(fin?.reason ?? fin))
  console.log('text=', text.slice(0, 300))
  ok = fin?.type === 'finish' && fin.reason?.kind !== 'error' && text.trim().length > 0
  console.log(ok ? 'PASS  live gateway chat' : 'FAIL  live gateway chat')
} finally { rmSync(dir, { recursive: true, force: true }) }
process.exit(ok ? 0 : 1)
