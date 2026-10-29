#!/usr/bin/env node
/**
 * Harder quality suite across paths A/B/C (same model).
 * BENCH_PATHS=A,B,C  BENCH_OUT=bench/results/hard  BENCH_CONC=3
 * Suites: gsm_hard, tools, memory, humaneval_hard, format, constraint
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
const DSH = env.DSH_BIN || 'dsh'
const PROF = { A: env.BENCH_PROFILE_A || 'headless', B: env.BENCH_PROFILE_B || 'native' }
const GW = env.JIUWEN_GATEWAY_URL || 'ws://127.0.0.1:19000/ws'
const PATHS = (env.BENCH_PATHS || 'A,B,C').split(',')
const SUITES = (env.BENCH_HARD_SUITES || 'gsm_hard,tools,memory,humaneval_hard,format,constraint').split(',')
const CONC = Number(env.BENCH_CONC || 3)
const OUT = env.BENCH_OUT || join(root, 'bench/results/hard')
const TIMEOUT = Number(env.BENCH_TIMEOUT_MS || 300_000)
mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'hard-'))

if (!env.ARK_API_KEY) {
  try {
    const m = readFileSync(join(homedir(), '.jiuwenswarm/config/.env'), 'utf8').match(/^API_KEY=(.*)$/m)
    if (m) env.ARK_API_KEY = m[1].trim().replace(/^["']|["']$/g, '')
  } catch {}
}

function runDsh(path, prompt, { sessionId, timeoutMs = TIMEOUT } = {}) {
  return new Promise(resolve => {
    const args = ['--profile', PROF[path], '--json']
    if (sessionId) args.push('--session-id', sessionId)
    args.push(prompt)
    const t0 = performance.now()
    const p = spawn(DSH, args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = '', err = '', ttft = null, text = '', final = null, sid = sessionId, usage = { inputTokens: 0, outputTokens: 0 }, reason = null
    const kill = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let e; try { e = JSON.parse(line) } catch { continue }
        if (e.type === 'session') sid = e.sessionId
        if ((e.type === 'thinking' || e.type === 'text') && ttft == null) ttft = performance.now() - t0
        if (e.type === 'text') text += e.text || ''
        if (e.type === 'final') final = e.text
        if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
          usage.inputTokens += e.usage.inputTokens || 0
          usage.outputTokens += e.usage.outputTokens || 0
        }
        if (e.type === 'status' && e.phase === 'turn_end') reason = e.reason?.kind
      }
    })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => {
      clearTimeout(kill)
      resolve({
        ok: code === 0 && reason === 'completed', code, reason, text: String(final ?? text ?? '').trim(),
        ttftMs: ttft == null ? null : Math.round(ttft), totalMs: Math.round(performance.now() - t0),
        usage, sessionId: sid, error: code === 0 ? null : err.trim().split('\n').slice(-2).join(' ').slice(0, 200),
      })
    })
  })
}

function runWs(prompt, { sessionId, timeoutMs = TIMEOUT } = {}) {
  return new Promise(resolve => {
    const sid = sessionId || `hard-${randomUUID().slice(0, 12)}`
    const u = new URL(GW); u.searchParams.set('user_id', env.JIUWEN_USER_ID || 'bench')
    if (env.JIUWEN_GATEWAY_TOKEN) u.searchParams.set('access_token', env.JIUWEN_GATEWAY_TOKEN)
    const t0 = performance.now()
    const reqId = `hard-${randomUUID()}`
    let ttft = null, text = '', final = null, usage = null, done = false, error = null
    const ws = new WebSocket(u.href)
    const end = (ok, why) => {
      if (done) return; done = true; clearTimeout(kill); try { ws.close() } catch {}
      resolve({
        ok, reason: why, text: String(final ?? text ?? '').trim(),
        ttftMs: ttft == null ? null : Math.round(ttft), totalMs: Math.round(performance.now() - t0),
        usage: usage || { inputTokens: 0, outputTokens: 0 }, sessionId: sid, error,
      })
    }
    const kill = setTimeout(() => { error = 'timeout'; end(false, 'timeout') }, timeoutMs)
    ws.onerror = e => { error = String(e.message || 'ws error'); end(false, 'error') }
    ws.onmessage = m => {
      let f; try { f = JSON.parse(m.data) } catch { return }
      const ev = String(f.event || f.payload?.event_type || '')
      const p = f.payload || {}
      if (ev === 'connection.ack') {
        ws.send(JSON.stringify({
          type: 'req', id: reqId, method: 'chat.send',
          params: { session_id: sid, content: prompt, query: prompt, mode: env.JIUWEN_CHAT_MODE || 'agent', work_mode: 'agent', user_id: u.searchParams.get('user_id'), supports_user_interaction: false },
        }))
        return
      }
      if (f.type === 'res' && f.id === reqId && f.ok === false) { error = JSON.stringify(f.error || f.payload).slice(0, 200); end(false, 'error'); return }
      if (/delta|content_chunk/.test(ev) && typeof p.content === 'string') { if (ttft == null) ttft = performance.now() - t0; text += p.content }
      else if (/reasoning/.test(ev) && typeof p.content === 'string') { if (ttft == null) ttft = performance.now() - t0 }
      else if (/final/.test(ev) && typeof p.content === 'string' && p.content) final = (final || '') + p.content
      else if (/usage_summary|usage_metadata/.test(ev)) {
        const x = p.usage || p.metadata?.usage_metadata
        if (x && (/summary/.test(ev) || !usage)) usage = { inputTokens: Number(x.input_tokens || 0), outputTokens: Number(x.output_tokens || 0) }
      } else if (/processing_status/.test(ev) && p.is_complete === true && (!p.request_id || p.request_id === reqId)) end(true, 'completed')
    }
  })
}

const run = (path, prompt, o) => path === 'C' ? runWs(prompt, o) : runDsh(path, prompt, o)
async function pool(items, n, fn) {
  const out = new Array(items.length); let k = 0
  await Promise.all(Array.from({ length: n }, async () => { while (k < items.length) { const i = k++; out[i] = await fn(items[i], i) } }))
  return out
}
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a.map(x => typeof x === 'object' ? JSON.stringify(x) : x))

function reTest(pattern, text, baseFlags = 'm') {
  let flags = baseFlags
  let pat = String(pattern)
  if (pat.startsWith('(?i)')) { flags = (flags.includes('i') ? flags : flags + 'i'); pat = pat.slice(4) }
  return new RegExp(pat, flags).test(text)
}

const brief = r => ({ ok: r.ok, totalMs: r.totalMs, ttftMs: r.ttftMs, inTok: r.usage?.inputTokens, outTok: r.usage?.outputTokens, error: r.error })

const prev = (() => { try { return JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')) } catch { return null } })()
const results = { startedAt: new Date().toISOString(), model: 'doubao-seed-2.0-mini', paths: PATHS, suites: SUITES, gsm_hard: {}, tools: {}, memory: {}, humaneval_hard: {}, format: {}, constraint: {} }
if (prev) for (const k of Object.keys(results)) if (typeof results[k] === 'object' && prev[k]) Object.assign(results[k], prev[k])
const save = () => writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2))

const numOf = s => {
  const m = String(s).replace(/,/g, '').match(/answer\s*[:：]\s*\$?\s*(-?\d+(?:\.\d+)?)/i)
  if (m) return m[1]
  const all = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g)
  return all ? all.at(-1) : null
}
const lastLine = s => String(s).trim().split(/\n/).filter(Boolean).at(-1)?.trim() || ''

async function scored(suite, P, data, idOf, fn) {
  const have = new Map((results[suite][P] || []).map(r => [r.id, r]))
  results[suite][P] = data.filter(d => have.has(idOf(d))).map(d => have.get(idOf(d)))
  const todo = data.filter(d => !have.has(idOf(d)))
  await pool(todo, CONC, async d => {
    const r = await fn(d)
    results[suite][P].push(r)
    save()
    return r
  })
}

const suite = JSON.parse(readFileSync(join(root, 'bench/data/hard-suite.json'), 'utf8'))

if (SUITES.includes('gsm_hard')) {
  const data = readFileSync(join(root, 'bench/data/gsm8k-hard-q1-seed7-n20.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  for (const P of PATHS) {
    await scored('gsm_hard', P, data, d => d.id, async q => {
      const x = await run(P, `Solve this math word problem carefully. Do not use tools. End with a final line "Answer: <number>".\n\n${q.question}`)
      const got = numOf(x.text)
      const correct = got != null && Number(got) === Number(q.answer)
      log(P, q.id, correct, got, q.answer)
      return { id: q.id, expected: q.answer, got, correct, ...brief(x), tail: x.text.slice(-160) }
    })
  }
}

if (SUITES.includes('tools')) {
  for (const P of PATHS) {
    await scored('tools', P, suite.tool_chain, d => d.id, async t => {
      const x = await run(P, t.prompt, { timeoutMs: 240_000 })
      let correct = false, got = lastLine(x.text)
      if (t.expect) correct = got === t.expect || x.text.includes(t.expect)
      if (t.expect_sha256_of) {
        const dig = createHash('sha256').update(t.expect_sha256_of).digest('hex')
        const m = x.text.match(/[0-9a-f]{64}/i)
        got = m ? m[0].toLowerCase() : got
        correct = got === dig
      }
      if (t.expect_re) correct = reTest(t.expect_re, x.text)
      log(P, t.id, correct, got)
      return { id: t.id, correct, got, ...brief(x), text: x.text.slice(0, 300) }
    })
  }
}

if (SUITES.includes('memory')) {
  for (const P of PATHS) {
    const have = new Map((results.memory[P] || []).map(r => [r.id, r]))
    results.memory[P] = suite.memory.filter(s => have.has(s.id)).map(s => have.get(s.id))
    for (const sc of suite.memory.filter(s => !have.has(s.id))) {
      let sid, turns = []
      for (const q of sc.turns) {
        const x = await run(P, q, { sessionId: sid })
        sid = x.sessionId
        turns.push({ ...brief(x), text: x.text.slice(0, 120) })
      }
      const checks = sc.checks.map(c => ({ ...c, text: turns[c.turn]?.text || '', pass: reTest(c.re, turns[c.turn]?.text || '', '') }))
      const correct = checks.every(c => c.pass)
      const r = { id: sc.id, correct, checks, turns }
      results.memory[P].push(r); save(); log(P, sc.id, correct, checks.map(c => c.pass))
    }
  }
}

function gradeHE(task, text) {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map(m => m[1])
  let code = blocks.find(b => b.includes(`def ${task.entry_point}`)) ?? blocks.at(-1) ?? text
  if (!code.includes(`def ${task.entry_point}`)) code = task.prompt + code
  const imports = task.prompt.match(/^(?:from|import) .*$/gm)?.join('\n') ?? ''
  const prog = `${imports}\n${code}\n\n${task.test}\ncheck(${task.entry_point})\n`
  const f = join(work, `he-${randomUUID().slice(0, 8)}.py`); writeFileSync(f, prog)
  const r = spawnSync('python3', [f], { timeout: 20_000, encoding: 'utf8' }); rmSync(f, { force: true })
  return { passed: r.status === 0, err: r.status === 0 ? null : (r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0]?.slice(0, 160) }
}

if (SUITES.includes('humaneval_hard')) {
  const data = readFileSync(join(root, 'bench/data/humaneval-hard-seed11-n10.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  for (const P of PATHS) {
    await scored('humaneval_hard', P, data, d => d.task_id, async t => {
      const x = await run(P, `Complete the following Python function. Reply with the complete function in a single \`\`\`python code block. Do not write files or run tools.\n\n\`\`\`python\n${t.prompt}\`\`\``, { timeoutMs: 240_000 })
      const g = gradeHE(t, x.text)
      log(P, t.task_id, g.passed, g.err || '')
      return { id: t.task_id, ...g, ...brief(x) }
    })
  }
}

if (SUITES.includes('format')) {
  for (const P of PATHS) {
    await scored('format', P, suite.format, d => d.id, async t => {
      const x = await run(P, t.prompt)
      let correct = false, note = ''
      const body = x.text.trim()
      if (t.expect) correct = body === t.expect
      if (t.expect_re) correct = reTest(t.expect_re, body)
      if (t.expect_json) {
        try {
          const j = JSON.parse(body.replace(/^```(?:json)?\s*|\s*```$/g, ''))
          correct = JSON.stringify(j) === JSON.stringify(t.expect_json)
        } catch (e) { note = 'json-parse-fail' }
      }
      log(P, t.id, correct, note)
      return { id: t.id, correct, note, ...brief(x), text: body.slice(0, 240) }
    })
  }
}

if (SUITES.includes('constraint')) {
  for (const P of PATHS) {
    await scored('constraint', P, suite.constraint, d => d.id, async t => {
      const x = await run(P, t.prompt)
      const body = x.text.trim()
      let correct = true
      if (t.expect_re) correct = correct && reTest(t.expect_re, body)
      if (t.forbid_re) correct = correct && !reTest(t.forbid_re, body, '')
      if (t.expect_json) {
        try { correct = JSON.stringify(JSON.parse(body.replace(/^```(?:json)?\s*|\s*```$/g, ''))) === JSON.stringify(t.expect_json) }
        catch { correct = false }
      }
      if (t.expect_cjk_min) correct = correct && ((body.match(/[\u4e00-\u9fff]/g) || []).length >= t.expect_cjk_min)
      log(P, t.id, correct)
      return { id: t.id, correct, ...brief(x), text: body.slice(0, 240) }
    })
  }
}

results.finishedAt = new Date().toISOString()
const score = {}
for (const P of PATHS) {
  const parts = {}
  for (const s of ['gsm_hard', 'tools', 'memory', 'humaneval_hard', 'format', 'constraint']) {
    const rows = results[s][P] || []
    const key = s === 'humaneval_hard' ? 'passed' : 'correct'
    parts[s] = { n: rows.length, pass: rows.filter(r => r[key]).length, fails: rows.filter(r => !r[key]).map(r => r.id) }
  }
  const totalN = Object.values(parts).reduce((a, b) => a + b.n, 0)
  const totalP = Object.values(parts).reduce((a, b) => a + b.pass, 0)
  score[P] = { total: `${totalP}/${totalN}`, parts }
}
results.score = score
save()
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ finishedAt: results.finishedAt, score, model: results.model }, null, 2))
rmSync(work, { recursive: true, force: true })
log('done', score)
