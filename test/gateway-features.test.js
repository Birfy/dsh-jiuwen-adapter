/**
 * Gateway-mode features against bin/mock-gateway.mjs (real Jiuwen wire shapes):
 * structured events, reasoning, usage, processing_status filtering, markers compat,
 * session continuity, cancel → chat.interrupt, per-request agent/mode/skills/model,
 * multimodal base64Data, ask_user, extra E2A RPCs.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'
import { GatewayTransport } from '../src/gateway-transport.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 20000 + Math.floor(Math.random() * 5000)
const URL_ = `ws://127.0.0.1:${PORT}/ws`
let gw, dir

function host(config = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {} },
    provide(n, v) { this[n] = v }, on() {},
  }
  plugin.apply(ctx, { compat: 'none', gatewayURL: URL_, mappingPath: join(dir, `m-${Math.random()}.json`), finalGraceMs: 300, ...config })
  const a = adapters.get('jiuwen')
  return {
    api: ctx.jiuwenAdapter,
    async run(o) {
      const chunks = []
      for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 's', ...o })) chunks.push(c)
      return chunks
    },
  }
}
const txt = cs => cs.filter(c => c.type === 'text-delta').map(c => c.text).join('')
const rsn = cs => cs.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
const user = t => [{ role: 'user', content: t }]
const debug = () => new GatewayTransport({ gatewayURL: URL_ }).rpc('debug.state', {})

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jw-feat-'))
  gw = spawn(process.execPath, [join(ROOT, 'bin/mock-gateway.mjs')], { env: { ...process.env, JIUWEN_GATEWAY_MOCK_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((res, rej) => { gw.stdout.on('data', d => /listening/.test(String(d)) && res()); gw.on('exit', c => rej(new Error(`exit ${c}`))) })
})
after(() => { gw?.kill(); rmSync(dir, { recursive: true, force: true }) })

test('default: reasoning block carries Jiuwen reasoning + tool activity; text is clean; usage emitted; valid grammar', async () => {
  const h = host()
  const events = []
  h.api.onEvent(e => events.push(e))
  const cs = await h.run({ messages: user('ping') })
  assert.equal(txt(cs), 'pong-from-gateway-mock')
  assert.match(rsn(cs), /thinking about it/)
  assert.match(rsn(cs), /🔧 bash \{"command":"echo ok"\}/)
  assert.match(rsn(cs), /✓ bash: ok/)
  assert.doesNotMatch(txt(cs) + rsn(cs), /processing_status|is_processing/)
  const usage = cs.find(c => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
  assert.equal(cs.at(-1).type, 'finish'); assert.equal(cs.at(-1).reason.kind, 'stop')
  // grammar: every block-start closed before finish, usage before finish
  const open = new Set()
  for (const c of cs) { if (c.type === 'block-start') open.add(c.index); if (c.type === 'block-end') open.delete(c.index) }
  assert.equal(open.size, 0)
  const types = events.map(e => e.type)
  for (const t of ['tool_call', 'tool_update', 'tool_result', 'subtask_update', 'processing_status', 'usage', 'reasoning']) assert.ok(types.includes(t), t)
  const call = events.find(e => e.type === 'tool_call')
  assert.equal(call.name, 'bash'); assert.equal(call.id, 'call_1')
})

test('eventDisplay=markers keeps legacy text markers; none hides activity', async () => {
  const m = await host({ eventDisplay: 'markers' }).run({ messages: user('ping') })
  assert.match(txt(m), /\[jiuwen-tool:bash\]/)
  assert.match(txt(m), /\[jiuwen-tool-result:bash\] ok/)
  const n = await host({ eventDisplay: 'none', forwardReasoning: false }).run({ messages: user('ping') })
  assert.equal(txt(n), 'pong-from-gateway-mock')
  assert.equal(rsn(n), '')
})

test('session continuity: 2nd turn sends only the new user message to the same Jiuwen session', async () => {
  const h = host()
  const t1 = await h.run({ sessionId: 'cont', messages: user('echo-params first') })
  assert.match(txt(t1), /prior=0/)
  const t2 = await h.run({ sessionId: 'cont', messages: [
    { role: 'user', content: 'echo-params first' }, { role: 'assistant', content: txt(t1) }, { role: 'user', content: 'echo-params second' },
  ] })
  assert.match(txt(t2), /prior=1 query="echo-params second"/)
  const sid = h.api.jiuwenSessionId('cont')
  const hist = (await debug()).history[sid]
  assert.equal(hist.length, 4)
})

test('cancel: aborting the host signal sends chat.interrupt intent=cancel and finishes aborted', async () => {
  const h = host()
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 700)
  const cs = await h.run({ sessionId: 'cancel-me', signal: ac.signal, messages: user('slow ' + 'x'.repeat(200)) })
  assert.equal(cs.at(-1).reason.kind, 'aborted')
  await new Promise(r => setTimeout(r, 200))
  const st = await debug()
  assert.ok(st.interrupts.some(p => p.intent === 'cancel' && p.session_id === h.api.jiuwenSessionId('cancel-me')))
})

test('agent/team/model/skills selection via config, catalog model, and per-request options', async () => {
  const h = host({ agentTemplateName: 'coder', skills: ['a'] })
  let t = txt(await h.run({ messages: user('echo-params x') }))
  assert.match(t, /mode=agent model=- agent=coder group=- skills=a/)
  t = txt(await h.run({ sessionId: 's2', model: 'jiuwen-swarm', messages: user('echo-params y') }))
  assert.match(t, /mode=team\.work\.normal/)
  t = txt(await h.run({ sessionId: 's3', model: 'doubao-x', providerOptions: { jiuwen: { chatMode: 'agent.plan', agentGroupName: 'g1', skills: ['pptx'] } }, messages: user('echo-params z') }))
  assert.match(t, /mode=agent\.plan model=doubao-x agent=coder group=g1 skills=pptx/)
})

test('multimodal: image data URL and local file are sent as base64Data media_items', async () => {
  const f = join(dir, 'note.txt'); writeFileSync(f, 'hello')
  const cs = await host().run({ sessionId: 'mm', messages: [{ role: 'user', content: [
    { type: 'text', text: 'echo-params look' },
    { type: 'image', attachment: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png', name: 'a.png' } },
    { type: 'file', attachment: { name: 'note.txt', path: f, mimeType: 'text/plain' } },
  ] }] })
  assert.match(txt(cs), /media=2/)
  assert.match(txt(cs), /\[jiuwen-media:upload\.png\]/)
  const st = await debug()
  const last = Object.values(st.last).find(p => (p.media_items || []).length === 2)
  assert.equal(last.media_items[0].base64Data, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(last.media_items[1].base64Data, `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`)
})

test('ask_user_question renders question, finishes stop, and is recorded for userAnswer', async () => {
  const h = host()
  const cs = await h.run({ sessionId: 'ask', messages: user('please ask me something') })
  assert.match(txt(cs), /❓ 1\. Which color\?\n {3}red \/ blue/)
  assert.equal(cs.at(-1).reason.kind, 'stop')
})

test('extra E2A RPCs: sessions/skills/agents/team templates/commands', async () => {
  const g = host().api.gateway
  assert.ok((await g.skillsList()).skills.length)
  assert.ok((await g.agentsList()).agents.length)
  assert.ok((await g.teamTemplatesList()).templates.length)
  assert.ok(Array.isArray((await g.sessionList()).sessions))
  assert.ok((await g.commandsList()).commands.length)
  assert.equal((await g.interrupt('whatever')).intent, 'cancel')
})

test('session-title calls are answered locally (no Jiuwen turn), unwrapping JSON title prompts', async () => {
  const { localTitle } = await import('../src/adapter.js')
  assert.equal(localTitle({ messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"Fix the login bug please"}]' }] }), 'Fix the login bug please')
  const cs = await host().run({ purpose: 'session-title', messages: user('Plan my trip to Kyoto') })
  assert.equal(txt(cs), 'Plan my trip to Kyoto')
})

test('host runtime-context block is not forwarded to Jiuwen', async () => {
  const cs = await host().run({ sessionId: 'rc', messages: user('echo-params hi\n\nCurrent runtime context. This snapshot supersedes...\n\nCurrent working directory: "/tmp".') })
  assert.match(txt(cs), /query="echo-params hi"/)
})

test('host attachments service: content-addressed image is hydrated to base64Data', async () => {
  const adapters = new Map()
  const store = { async readImageRequest(ref, target) { assert.ok(target.maxBytes > 0); return { data: Buffer.from('PNGDATA'), mediaType: 'image/png' } } }
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {} }, provide() {}, on() {},
    get: (n) => (n === 'attachments' ? store : undefined),
  }
  plugin.apply(ctx, { compat: 'none', gatewayURL: URL_, mappingPath: join(dir, 'att.json'), finalGraceMs: 300 })
  const cs = []
  for await (const c of adapters.get('jiuwen').stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'att', messages: [{ role: 'user', content: [
    { type: 'text', text: 'echo-params img' },
    { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', width: 10, height: 10, bytes: 7, name: 't.png' } },
  ] }] })) cs.push(c)
  assert.match(txt(cs), /media=1/)
  const st = await debug()
  const p = Object.values(st.last).find(x => x.media_items?.[0]?.filename === 't.png')
  assert.equal(p.media_items[0].base64Data, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`)
})
