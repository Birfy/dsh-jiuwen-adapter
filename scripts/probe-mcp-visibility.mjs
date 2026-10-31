// Probe: does a chat.send with mcp:[dsh-tools] make passthrough tools visible to the Jiuwen session?
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'
const adapters = new Map()
const ctx = { llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
  logger: { info() {}, warn: console.warn, error: console.error }, provide(n, v) { this[n] = v }, on() {} }
const dir = mkdtempSync(join(tmpdir(), 'jw-probe-'))
plugin.apply(ctx, { gatewayURL: process.env.JIUWEN_GATEWAY_URL, mappingPath: join(dir, 'm.json'), requestTimeoutMs: 180_000, hostSync: false })
const a = adapters.get('jiuwen'); const sid = `probe-${Date.now()}`
const ask = 'Call tool_search with query "orchestrator_route" and then list the exact names of tools it matched (or say NONE). Do not use bash.'
for (let i = 1; i <= Number(process.env.TURNS || 2); i++) {
  let text = ''
  for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages: [{ role: 'user', content: ask }], providerOptions: { jiuwen: (i === 1 && process.env.FIRST_NO_MCP) ? {} : { mcp: ["dsh-tools"] } } }))
    if (c?.type === 'text-delta') text += c.delta ?? c.text ?? ''
  console.log(`TURN ${i}: ${text.replace(/\s+/g, ' ').slice(0, 400)}`)
}
process.exit(0)
