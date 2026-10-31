#!/usr/bin/env node
// Opt-in live suite (`npm run test:live`). Needs a real JiuwenSwarm; skips cleanly otherwise.
//   JIUWEN_LIVE=1                       required (guard against touching a real Jiuwen by accident)
//   JIUWEN_GATEWAY_URL                  default ws://127.0.0.1:19000/ws
//   JW_USE_STANDIN_CMD / JW_RESTORE_CMD  shell commands that point Jiuwen's model at the stand-in and back
//                                        (without them only the model-independent smoke runs)
//   DSH_NM                              dsh node_modules → also runs compat-runtime --sync --sync2 --reload
//   GW_KILL / GW_START                  commands to kill/start the Gateway → also runs live-drop-recovery
//   DSH_BIN                             dsh binary → also runs the plain-dsh profile matrix (plain-dsh.mjs)
//   LIVE_SMOKE=1                        also run live-gateway-smoke against Jiuwen's real model
//   LEAK_TURNS                          default 200
// Jiuwen state (config bytes, sessions, heartbeat, permissions, skills, MCP, jobs) is snapshotted first and
// restored exactly at the end; the run fails if anything differs.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, GATEWAY, STANDIN_LOG, gatewayUp, skip, startStandin, sh, waitGateway, snapshot, restore } from './lib.mjs'

if (process.env.JIUWEN_LIVE !== '1') skip('set JIUWEN_LIVE=1 to run the live suite against a real JiuwenSwarm')
if (!(await gatewayUp())) skip(`Gateway offline at ${GATEWAY}`)
const results = []
const step = (name, args, env = {}) => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, JIUWEN_GATEWAY_URL: GATEWAY, STANDIN_LOG, ...env }, encoding: 'utf8', timeout: 900_000, maxBuffer: 64e6 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  const fails = [...out.split('\n').filter(l => /^\s*FAIL\b/.test(l)), ...(out.match(/"FAIL [^"]*/g) || []).map(x => x.slice(1))]
  const ok = r.status === 0 && fails.length === 0 && !/^SKIP/m.test(out.slice(0, 200))
  results.push([name, ok, ((Date.now() - t0) / 1000).toFixed(0) + 's', fails.slice(0, 5)])
  console.log(`${ok ? 'PASS' : /^SKIP/m.test(out) ? 'SKIP' : 'FAIL'}  ${name}${fails.length ? '\n   ' + fails.join('\n   ') : ''}`)
}

const snap = await snapshot()
const standin = await startStandin()
const useStandin = !!process.env.JW_USE_STANDIN_CMD
try {
  // live-gateway-smoke asks natural-language questions (memory, tool use): it needs Jiuwen's real model.
  if (process.env.LIVE_SMOKE === '1') step('live-gateway-smoke (real model)', ['scripts/live-gateway-smoke.mjs'])
  else console.log('SKIP live-gateway-smoke (needs a working real model; set LIVE_SMOKE=1)')
  if (useStandin) {
    sh(process.env.JW_USE_STANDIN_CMD); if (!(await waitGateway())) throw new Error('Gateway did not come back on the stand-in')
    step('live-deep (A–M, L leak)', ['--expose-gc', 'scripts/live-deep.mjs'], { LEAK_TURNS: process.env.LEAK_TURNS || '200' })
    if (process.env.DSH_NM) step('compat-runtime --sync --sync2 --reload', ['scripts/compat-runtime.mjs', '--jiuwen', `--gateway=${GATEWAY}`, '--sync', '--sync2', '--reload'])
    if (process.env.GW_KILL && process.env.GW_START) { step('live-drop-recovery', ['scripts/live-drop-recovery.mjs']); await waitGateway() }
    if (process.env.DSH_BIN) step('plain-dsh profile matrix', [join('test/live/plain-dsh.mjs')], { JIUWEN_LIVE_NESTED: '1' })
  } else console.log('SKIP model-dependent sections (set JW_USE_STANDIN_CMD and JW_RESTORE_CMD)')
} finally {
  if (useStandin) { sh(process.env.JW_RESTORE_CMD); await waitGateway() }
  standin.stop()
  const diff = await restore(snap)
  results.push(['Jiuwen state restored exactly', diff.length === 0, '', diff])
  console.log(`${diff.length ? 'FAIL' : 'PASS'}  Jiuwen state restored exactly${diff.length ? ' — ' + diff.join(',') : ''}`)
}
const pass = results.filter(r => r[1]).length
console.log(`\nlive: ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
