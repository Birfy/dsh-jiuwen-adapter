#!/usr/bin/env node
// Opt-in plain-dsh plugin compatibility matrix (`npm run test:plain-dsh`): real dsh web profiles, no FlyBot.
// Profiles: pref (dsh-base + dsh-web-app + driver), pjw (+ adapter last), pjwfirst (adapter first).
// (a) non-jiuwen sessions produce the same normalized events / fork / schedules / skills / preset in all three;
// (b) jiuwen sessions pass every read-back check (title, workdir, schedule, permissions, fork, plan, goal, dispose/archive, skills);
// (c) no errors, no unhandled rejections, in both load orders.
//   JIUWEN_LIVE=1, DSH_BIN=<dsh binary>; JW_USE_STANDIN_CMD / JW_RESTORE_CMD as in run.mjs (Jiuwen must answer via the stand-in).
//   PLAIN_DSH_PORT (default 3471). Jiuwen state is snapshotted and restored exactly.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, GATEWAY, STANDIN_LOG, STANDIN_PORT, gatewayUp, skip, startStandin, sh, sleep, waitGateway, snapshot, restore } from './lib.mjs'

const nested = process.env.JIUWEN_LIVE_NESTED === '1'
if (process.env.JIUWEN_LIVE !== '1') skip('set JIUWEN_LIVE=1')
const BIN = process.env.DSH_BIN
if (!BIN || !existsSync(BIN)) skip('set DSH_BIN to a dsh binary')
if (!(await gatewayUp())) skip(`Gateway offline at ${GATEWAY}`)
if (!nested && !process.env.JW_USE_STANDIN_CMD) skip('set JW_USE_STANDIN_CMD / JW_RESTORE_CMD (Jiuwen must answer via the stand-in)')
const PORT = Number(process.env.PLAIN_DSH_PORT || 3471)
const HOME = mkdtempSync(join(tmpdir(), 'plain-dsh-'))
const DRIVER = join(ROOT, 'test/live/plain-dsh/driver')
const BUNDLES = { pref: ['@plain/driver'], pjw: ['@dsh-jiuwen/adapter', '@plain/driver'], pjwfirst: ['@dsh-jiuwen/adapter', '@plain/driver'] }
// memory-module profiles: the same three plus the opt-in session-search bundle (agent-instructions, session-query-sqlite and session-reference are already in dsh-base / dsh-web-app)
const MEM = '@deepseek-ai/dsh-experimental-session-search'
for (const k of Object.keys(BUNDLES)) BUNDLES[`mem-${k}`] = BUNDLES[k]
const PATCH = `- id: llm-pi-ai
  config:
    providers:
      standin:
        api: openai-completions
        baseURL: http://127.0.0.1:${STANDIN_PORT}/v1
        apiKeyEnv: STANDIN_API_KEY
        displayName: Stand-in
        models:
          - id: standin-m1
- id: agent-default-model
  config:
    provider: standin
    model: standin-m1
- id: system-prompt
  config:
    personaPrefix: You are Plain-Probe, powered by {{model}}. Answer briefly.
`
function profile(name) {
  const dir = join(HOME, '.dsh/profiles', name); mkdirSync(join(dir, 'node_modules/@plain'), { recursive: true })
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const plain = name.replace(/^mem-/, '')
  const extra = name.startsWith('mem-') ? [MEM] : []
  const bundles = plain === 'pjwfirst' ? ['@dsh-jiuwen/adapter', ...base, ...extra, '@plain/driver'] : [...base, ...extra, ...BUNDLES[name]]
  const deps = { '@plain/driver': `link:${DRIVER}`, ...(name.endsWith('pref') ? {} : { '@dsh-jiuwen/adapter': `link:${ROOT}` }) }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: deps, dsh: { profile: { bundles } } }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n'); writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
  symlinkSync(DRIVER, join(dir, 'node_modules/@plain/driver'))
  if (!name.endsWith('pref')) { mkdirSync(join(dir, 'node_modules/@dsh-jiuwen'), { recursive: true }); symlinkSync(ROOT, join(dir, 'node_modules/@dsh-jiuwen/adapter')) }
}
const SKILL = '---\nname: plain-probe-skill\ndescription: plain dsh probe skill\n---\nMARKSKILLBODY plain probe.\n'
for (const d of ['.agents/skills/plain-probe-skill', '.dsh/skills/plain-probe-skill']) { mkdirSync(join(HOME, d), { recursive: true }); writeFileSync(join(HOME, d, 'SKILL.md'), SKILL) }
mkdirSync(join(HOME, 'sandbox'))
writeFileSync(join(HOME, 'sandbox/AGENTS.md'), '# Project notes\nMARKAGENTSMD: this workspace is the plain-dsh memory probe.\n')
for (const p of Object.keys(BUNDLES)) profile(p)

async function run(name, mode) {
  const out = join(HOME, `out-${name}-${mode}.json`)
  // selectModel persists the default model; reset the patch before every run
  writeFileSync(join(HOME, '.dsh/profiles', name, 'cordis.patch.yml'), PATCH)
  const env = { ...process.env, HOME, STANDIN_API_KEY: 'standin-no-secret', STANDIN_LOG, DRIVER_OUT: out, DRIVER_MODE: mode, DRIVER_CWD: join(HOME, 'sandbox') }
  delete env.DSH_HOME
  const p = spawn(BIN, ['--profile', name, '--host', '127.0.0.1', '--port', String(PORT), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let log = ''; p.stdout.on('data', d => { log += d }); p.stderr.on('data', d => { log += d })
  let exited = false; p.on('exit', () => { exited = true })
  for (let i = 0; i < 240 && !existsSync(out) && !exited; i++) await sleep(1000)
  await sleep(1000); try { process.kill(-p.pid, 'SIGINT') } catch {}
  await sleep(3000); try { process.kill(-p.pid, 'SIGKILL') } catch {}
  if (!existsSync(out)) return { err: 'no driver output', log: log.slice(-1500) }
  return { ...JSON.parse(readFileSync(out, 'utf8')), log }
}

const results = []
// Memory-module plugins: dsh-agent-instructions (AGENTS.md), dsh-session-reference (dsh-session:<id>), dsh-experimental-session-search.
function memoryChecks(M) {
  const has = (a, m) => (a || []).includes(m)
  for (const [k, o] of Object.entries(M)) {
    check(`mem ${k}: driver ran, no errors`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify(o.errors))
    const p = o.mem?.p || {}
    check(`mem ${k} non-jiuwen: AGENTS.md reaches the model`, p.src?.agentsMd === true)
    check(`mem ${k} non-jiuwen: session reference snapshot reaches the model`, has(p.ref?.allMarks, 'MARKREFSRCP') && !!p.ref?.reply, JSON.stringify(p.ref))
    check(`mem ${k} non-jiuwen: session_search finds the earlier session`, /Session search results \(\d+\)/.test(p.search?.reply || ''), JSON.stringify(p.search).slice(0, 300))
    const j = o.mem?.j
    if (!j) continue
    check(`mem ${k} jiuwen: AGENTS.md reaches Jiuwen`, j.src?.agentsMd === true)
    check(`mem ${k} jiuwen: session reference snapshot reaches Jiuwen`, has(j.ref?.marks, 'MARKREFSRCJ') && /stand-in reply jref/.test(j.ref?.reply || ''), JSON.stringify(j.ref).slice(0, 300))
    check(`mem ${k} jiuwen: next turn does not resend AGENTS.md / reference (Jiuwen keeps history)`, !has(j.ref2?.marks, 'MARKREFSRCJ') && !has(j.ref2?.marks, 'MARKAGENTSMD') && has(j.ref2?.allMarks, 'MARKREFSRCJ'), JSON.stringify(j.ref2))
    check(`mem ${k} jiuwen: session_search via dsh-tools MCP finds the earlier session (no approval prompt)`, /Session search results/.test(j.search?.reply || '') && /zebra-j|MARKREFSRCJ/.test(j.search?.reply || '') && j.search?.ms < 30000, JSON.stringify(j.search).slice(0, 400))
    check(`mem ${k} jiuwen: no clash with Jiuwen memory (own memory tools + prefixed dsh tools)`, (j.search?.toolNames || []).some(n => /memory/.test(n)) && (j.search?.toolNames || []).every(n => !/^session_search$/.test(n)), JSON.stringify(j.search?.toolNames))
  }
  const sig = o => JSON.stringify([o.mem?.p?.src?.agentsMd, !!o.mem?.p?.ref?.reply, /Session search results/.test(o.mem?.p?.search?.reply || '')])
  if (M.ref && M.last && M.first) check('mem (a) non-jiuwen results identical without / with adapter, both load orders', sig(M.ref) === sig(M.last) && sig(M.ref) === sig(M.first))
}
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + String(detail).slice(0, 300) : ''}`) }
const snap = nested ? null : await snapshot()
const standin = nested ? { stop() {} } : await startStandin()
try {
  if (!nested) { sh(process.env.JW_USE_STANDIN_CMD); if (!(await waitGateway())) throw new Error('Gateway did not come back') }
  const ONLY = process.env.PLAIN_DSH_ONLY || 'all'
  const R = ONLY === 'mem' ? {} : { pref: await run('pref', 'plain'), pjwPlain: await run('pjw', 'plain'), pjwfirstPlain: await run('pjwfirst', 'plain'), pjw: await run('pjw', 'jw'), pjwfirst: await run('pjwfirst', 'jw') }
  if (ONLY !== 'mem') {
  const RAW_IDS = new Set(['id', 'fork']) // raw dsh session ids (random per run); the normalized events carry the rest
  const cmp = o => Object.fromEntries(Object.entries(o.plain || {}).filter(([k]) => !RAW_IDS.has(k)))
  const key = o => JSON.stringify(cmp(o))
  const why = (a, b) => Object.keys({ ...cmp(a), ...cmp(b) }).filter(k => JSON.stringify(cmp(a)[k]) !== JSON.stringify(cmp(b)[k])).map(k => `${k}: ${JSON.stringify(a.plain?.[k]).slice(0, 200)} ≠ ${JSON.stringify(b.plain?.[k]).slice(0, 200)}`).join(' | ')
  if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP, JSON.stringify(R))
  for (const [k, o] of Object.entries(R)) check(`${k}: driver ran, no errors / unhandled rejections`, !o.err && !(o.errors || []).length && !(o.unhandled || []).length, o.err ? o.log : JSON.stringify([o.errors, o.unhandled]))
  check('(a) non-jiuwen session identical without / with adapter (adapter last)', key(R.pref) === key(R.pjwPlain), why(R.pref, R.pjwPlain))
  check('(a) non-jiuwen session identical without / with adapter (adapter first)', key(R.pref) === key(R.pjwfirstPlain), why(R.pref, R.pjwfirstPlain))
  for (const k of ['pjw', 'pjwfirst']) {
    const jw = R[k].jw || []
    check(`(b) ${k}: all Jiuwen read-back checks pass (${jw.filter(x => String(x).startsWith('PASS')).length}/${jw.length})`, jw.length >= 16 && jw.every(x => String(x).startsWith('PASS')), jw.filter(x => !String(x).startsWith('PASS')).join(' | '))
    for (const line of jw) console.log(`      ${line}`.slice(0, 160))
  }
  check('(c) same jiuwen results in both load orders', JSON.stringify((R.pjw.jw || []).map(x => String(x).split(' — ')[0])) === JSON.stringify((R.pjwfirst.jw || []).map(x => String(x).split(' — ')[0])))
  check('(c) listeners: the adapter adds at most one process exit listener', ['pjw', 'pjwfirst'].every(k => { const n = s => Number((String(R[k][s] || '').match(/exit:(\d+)/) || [])[1] || 0); return n('listeners1') - n('listeners0') <= 1 }))
  }
  if (ONLY !== 'plain') {
    const M = process.env.PLAIN_DSH_MEM_QUICK ? { last: await run('mem-pjw', 'mem') } : { ref: await run('mem-pref', 'mem'), last: await run('mem-pjw', 'mem'), first: await run('mem-pjwfirst', 'mem') }
    if (process.env.PLAIN_DSH_KEEP) writeFileSync(process.env.PLAIN_DSH_KEEP + '.mem.json', JSON.stringify(M))
    memoryChecks(M)
  }
} finally {
  if (!nested) { sh(process.env.JW_RESTORE_CMD); await waitGateway() }
  standin.stop()
  if (snap) { const diff = await restore(snap); check('Jiuwen state restored exactly', diff.length === 0, diff.join(',')) }
  rmSync(HOME, { recursive: true, force: true })
}
console.log(`\nplain-dsh: ${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
