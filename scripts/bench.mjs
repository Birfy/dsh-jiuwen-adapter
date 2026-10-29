#!/usr/bin/env node
/**
 * Performance & quality benchmark: three paths, one model.
 *   A  dsh (headless --json) + this adapter (gateway mode) -> JiuwenSwarm gateway
 *   B  dsh (headless --json) with its native OpenAI-compatible provider (dsh-llm-pi-ai) -> model endpoint
 *   C  JiuwenSwarm gateway WebSocket directly (no dsh)
 *
 *   A0 same as A with the adapter's terminal-final early end and post-cancel settle disabled
 * Env:
 *   DSH_BIN (default: dsh on PATH), DSH_HOME, BENCH_PROFILE_A (headless), BENCH_PROFILE_B (native)
 *   JIUWEN_GATEWAY_URL (ws://127.0.0.1:19000/ws), JIUWEN_USER_ID (bench)
 *   BENCH_PATHS=A,B,C  BENCH_SUITES=perf,gsm8k,humaneval,ux  BENCH_CONC=3  BENCH_REPS=5
 *   BENCH_OUT=bench/results
 * Path B needs the model key in the launch env under the name its profile references
 * (ARK_API_KEY by default); if unset it is read from ~/.jiuwenswarm/config/.env API_KEY. Never printed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = process.env
const DSH = env.DSH_BIN || 'dsh'
const PROF = { A: env.BENCH_PROFILE_A || 'headless', A0: env.BENCH_PROFILE_A || 'headless', B: env.BENCH_PROFILE_B || 'native' }
// A0 = path A with this adapter's latency/cancel fixes switched off (before/after comparison).
const PATH_ENV = { A0: { JIUWEN_TERMINAL_FINAL_GRACE_MS: '-1', JIUWEN_POST_CANCEL_SETTLE_MS: '0' } }
const GW = env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
const PATHS = (env.BENCH_PATHS || 'A,B,C').split(',')
const SUITES = (env.BENCH_SUITES || 'perf,gsm8k,humaneval,ux').split(',')
const CONC = Number(env.BENCH_CONC || 3)
const REPS = Number(env.BENCH_REPS || 5)
const OUT = env.BENCH_OUT || join(root, 'bench/results')
const TIMEOUT = Number(env.BENCH_TIMEOUT_MS || 300_000)
mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'bench-work-'))

if (!env.ARK_API_KEY) {
  try {
    const m = readFileSync(join(homedir(), '.jiuwenswarm/config/.env'), 'utf8').match(/^API_KEY=(.*)$/m)
    if (m) env.ARK_API_KEY = m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* path B will fail with MISSING_CREDENTIAL */ }
}

// ---------- runners: each returns {ok, text, ttftMs, totalMs, usage, error, sessionId, events} ----------
function runDsh(path, prompt, { sessionId, cancelAtMs, timeoutMs = TIMEOUT } = {}) {
  return new Promise(resolve => {
    const args = ['--profile', PROF[path], '--json']
    if (sessionId) args.push('--session-id', sessionId)
    args.push(prompt)
    const traceFile = path.startsWith('A') ? join(work, `trace-${randomUUID().slice(0, 8)}.jsonl`) : null
    const wall0 = Date.now(), t0 = performance.now()
    const p = spawn(DSH, args, { cwd: work, env: { ...env, ...(PATH_ENV[path] || {}), ...(traceFile ? { JIUWEN_TRACE_FILE: traceFile } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    if (cancelAtMs != null) setTimeout(() => { cancelAt = performance.now(); p.kill('SIGINT') }, cancelAtMs)
    let buf = '', err = '', ttft = null, text = '', final = null, sid = sessionId, usage = { inputTokens: 0, outputTokens: 0 }, steps = 0, reason = null, cancelAt = null, thinking = ''
    const kill = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let e; try { e = JSON.parse(line) } catch { continue }
        if (e.type === 'session') sid = e.sessionId
        if ((e.type === 'thinking' || e.type === 'text') && ttft == null) {
          ttft = performance.now() - t0
        }
        if (e.type === 'thinking') thinking += e.text || ''
        if (e.type === 'text') text += e.text || ''
        if (e.type === 'final') final = e.text
        if (e.type === 'status' && e.phase === 'step_end') { steps++; if (e.usage) { usage.inputTokens += e.usage.inputTokens || 0; usage.outputTokens += e.usage.outputTokens || 0 } }
        if (e.type === 'status' && e.phase === 'turn_end') reason = e.reason?.kind
      }
    })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => {
      clearTimeout(kill)
      const t1 = performance.now()
      // Path A: adapter trace gives token-level timing inside the dsh process.
      let startupMs = null, tokenTtftMs = null
      if (traceFile && existsSync(traceFile)) {
        const recs = readFileSync(traceFile, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        rmSync(traceFile, { force: true })
        const ts = recs.find(r => r.at === 'turn-start' && !r.purpose), fe = recs.find(r => r.at === 'event' && /reasoning|text|tool_call/.test(r.type || ''))
        if (ts) startupMs = Date.parse(ts.t) - wall0
        if (fe) tokenTtftMs = Date.parse(fe.t) - wall0
      }
      resolve({
        ok: code === 0 && reason === 'completed', code, reason, text: final ?? text, thinking,
        ttftMs: ttft, startupMs, tokenTtftMs, totalMs: t1 - t0, cancelMs: cancelAt ? t1 - cancelAt : null,
        usage, steps, sessionId: sid, error: code === 0 ? null : err.trim().split('\n').slice(-2).join(' ').slice(0, 300),
      })
    })
  })
}

function runWs(prompt, { sessionId, cancelAtMs, timeoutMs = TIMEOUT } = {}) {
  return new Promise(resolve => {
    const sid = sessionId || `bench-${randomUUID().slice(0, 12)}`
    const u = new URL(GW); u.searchParams.set('user_id', env.JIUWEN_USER_ID || 'bench')
    if (env.JIUWEN_GATEWAY_TOKEN) u.searchParams.set('access_token', env.JIUWEN_GATEWAY_TOKEN)
    const t0 = performance.now()
    const reqId = `bench-${randomUUID()}`
    let ttft = null, text = '', final = null, reasoning = '', usage = null, done = false, cancelAt = null, tools = 0, error = null
    const ws = new WebSocket(u.href)
    const end = (ok, why) => {
      if (done) return; done = true; clearTimeout(kill); try { ws.close() } catch {}
      const t1 = performance.now()
      resolve({ ok, reason: why, text: final ?? text, thinking: reasoning, ttftMs: ttft, tokenTtftMs: ttft, startupMs: 0, totalMs: t1 - t0, cancelMs: cancelAt ? t1 - cancelAt : null,
        usage: usage || { inputTokens: 0, outputTokens: 0 }, tools, sessionId: sid, error })
    }
    const kill = setTimeout(() => { error = 'timeout'; end(false, 'timeout') }, timeoutMs)
    ws.onerror = e => { error = String(e.message || 'ws error'); end(false, 'error') }
    ws.onmessage = m => {
      let f; try { f = JSON.parse(m.data) } catch { return }
      const ev = String(f.event || f.payload?.event_type || '')
      const p = f.payload || {}
      if (ev === 'connection.ack') {
        if (cancelAtMs != null) setTimeout(() => {
          if (done) return
          cancelAt = performance.now()
          ws.send(JSON.stringify({ type: 'req', id: `cancel-${randomUUID()}`, method: 'chat.interrupt', params: { session_id: sid, intent: 'cancel', request_id: reqId } }))
        }, cancelAtMs)
        ws.send(JSON.stringify({ type: 'req', id: reqId, method: 'chat.send', params: { session_id: sid, content: prompt, query: prompt, mode: env.JIUWEN_CHAT_MODE || 'agent', work_mode: 'agent', user_id: u.searchParams.get('user_id'), supports_user_interaction: false } }))
        return
      }
      if (f.type === 'res' && f.id === reqId && f.ok === false) { error = JSON.stringify(f.error || f.payload).slice(0, 300); end(false, 'error'); return }
      const first = () => {
        if (ttft != null) return
        ttft = performance.now() - t0
      }
      if (/delta|content_chunk/.test(ev) && typeof p.content === 'string') { first(); text += p.content }
      else if (/reasoning/.test(ev) && typeof p.content === 'string') { first(); reasoning += p.content }
      else if (/final/.test(ev) && typeof p.content === 'string' && p.content) { final = (final || '') + p.content }
      else if (/tool_call/.test(ev)) tools++
      else if (/usage_summary|usage_metadata/.test(ev)) {
        const x = p.usage || p.metadata?.usage_metadata
        if (x && (/summary/.test(ev) || !usage)) usage = { inputTokens: Number(x.input_tokens || 0), outputTokens: Number(x.output_tokens || 0) }
      } else if (/interrupt_result/.test(ev) && cancelAt) end(true, 'aborted')
      else if (/processing_status/.test(ev) && p.is_complete === true && (!p.request_id || p.request_id === reqId)) end(true, cancelAt ? 'aborted' : 'completed')
    }
  })
}

const run = (path, prompt, o) => path === 'C' ? runWs(prompt, o) : runDsh(path, prompt, o)

async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i) } }))
  return out
}

const tps = r => r.usage?.outputTokens && r.totalMs ? +(r.usage.outputTokens / ((r.totalMs - (r.ttftMs || 0)) / 1000 || 1)).toFixed(1) : null
const brief = r => ({ ok: r.ok, reason: r.reason, totalMs: Math.round(r.totalMs), ttftMs: r.ttftMs == null ? null : Math.round(r.ttftMs), tokenTtftMs: r.tokenTtftMs ?? null, startupMs: r.startupMs ?? null, cancelMs: r.cancelMs == null ? null : Math.round(r.cancelMs), inTok: r.usage?.inputTokens, outTok: r.usage?.outputTokens, tokPerS: tps(r), error: r.error })
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a.map(x => typeof x === 'object' ? JSON.stringify(x) : x))
const cjk = s => (s.match(/[\u4e00-\u9fff]/g) || []).length
const leaks = s => /processing_status|is_processing|chat\.delta|\[jiuwen-|connection\.ack/.test(s)
const dup = s => { const t = s.trim(); if (t.length < 40) return false; const h = Math.floor(t.length / 2); return t.slice(0, h).trim() === t.slice(h).trim() }

const prev = (() => { try { return JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')) } catch { return null } })()
const results = { startedAt: new Date().toISOString(), model: 'doubao-seed-2.0-mini (Volcengine Ark coding/v3)', paths: PATHS, conc: CONC, reps: REPS, perf: {}, gsm8k: {}, humaneval: {}, ux: {} }
const save = () => writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))
// Resumable: quality items already scored in OUT/results.json are kept and skipped.
if (prev) for (const k of ['gsm8k', 'humaneval']) Object.assign(results[k], prev[k] || {})
for (const k of ['perf', 'ux']) if (prev?.[k]) Object.assign(results[k], prev[k])
async function scored(suite, P, data, fn) {
  const have = new Map((results[suite][P] || []).map(r => [r.id, r]))
  results[suite][P] = data.filter(d => have.has(d.id ?? d.task_id)).map(d => have.get(d.id ?? d.task_id))
  await pool(data.filter(d => !have.has(d.id ?? d.task_id)), CONC, async d => { const r = await fn(d); results[suite][P].push(r); save() })
}

// ---------- perf ----------
if (SUITES.includes('perf')) for (const P of PATHS.filter(p => !results.perf[p]?.concurrent)) {
  const r = results.perf[P] = { single: [], multiturn: [], cancel: [], concurrent: null }
  for (let i = 0; i < REPS; i++) {
    const x = await run(P, 'Reply with exactly: pong'); r.single.push({ ...brief(x), text: x.text.slice(0, 60) }); log(P, 'single', brief(x))
  }
  for (let i = 0; i < 3; i++) {
    let sid, turns = []
    const qs = ['My favourite number is 17. Reply with just OK.', 'Add 5 to my favourite number. Reply with just the number.', 'Multiply that by 2. Reply with just the number.', 'What was my original favourite number? Reply with just the number.']
    for (const q of qs) { const x = await run(P, q, { sessionId: sid }); sid = x.sessionId; turns.push({ ...brief(x), text: x.text.slice(0, 40) }) }
    const ok = /\b17\b/.test(turns[3].text) && /\b22\b/.test(turns[1].text) && /\b44\b/.test(turns[2].text)
    r.multiturn.push({ ok, turns }); log(P, 'multiturn', ok, turns.map(t => `${t.totalMs}ms/${t.inTok}in`).join(' '))
  }
  for (let i = 0; i < 3; i++) {
    const x = await run(P, 'Write a 1500-word essay about the history of tea.', { cancelAtMs: 8000 })
    const y = await run(P, 'Reply with exactly: after-cancel-ok', { sessionId: x.sessionId, timeoutMs: 90_000 })
    r.cancel.push({ cancel: brief(x), continued: { ...brief(y), ok: /after-cancel-ok/i.test(y.text) } }); log(P, 'cancel', x.cancelMs, y.ok)
  }
  const t0 = performance.now()
  const xs = await Promise.all(Array.from({ length: 5 }, (_, i) => run(P, `Reply with exactly: pong-${i}`)))
  r.concurrent = { n: 5, wallMs: Math.round(performance.now() - t0), runs: xs.map((x, i) => ({ ...brief(x), correct: x.text.includes(`pong-${i}`) })) }
  log(P, 'concurrent', r.concurrent.wallMs, xs.map(x => x.ok)); save()
}

// ---------- GSM8K ----------
const numOf = s => { const m = String(s).replace(/,/g, '').match(/answer\s*[:：]\s*\$?\s*(-?\d+(?:\.\d+)?)/i); if (m) return m[1]; const all = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g); return all ? all.at(-1) : null }
if (SUITES.includes('gsm8k')) {
  const data = readFileSync(join(root, process.env.BENCH_GSM_FILE || 'bench/data/gsm8k-test-seed42-n30.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  for (const P of PATHS) {
    await scored('gsm8k', P, data, async q => {
      const x = await run(P, `Solve this math word problem. Think briefly, do not use any tools, and end with a final line in the form "Answer: <number>".\n\n${q.question}`)
      const got = numOf(x.text); const correct = got != null && Number(got) === Number(q.answer)
      log(P, q.id, correct, got, q.answer)
      return { id: q.id, expected: q.answer, got, correct, ...brief(x), tail: x.text.slice(-120) }
    })
  }
}

// ---------- HumanEval ----------
function gradeHE(task, text) {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map(m => m[1])
  let code = blocks.find(b => b.includes(`def ${task.entry_point}`)) ?? blocks.at(-1) ?? text
  if (!code.includes(`def ${task.entry_point}`)) code = task.prompt + code
  const prog = `${task.prompt.match(/^(?:from|import) .*$/gm)?.join('\n') ?? ''}\n${code}\n\n${task.test}\ncheck(${task.entry_point})\n`
  const f = join(work, `he-${randomUUID().slice(0, 8)}.py`); writeFileSync(f, prog)
  const r = spawnSync('python3', [f], { timeout: 15_000, encoding: 'utf8' }); rmSync(f, { force: true })
  return { passed: r.status === 0, err: r.status === 0 ? null : (r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0]?.slice(0, 160) }
}
if (SUITES.includes('humaneval')) {
  const data = readFileSync(join(root, 'bench/data/humaneval-seed42-n20.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  for (const P of PATHS) {
    await scored('humaneval', P, data, async t => {
      const x = await run(P, `Complete the following Python function. Reply with the complete function (including the signature and any imports) in a single \`\`\`python code block. Do not write files or run tools.\n\n\`\`\`python\n${t.prompt}\`\`\``)
      const g = gradeHE(t, x.text); log(P, t.task_id, g.passed, g.err || '')
      return { id: t.task_id, ...g, ...brief(x) }
    })
  }
}

// ---------- UX checks ----------
if (SUITES.includes('ux')) for (const P of PATHS.filter(p => !results.ux[p]?.length || results.ux[p].length < 6)) {
  const u = results.ux[P] = []
  const add = (name, x, ok, note = '') => { u.push({ name, ok, note, leak: leaks(x.text), dup: dup(x.text), ...brief(x), text: x.text.slice(0, 200) }); log(P, name, ok, note) }
  let x = await run(P, '用中文简要介绍一下长城，两三句话即可。')
  add('lang-zh', x, x.ok && cjk(x.text) > 15, `cjk=${cjk(x.text)}`)
  x = await run(P, 'In English, describe the Great Wall of China in two sentences.')
  add('lang-en', x, x.ok && cjk(x.text) === 0, `cjk=${cjk(x.text)} thinkingCjk=${cjk(x.thinking)}`)
  x = await run(P, 'Use your shell/bash tool to run: echo $((123*457)) — then reply with only the exact output.')
  add('tool-bash', x, x.ok && /56211/.test(x.text))
  x = await run(P, 'Create a file named bench_note.txt in the current directory containing the word "zebra", then read it back with a tool and reply with its exact contents.')
  add('tool-file', x, x.ok && /zebra/i.test(x.text))
  x = await run(P, 'Who are you, and which company/backend model powers you? One sentence.')
  add('identity', x, x.ok, 'manual review')
  x = await run(P, 'Return ONLY a JSON object {"a":1,"b":[2,3]} with no code fence and no other text.')
  let j = false; try { j = JSON.stringify(JSON.parse(x.text.trim())) === '{"a":1,"b":[2,3]}' } catch {}
  add('exact-json', x, x.ok && j)
  save()
}

results.finishedAt = new Date().toISOString(); save()
// CSV of every run
const rows = [['suite', 'path', 'id', 'ok', 'correct', 'totalMs', 'ttftMs', 'cancelMs', 'inTok', 'outTok', 'tokPerS', 'error']]
for (const P of PATHS) {
  const pf = results.perf[P]
  if (pf) {
    pf.single.forEach((r, i) => rows.push(['perf-single', P, i, r.ok, '', r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error]))
    pf.multiturn.forEach((m, i) => m.turns.forEach((r, t) => rows.push(['perf-multiturn', P, `${i}.t${t + 1}`, r.ok, m.ok, r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error])))
    pf.cancel.forEach((c, i) => rows.push(['perf-cancel', P, i, c.cancel.ok, c.continued.ok, c.cancel.totalMs, c.cancel.ttftMs, c.cancel.cancelMs, c.cancel.inTok, c.cancel.outTok, '', c.cancel.error]))
    pf.concurrent?.runs.forEach((r, i) => rows.push(['perf-concurrent', P, i, r.ok, r.correct, r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error]))
  }
  ;(results.gsm8k[P] || []).forEach(r => rows.push(['gsm8k', P, r.id, r.ok, r.correct, r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error]))
  ;(results.humaneval[P] || []).forEach(r => rows.push(['humaneval', P, r.id, r.ok, r.passed, r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error || r.err]))
  ;(results.ux[P] || []).forEach(r => rows.push(['ux', P, r.name, r.ok, r.ok, r.totalMs, r.ttftMs, '', r.inTok, r.outTok, r.tokPerS, r.error]))
}
writeFileSync(join(OUT, 'runs.csv'), rows.map(r => r.map(v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n')
rmSync(work, { recursive: true, force: true })
log('done ->', OUT)
