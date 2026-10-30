import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGatewayError } from '../src/gateway-transport.js'
import { SessionStore } from '../src/session-store.js'
import { createJiuwenCommand } from '../src/commands.js'
import { normalizeCronExpr } from '../src/commands-ext.js'

test('round3: formatGatewayError unwraps JSON-stringified Gateway strings and objects', () => {
  assert.equal(formatGatewayError('"未找到 skill: x"'), '未找到 skill: x')
  assert.equal(formatGatewayError('"\\"Agent 不存在: y\\""'), 'Agent 不存在: y') // double-encoded
  assert.equal(formatGatewayError({ message: '"job not found"' }), 'job not found')
  assert.equal(formatGatewayError({ error: 'Session was not found' }), 'Session was not found')
  assert.equal(formatGatewayError(new Error('"工作流控制不可用"')), '工作流控制不可用')
  assert.equal(formatGatewayError({}), 'Jiuwen Gateway error') // no useful fields → not [object Object]
  assert.doesNotMatch(formatGatewayError({ a: 1 }), /\[object Object\]/)
  assert.equal(formatGatewayError('unknown method: memory.list'), 'unknown method: memory.list')
})

test('round3: corrupt session-store file soft-fails (empty store + loadError), missing file is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jw-r3-store-'))
  try {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not-json!!!')
    const store = new SessionStore(bad)
    assert.ok(store.loadError)
    assert.equal(store.list().length, 0)
    const m = store.ensure('s1')
    assert.ok(m.jiuwenSessionId)
    // rewrite recovers
    const again = new SessionStore(bad)
    assert.equal(again.get('s1')?.jiuwenSessionId, m.jiuwenSessionId)
    assert.equal(again.loadError, undefined)

    const missing = new SessionStore(join(dir, 'nope.json'))
    assert.equal(missing.loadError, undefined)
    assert.equal(missing.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function harness(gw, extra = {}) {
  const maps = new Map()
  const sessions = {
    ensure: (id) => { if (!maps.has(id)) maps.set(id, { jiuwenSessionId: `jw-${id}`, ...(extra.mapping || {}) }); return maps.get(id) },
    remove: (id) => maps.delete(id), update() {}, get: (id) => maps.get(id),
  }
  return { maps, cmd: createJiuwenCommand({ sessions, gateway: () => gw, config: () => ({ commandName: 'jw3', gatewayURL: 'ws://x', mcpServerName: 'dsh-tools' }) }) }
}

test('round3: command handler strips quoted Gateway errors (no Jiuwen: "…")', async () => {
  const { cmd } = harness({
    skillsGet: async () => { throw Object.assign(new Error('"未找到 skill: nope"'), { code: 'TRANSPORT' }) },
    skillsVersionsList: async () => ({ versions: [] }),
  })
  const out = await cmd.definition.handler({ agent: { id: 'a' }, rawInput: 'skill-info nope' })
  assert.equal(out.kind, 'error')
  assert.equal(out.text, 'Jiuwen: 未找到 skill: nope')
  assert.doesNotMatch(out.text, /Jiuwen: "/)
})

test('round3: continue-queued soft-fails clearly when session has no turns yet', async () => {
  const { cmd } = harness({
    rpc: async () => { throw new Error('"Session was not found"') },
  })
  const text = await cmd.run('c', 'continue-queued')
  assert.match(text, /no queued messages to continue/)
  assert.match(text, /reconnect/i)
})

test('round3: swarm-stop soft-fails clearly when team/workflow is idle', async () => {
  const { cmd } = harness({
    rpc: async () => { throw new Error('"工作流控制不可用，发送一条消息唤醒团队后即可使用。"') },
  })
  const text = await cmd.run('s', 'swarm-stop run-x')
  assert.match(text, /soft-failed|no active SwarmFlow/i)
  assert.match(text, /工作流控制不可用/)
})

test('round3: heartbeat create builds 0.2.7 schedule {type:interval,interval_seconds}', async () => {
  let seen
  const { cmd } = harness({
    rpc: async (m, p) => { seen = { m, p }; return { job: { id: 'hb1', name: p.name, enabled: p.enabled } } },
  })
  const text = await cmd.run('h', 'heartbeat create name=probe prompt="ping me" every=120 enabled=off')
  assert.equal(seen.m, 'heartbeat.job.create')
  assert.equal(seen.p.prompt, 'ping me')
  assert.deepEqual(seen.p.schedule, { type: 'interval', interval_seconds: 120 })
  assert.equal(seen.p.enabled, false)
  assert.match(text, /Created Jiuwen heartbeat job hb1/)
  assert.match(await cmd.run('h', 'heartbeat create name=x'), /Usage: \/jiuwen heartbeat create/)
})

test('round3: cron update sends {id, patch} and renames keys', async () => {
  let seen
  const { cmd } = harness({
    rpc: async (m, p) => { seen = { m, p }; return { job: { id: p.id, name: p.patch.name, cron_expr: p.patch.cron_expr, enabled: p.patch.enabled } } },
  })
  const text = await cmd.run('c', 'cron update abc name=renamed expr="0 0 * * *" enabled=on')
  assert.equal(seen.m, 'cron.job.update')
  assert.equal(seen.p.id, 'abc')
  assert.equal(seen.p.patch.name, 'renamed')
  assert.equal(seen.p.patch.cron_expr, '0 0 0 * * * *')
  assert.equal(seen.p.patch.enabled, true)
  assert.match(text, /Updated Jiuwen cron job abc/)
})

test('round3: delete confirm twice — second call still clears mapping via session-not-found path', async () => {
  let n = 0
  const { maps, cmd } = harness({
    sessionDelete: async () => { if (n++) throw new Error('"session not found"') },
  })
  assert.match(await cmd.run('d', 'delete confirm'), /deleted and local mapping cleared/)
  assert.ok(!maps.has('d'))
  // recreate mapping then delete again after gateway already gone
  maps.set('d', { jiuwenSessionId: 'jw-d' })
  assert.match(await cmd.run('d', 'delete confirm'), /does not exist on the Gateway.*local mapping cleared/)
  assert.ok(!maps.has('d'))
})


test('round3: normalizeCronExpr pads 5→7 and 6→7 fields', () => {
  assert.equal(normalizeCronExpr('*/30 * * * *'), '0 */30 * * * * *')
  assert.equal(normalizeCronExpr('0 0 4 1 1 *'), '0 0 0 4 1 1 *')
  assert.equal(normalizeCronExpr('0 0 3 1 1 * *'), '0 0 3 1 1 * *')
})

test('round3: cron create normalises 5-field expr before RPC', async () => {
  let seen
  const { cmd } = harness({
    rpc: async (m, p) => { seen = { m, p }; return { job: { id: 'c1', name: p.name, cron_expr: p.cron_expr, enabled: false } } },
  })
  const text = await cmd.run('c', 'cron create name=n expr="*/15 * * * *" enabled=off')
  assert.equal(seen.p.cron_expr, '0 */15 * * * * *')
  assert.match(text, /Created Jiuwen cron job c1/)
})
