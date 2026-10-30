/**
 * Gateway-mode features against bin/mock-gateway.mjs (real Jiuwen wire shapes):
 * structured events, reasoning, usage, processing_status filtering, legacy markers,
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
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `m-${Math.random()}.json`), finalGraceMs: 300, ...config })
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
  const h = host()
  const cs = await h.run({ sessionId: 'title-sync', purpose: 'session-title', messages: user('Plan my trip to Kyoto') })
  assert.equal(txt(cs), 'Plan my trip to Kyoto')
  // Fire-and-forget session.rename for local titleMode compatibility
  await new Promise(r => setTimeout(r, 200))
  const st = await debug()
  const jw = h.api.jiuwenSessionId('title-sync')
  assert.ok(st.renames.some(r => r.session_id === jw && r.title === 'Plan my trip to Kyoto'), JSON.stringify(st.renames))
  assert.equal(h.api.sessions.get('title-sync')?.title, 'Plan my trip to Kyoto')
  // Skip rename spam when title unchanged
  await h.run({ sessionId: 'title-sync', purpose: 'session-title', messages: user('Plan my trip to Kyoto') })
  await new Promise(r => setTimeout(r, 200))
  const st2 = await debug()
  assert.equal(st2.renames.filter(r => r.session_id === jw && r.title === 'Plan my trip to Kyoto').length, 1)
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
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, 'att.json'), finalGraceMs: 300 })
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

test('cancel-then-continue: next send on the session waits out the post-cancel settle (JiuwenSwarm race)', async () => {
  const mappingPath = join(dir, `settle-${Math.random()}.json`)
  const run1 = host({ mappingPath })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 500)
  const c1 = await run1.run({ sessionId: 'race', signal: ac.signal, messages: user('slow ' + 'y'.repeat(200)) })
  assert.equal(c1.at(-1).reason.kind, 'aborted')
  const t0 = Date.now()
  const c2 = await run1.run({ sessionId: 'race', messages: user('ping') })
  assert.equal(txt(c2), 'pong-from-gateway-mock')
  assert.ok(Date.now() - t0 >= 500, 'waited for settle window')

  // cross-process: a fresh host on the same mapping file still honours the persisted lastCancelAt
  const ac2 = new AbortController()
  setTimeout(() => ac2.abort(), 500)
  await run1.run({ sessionId: 'race', signal: ac2.signal, messages: user('slow ' + 'z'.repeat(200)) })
  const run2 = host({ mappingPath })
  assert.equal(txt(await run2.run({ sessionId: 'race', messages: user('ping') })), 'pong-from-gateway-mock')
})

test('cancel-then-continue without settle reproduces the hang (guards the mock emulation)', async () => {
  const h = host({ postCancelSettleMs: 0, requestTimeoutMs: 1500 })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 500)
  await h.run({ sessionId: 'race0', signal: ac.signal, messages: user('slow ' + 'w'.repeat(200)) })
  const c = await h.run({ sessionId: 'race0', messages: user('ping') })
  assert.notEqual(txt(c), 'pong-from-gateway-mock')
  assert.equal(c.at(-1).reason.kind, 'error')
})

test('turn ends on the terminal (empty, request-scoped) chat.final without waiting for a late processing_status', async () => {
  const h = host({ finalGraceMs: 5000 })
  const t0 = Date.now()
  const cs = await h.run({ sessionId: 'late', messages: user('ping late-status') })
  const ms = Date.now() - t0
  assert.equal(txt(cs), 'pong-from-gateway-mock')
  assert.equal(cs.at(-1).reason.kind, 'stop')
  assert.ok(cs.some(c => c.type === 'usage'), 'usage (sent before terminal final) is kept')
  assert.ok(ms < 2000, `ended early (${ms} ms)`)
  const slow = host({ finalGraceMs: 5000, terminalFinalGraceMs: -1 })
  const t1 = Date.now()
  await slow.run({ sessionId: 'late2', messages: user('ping late-status') })
  assert.ok(Date.now() - t1 >= 2900, 'disabled: waits for processing_status')
})

test('no idle timer is left pending after a turn (short-lived hosts exit promptly)', async () => {
  const h = host()
  const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length
  await h.run({ sessionId: 'timers', messages: user('ping') })
  const before = timers()
  await h.run({ sessionId: 'timers', messages: user('ping') })
  await new Promise(r => setImmediate(r))
  assert.ok(timers() <= before, `timers leaked: ${before} -> ${timers()}`)
})

function hostWith(services, config = {}) {
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {} }, provide(n, v) { this[n] = v }, on() {},
    get: (n) => services[n],
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `w-${Math.random()}.json`), finalGraceMs: 300, ...config })
  const a = adapters.get('jiuwen')
  return async (o) => { const cs = []; for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', ...o })) cs.push(c); return cs }
}

test('ask_user → dsh userQuestions.ask → resume chat.send with mapped answer', async () => {
  const asked = []
  const run = hostWith({ userQuestions: { async ask(r) { asked.push(r); return { answers: [{ id: r.questions[0].id, selected: ['Blue'] }] } } } })
  const cs = await run({ sessionId: 'uq', messages: user('please ask me something') })
  assert.equal(asked[0].questions[0].question, 'Which color?')
  assert.deepEqual(asked[0].questions[0].options.map(o => o.label), ['Red', 'Blue'])
  assert.match(txt(cs), /answered ask_user_interrupt: blue/)
  assert.equal(cs.at(-1).reason.kind, 'stop')
})

test('ask_user with userQuestions but no answerer → neutral reply, turn continues', async () => {
  const run = hostWith({ userQuestions: { async ask() { throw Object.assign(new Error('none'), { code: 'NO_PROVIDER' }) } } })
  const cs = await run({ sessionId: 'uq2', messages: user('please ask me something') })
  assert.match(txt(cs), /answered ask_user_interrupt: No interactive user/)
})

test('permission_interrupt → ctx.approval; allowed-once → allow_once, no UI → reject', async () => {
  const agent = { id: 'pa' }
  const reqs = []
  const allow = hostWith({ agents: { get: (id) => (id === 'pa' ? agent : undefined) }, approval: { async request(r) { reqs.push(r); return 'allowed-once' } } })
  assert.match(txt(await allow({ sessionId: 'pa', messages: user('need permission') })), /answered permission_interrupt: allow_once/)
  assert.equal(reqs[0].agent, agent)
  assert.equal(reqs[0].toolName, 'bash')
  const deny = hostWith({})
  assert.match(txt(await deny({ sessionId: 'pd', messages: user('need permission') })), /answered permission_interrupt: reject/)
  const st = await debug()
  assert.ok(st.answers.some(a => a.answers?.[0]?.card_id === 'card-1'))
  const slow = hostWith({ agents: { get: () => agent }, approval: { request: () => new Promise(() => {}) } }, { approvalTimeoutMs: 200 })
  assert.match(txt(await slow({ sessionId: 'pt', messages: user('need permission') })), /reject/)
})

test('compaction is answered locally by default (no Jiuwen turn); compactionMode=jiuwen keeps the aux turn', async () => {
  const { localCompaction } = await import('../src/adapter.js')
  const msgs = [{ role: 'user', content: 'alpha' }, { role: 'assistant', content: [{ type: 'text', text: 'beta' }] }, { role: 'user', content: 'COMPACT NOW' }]
  const d = localCompaction({ messages: msgs }, [], 'jw-1')
  assert.match(d, /- user: alpha\n- assistant: beta$/)
  assert.doesNotMatch(d, /COMPACT NOW/)
  const before = Object.keys((await debug()).history).length
  const cs = await host().run({ sessionId: 'cmp', purpose: 'compaction', messages: msgs })
  assert.match(txt(cs), /local digest/)
  assert.equal(Object.keys((await debug()).history).length, before)
  const cs2 = await host({ compactionMode: 'jiuwen' }).run({ sessionId: 'cmp2', purpose: 'compaction', messages: msgs })
  assert.doesNotMatch(txt(cs2), /local digest/)
})

test('/jiuwen command: status / models / model switch → model_name / bad sub', async () => {
  const registered = []
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { assert.deepEqual(deps, ['commands']); cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, 'cmd.json'), finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  assert.ok(def)
  const run = (raw) => def.handler({ agent: { id: 'cmd-s' }, rawInput: raw })
  const st = await run('status')
  assert.equal(st.kind, 'success')
  assert.match(st.text, /dsh session cmd-s → Jiuwen session/)
  assert.match(st.text, /title:/)
  assert.equal((await run('nope')).kind, 'success')
  assert.match((await run('nope')).text, /Unknown subcommand/)
})

test('/jiuwen mode persists and next chat.send includes that mode', async () => {
  const registered = []
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  const mappingPath = join(dir, `mode-${Math.random()}.json`)
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath, finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const sid = 'mode-s'
  const set = await def.handler({ agent: { id: sid }, rawInput: 'mode agent.plan' })
  assert.equal(set.kind, 'success')
  assert.match(set.text, /mode=agent\.plan/)
  const a = adapters.get('jiuwen')
  const cs = []
  for await (const c of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: sid, messages: user('echo-params check') })) cs.push(c)
  assert.match(txt(cs), /mode=agent\.plan/)
  const cleared = await def.handler({ agent: { id: sid }, rawInput: 'mode default' })
  assert.match(cleared.text, /default chat mode/)
})

test('/jiuwen pause resume rename pin goal workflows history unmap delete', async () => {
  const registered = []
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  const mappingPath = join(dir, `cmds-${Math.random()}.json`)
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath, finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const api = ctx.jiuwenAdapter
  const run = (id, raw) => def.handler({ agent: { id }, rawInput: raw })

  assert.match((await run('p1', 'pause')).text, /pause/)
  assert.match((await run('p1', 'resume')).text, /resume/)
  const st = await debug()
  assert.ok(st.interrupts.some(p => p.intent === 'pause'))
  assert.ok(st.interrupts.some(p => p.intent === 'resume'))

  assert.match((await run('rn', 'rename My Title')).text, /My Title/)
  assert.match((await run('pn', 'pin')).text, /pinned/)
  assert.match((await run('pn', 'pin off')).text, /unpinned/)

  const goal = await run('g1', 'goal')
  assert.equal(goal.kind, 'success')
  assert.match(goal.text, /goal get/)
  assert.match((await run('g1', 'goal set ship it')).text, /ship it/)

  assert.match((await run('w1', 'workflows')).text, /No workflows|Workflows/)
  // seed history then read it
  const a = adapters.get('jiuwen')
  for await (const _ of a.stream({ provider: 'jiuwen', model: 'jiuwen-default', sessionId: 'hist', messages: user('ping') })) { /* drain */ }
  assert.match((await run('hist', 'history')).text, /History for|pong|ping/)

  const fork = await run('fk', 'fork')
  assert.equal(fork.kind, 'success')
  assert.match(fork.text, /new session_id=|Forked/)
  // mapping for fk must still exist
  assert.ok(api.sessions.get('fk'))

  const jwBefore = api.sessions.get('um')?.jiuwenSessionId || api.jiuwenSessionId('um')
  assert.match((await run('um', 'unmap')).text, /Removed local mapping/)
  assert.equal(api.sessions.get('um'), undefined)

  api.jiuwenSessionId('del') // ensure mapping
  assert.match((await run('del', 'delete')).text, /Jiuwen session .* deleted and local mapping cleared/)
  assert.equal(api.sessions.get('del'), undefined)

  // gateway helpers exposed
  assert.equal(typeof api.gateway.sessionRename, 'function')
  assert.equal(typeof api.gateway.sessionPin, 'function')
  assert.equal(typeof api.gateway.goal, 'function')
  assert.equal(typeof api.gateway.skillsToggle, 'function')
  const toggled = await api.gateway.skillsToggle('mock-skill', true)
  assert.equal(toggled.name, 'mock-skill')
  assert.equal(toggled.enabled, true)
})


test('/jiuwen btw recap skill-toggle plan-status supplement teams skills installed', async () => {
  const registered = []
  const adapters = new Map()
  const ctx = {
    llm: { registerAdapter(ids, a) { ids.forEach(i => adapters.set(i, a)); return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  const mappingPath = join(dir, `cmds2-${Math.random()}.json`)
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath, finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const api = ctx.jiuwenAdapter
  const run = (id, raw) => def.handler({ agent: { id }, rawInput: raw })

  const btw = await run('n1', 'btw what is this about?')
  assert.equal(btw.kind, 'success')
  assert.match(btw.text, /btw-mock: what is this about/)
  assert.match((await run('n1', 'btw')).text, /Usage: \/jiuwen btw/)

  const recap = await run('n1', 'recap')
  assert.equal(recap.kind, 'success')
  assert.match(recap.text, /mock recap/)

  assert.match((await run('n1', 'skill-toggle')).text, /Usage: \/jiuwen skill-toggle/)
  assert.match((await run('n1', 'skill-toggle mock-skill on')).text, /enabled/)
  assert.match((await run('n1', 'skill-toggle mock-skill off')).text, /disabled/)

  const ps = await run('n1', 'plan-status')
  assert.equal(ps.kind, 'success')
  assert.match(ps.text, /in_plan=false/)

  assert.match((await run('n1', 'supplement')).text, /Usage: \/jiuwen supplement/)
  assert.match((await run('n1', 'supplement more context please')).text, /supplement/)
  const st = await debug()
  assert.ok(st.interrupts.some(p => p.intent === 'supplement' && p.new_input === 'more context please'))

  const teams = await run('n1', 'teams')
  assert.equal(teams.kind, 'success')
  assert.match(teams.text, /jiuwen_team|mock-team/)

  assert.match((await run('n1', 'skills')).text, /mock-skill/)
  assert.match((await run('n1', 'skills installed')).text, /installed-skill/)

  assert.equal(typeof api.gateway.btw, 'function')
  assert.equal(typeof api.gateway.recap, 'function')
  assert.equal(typeof api.gateway.planStatus, 'function')
  assert.equal(typeof api.gateway.teamList, 'function')
  assert.equal(typeof api.gateway.skillsInstalled, 'function')
  assert.equal((await api.gateway.planStatus('n1')).in_plan, false)
  assert.ok((await api.gateway.skillsInstalled()).skills.length)
  assert.ok((await api.gateway.teamList()).teams.length)
})


test('/jiuwen tools hooks permissions plugins projects archived assets version heartbeat', async () => {
  const registered = []
  const ctx = {
    llm: { registerAdapter() { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `cmds3-${Math.random()}.json`), finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const run = async (raw) => { const r = await def.handler({ agent: { id: 'n3' }, rawInput: raw }); assert.equal(r.kind, 'success', r.text); return r.text }
  assert.match(await run('tools'), /tools \(2\): Read, Bash/)
  assert.match(await run('hooks'), /2 across 2 events \(PreToolUse=2\)/)
  const perms = await run('permissions')
  assert.match(perms, /allow=1/); assert.match(perms, /ask: acp_chat/); assert.match(perms, /deny: rm_rf/); assert.match(perms, /rules: 1/)
  assert.match(await run('plugins'), /skill-creator, old-plugin \(disabled\)/)
  assert.match(await run('projects'), /Default \(default(?:, work)?\) \[default\]/)
  assert.match(await run('archived'), /\(1\): Old chat/)
  assert.match(await run('assets'), /asset-/)
  assert.match(await run('version'), /9\.9\.9 \(pip, linux\), latest 10\.0\.0 \(update available\)/)
  assert.match(await run('heartbeat'), /every 3600s → web, active 08:00-22:00/)
  assert.match(def.input.hint, /heartbeat/)
  const g = ctx.jiuwenAdapter.gateway
  for (const fn of ['agentsToolsList', 'hooksList', 'permissionsToolsGet', 'permissionsRulesGet', 'pluginsList', 'projectList', 'sessionArchivedList', 'sessionAssetsList', 'updaterStatus', 'heartbeatConf']) assert.equal(typeof g[fn], 'function', fn)
})

test('/jiuwen archive switch permissions set/unset plugins enable/disable heartbeat set/jobs projects info/sessions model-info path locale commands templates cron', async () => {
  const registered = []
  const ctx = {
    llm: { registerAdapter() { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `cmds4-${Math.random()}.json`), finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const g = ctx.jiuwenAdapter.gateway
  const run = async (raw, id = 'n4') => { const r = await def.handler({ agent: { id }, rawInput: raw }); assert.equal(r.kind, 'success', r.text); return r.text }

  assert.match(await run('switch'), /Switched Jiuwen session/)
  assert.match(await run('archive'), /Archived Jiuwen session/)
  assert.match(await run('unarchive'), /Unarchived Jiuwen session/)

  assert.match(await run('permissions set __probe__ ask'), /__probe__=ask/)
  assert.match(await run('permissions'), /ask:.*__probe__/)
  assert.match(await run('permissions unset __probe__'), /Removed permission/)
  assert.doesNotMatch(await run('permissions'), /__probe__/)

  assert.match(await run('plugins disable skill-creator'), /disabled/)
  assert.match(await run('plugins'), /skill-creator \(disabled\)/)
  assert.match(await run('plugins enable skill-creator'), /enabled/)
  assert.match(await run('plugins'), /skill-creator,/)

  assert.match(await run('heartbeat set 7200 web'), /every 7200s → web/)
  assert.match(await run('heartbeat'), /every 7200s → web/)
  assert.match(await run('heartbeat set 3600'), /every 3600s/)
  assert.match(await run('heartbeat jobs'), /hb-job-1|mock-hb/)

  assert.match(await run('projects info'), /project Default \(default\)/)
  assert.match(await run('projects sessions'), /Project sessions|No sessions/)

  assert.match(await run('model-info jiuwen-default'), /mdl_default_primary.*jiuwen-default/)
  assert.match(await run('model-info mdl_swarm'), /mdl_swarm/)

  assert.match(await run('path'), /headless=true/)
  assert.match(await run('locale'), /zh/)
  assert.match(await run('commands'), /compact.*fork|fork.*compact/)
  assert.match(await run('templates'), /engineering-quality-mentor/)
  assert.match(await run('cron'), /cron-1|mock-cron/)

  assert.match(def.input.hint, /archive/)
  assert.match(def.input.hint, /model-info/)
  assert.match(def.input.hint, /templates/)

  for (const fn of [
    'sessionArchive', 'sessionUnarchive', 'sessionSwitch',
    'permissionsToolsUpdate', 'permissionsToolsDelete',
    'pluginsEnable', 'pluginsDisable',
    'heartbeatSetConf', 'heartbeatJobList',
    'projectInfo', 'projectGetSessions', 'modelsGet',
    'pathGet', 'localeGetConf', 'cronJobList', 'agentTemplatesList',
  ]) assert.equal(typeof g[fn], 'function', fn)

  assert.equal((await g.sessionArchive('s-x')).succeeded_count, 1)
  assert.equal((await g.pluginsDisable('old-plugin')).success, true)
  assert.equal((await g.modelsGet('mdl_default_primary')).model.model_id, 'mdl_default_primary')
})

test('/jiuwen updater agent skill-info marketplaces bindings help + validation/errors', async () => {
  const registered = []
  const ctx = {
    llm: { registerAdapter() { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `cmds5-${Math.random()}.json`), finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const call = (raw) => def.handler({ agent: { id: 'n5' }, rawInput: raw })
  const run = async (raw) => { const r = await call(raw); assert.equal(r.kind, 'success', r.text); return r.text }
  assert.match(await run('updater'), /updater status: 9\.9\.9 → update available: 10\.0\.0/)
  assert.match(await run('updater check'), /updater check: .*state=update_available/)
  assert.match(await run('updater conf'), /enabled, source pypi \(openJiuwen\/jiuwenswarm\)/)
  assert.match(await run('updater upgrade'), /Usage: \/jiuwen updater/)
  assert.match(await run('agent'), /Usage: \/jiuwen agent <name>/)
  assert.match(await run('agent mock-agent'), /Mock agent[\s\S]*tools: bash/)
  const missing = await call('agent nope')
  assert.equal(missing.kind, 'error'); assert.match(missing.text, /Agent 不存在: nope/)
  assert.match(await run('skill-info'), /Usage/)
  assert.match(await run('skill-info skill-creator'), /Mock skill[\s\S]*versions: 1\.0 \(default 1\.0\)/)
  assert.match(await run('marketplaces'), /\(2\): anthropic \(disabled\), builtin/)
  assert.match(await run('bindings'), /mock-team/)
  const help = await run('help')
  for (const k of ['Session:', 'Turn control:', 'Models & mode:', 'Skills & agents:', 'Config & policy:', 'System:']) assert.ok(help.includes(k), k)
  const unk = await run('frobnicate')
  assert.match(unk, /Unknown subcommand "frobnicate"[\s\S]*Session:/)
  for (const s of ['updater', 'agent', 'skill-info', 'marketplaces', 'bindings', 'help']) assert.match(def.input.hint, new RegExp(s))
})

test('rpc timeout rejects promptly and transport recovers on next call', async () => {
  const { GatewayTransport } = await import('../src/gateway-transport.js')
  const g = new GatewayTransport({ gatewayURL: URL_, requestTimeoutMs: 5000 })
  const t0 = Date.now()
  await assert.rejects(g.rpc('debug.hang', {}, { timeoutMs: 300 }), /time|out/i)
  assert.ok(Date.now() - t0 < 3000)
  const r = await g.updaterStatus()
  assert.equal(r.current_version, '9.9.9')
})

test('connection refused yields a clear /jiuwen error hint', async () => {
  const registered = []
  const ctx = {
    llm: { registerAdapter() { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: 'ws://127.0.0.1:1/ws', mappingPath: join(dir, `cmds6-${Math.random()}.json`), requestTimeoutMs: 2000 })
  const def = registered.find(d => d.name === 'jiuwen')
  const r = await def.handler({ agent: { id: 'n6' }, rawInput: 'version' })
  assert.equal(r.kind, 'error')
  assert.match(r.text, /^Jiuwen: /)
})

test('JiuwenSwarm 0.2.7 shape: assets degrade, teams via team.bindings.list, model-info without model_id', async () => {
  const registered = []
  const ctx = {
    llm: { registerAdapter() { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, provide(n, v) { this[n] = v }, on() {},
    inject(deps, cb) { cb({ commands: { register(d) { registered.push(d); return () => {} } }, on() {} }) },
  }
  plugin.apply(ctx, { gatewayURL: URL_, mappingPath: join(dir, `cmds027-${Math.random()}.json`), finalGraceMs: 300 })
  const def = registered.find(d => d.name === 'jiuwen')
  const run = async (raw) => { const r = await def.handler({ agent: { id: 'n027' }, rawInput: raw }); assert.equal(r.kind, 'success', r.text); return r.text }
  const shape = (v) => new GatewayTransport({ gatewayURL: URL_ }).rpc('debug.set_shape', { shape: v })
  await shape('0.2.7')
  try {
    assert.match(await run('assets'), /not available.*session\.assets\.list/)
    const teams = await run('teams')
    assert.match(teams, /templates: jiuwen_team|templates: /); assert.match(teams, /teams: mock-team/)
    const mi = await run('model-info jiuwen-default')
    assert.match(mi, /model-info jiuwen-default; alias=primary; provider=OpenAI/); assert.match(mi, /default/); assert.match(mi, /api_key=set/)
    assert.doesNotMatch(mi, /sk-secret-mock/)
    assert.match(await run('model-info primary'), /jiuwen-default/)
    assert.match(await run('model-info #1'), /jiuwen-swarm.*api_key=missing/)
    assert.match(await run('model-info nope'), /Unknown model "nope".*jiuwen-default/)
  } finally { await shape('0.2.5') }
})
