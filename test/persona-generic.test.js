import test from 'node:test'
import assert from 'node:assert/strict'
import { applySystemInjection, genericPersona, extractPersona } from '../src/system-inject.js'
import { createPersonaCapture, personaFromAssembly } from '../src/persona-capture.js'

const BOILER = 'You are an AI agent powered by DeepSeek Harness.\n\nCheck the [exit code: N] marker on every bash result.'
const opts = sys => ({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })

test('generic persona: forwarded only when FlyBot markers absent and text is in the prompt', () => {
  const sys = `You are a pirate.\n\nSpeak in rhymes.\n\n${BOILER}\n\nAlways sign off.`
  const r = applySystemInjection('hi', opts(sys), {}, 'persona', 'You are a pirate.\n\nSpeak in rhymes.\n\nAlways sign off.')
  assert.match(r.query, /^\[System instructions from host\]\nYou are a pirate\.\n\nSpeak in rhymes\.\n\nAlways sign off\.\n\[\/System\]\n\nhi$/)
  assert.ok(!r.query.includes('DeepSeek Harness') && !r.query.includes('exit code'))
  assert.equal(genericPersona(BOILER, 'Stale persona'), '') // not in the current prompt
  assert.equal(applySystemInjection('hi', opts(BOILER), {}, 'persona', '').query, 'hi') // default dsh: nothing
  assert.equal(applySystemInjection('hi', opts(BOILER), {}, 'persona', undefined).query, 'hi')
  assert.equal(applySystemInjection('hi', opts(sys), {}, 'off', 'You are a pirate.').query, 'hi')
})

test('generic persona: FlyBot prompts unchanged (markers win, fallback ignored)', () => {
  const fly = '# Your identity\nYou are Ann.\n## How your Bot team works\nteam rules\n# Tools\nx'
  const a = applySystemInjection('q', opts(fly), {}, 'persona')
  const b = applySystemInjection('q', opts(fly), {}, 'persona', '# Your identity\nYou are Ann.')
  assert.deepEqual(a, b)
  assert.equal(extractPersona(fly), '# Your identity\nYou are Ann.')
})

test('generic persona: hash gate, cap, full mode unaffected', () => {
  const sys = `P1\n\n${BOILER}`
  const first = applySystemInjection('q', opts(sys), { jiuwenSessionId: 's' }, 'persona', 'P1')
  assert.ok(first.hash)
  assert.equal(applySystemInjection('q', opts(sys), { jiuwenSessionId: 's', systemHash: first.hash }, 'persona', 'P1').query, 'q')
  const big = 'é'.repeat(9000)
  const r = applySystemInjection('q', opts(`${big}\n\n${BOILER}`), {}, 'persona', big)
  assert.ok(Buffer.byteLength(r.query) < 8 * 1024 + 100 && r.query.includes('[truncated]'))
  assert.ok(applySystemInjection('q', opts(sys), {}, 'full', 'P1').query.includes('DeepSeek Harness'))
})

test('persona capture: observe-only waterfall, per session, bounded, disposable', async () => {
  const handlers = []
  const ctx = { on: (n, fn) => { handlers.push([n, fn]); return () => handlers.splice(handlers.findIndex(h => h[1] === fn), 1) } }
  const cap = createPersonaCapture(ctx)
  assert.equal(handlers[0][0], 'system-prompt/assemble')
  const asm = { sections: [{ name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' }, { name: 'deployment:persona-prefix', text: ' Pirate ' }, { name: 'x', text: 'tool' }, { name: 'deployment:persona-suffix', text: '' }] }
  const out = await handlers[0][1]({}, { agent: { session: { id: 'd1' } } }, async () => asm)
  assert.equal(out, asm) // same object, untouched
  assert.equal(asm.sections[1].text, ' Pirate ')
  assert.equal(cap.get('d1'), 'Pirate')
  assert.equal(await handlers[0][1]({}, {}, async () => asm), asm) // no agent: nothing recorded, no throw
  const bad = await handlers[0][1]({}, { agent: { session: { id: 'd2' } } }, async () => null)
  assert.equal(bad, null); assert.equal(cap.get('d2'), '')
  for (let i = 0; i < 600; i++) cap.record(`s${i}`, 'x')
  assert.equal(cap.get('d1'), undefined); assert.equal(cap.get('s599'), 'x')
  cap.dispose(); assert.equal(handlers.length, 0); assert.equal(cap.get('s599'), undefined)
  assert.equal(personaFromAssembly({ sections: [{ name: 'deployment:persona-prefix', text: () => 'fn' }] }), '')
  assert.doesNotThrow(() => createPersonaCapture({}).dispose())
})

test('generic persona: interpolated {{vars}} forwarded as rendered; shipped web default skipped', () => {
  const sys = 'You are an AI agent powered by DeepSeek Harness.\n\nYou are Ada, powered by jiuwen-default.\n\nboiler'
  assert.equal(genericPersona(sys, 'You are Ada, powered by {{model}}.'), 'You are Ada, powered by jiuwen-default.')
  assert.equal(genericPersona(sys, 'You are Bob, {{model}}.'), '')
  assert.equal(personaFromAssembly({ sections: [{ name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' }] }), '')
  assert.equal(personaFromAssembly({ sections: [{ name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model. Be terse.' }] }), 'You are a coding agent powered by the {{model}} model. Be terse.')
})
