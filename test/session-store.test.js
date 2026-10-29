import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/session-store.js'

test('session-store persists dsh ↔ jiuwen mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jiuwen-'))
  const path = join(dir, 'map.json')
  try {
    const store = new SessionStore(path)
    const a = store.ensure('sess-1', { botId: 'bot-a' })
    assert.equal(a.dshSessionId, 'sess-1')
    assert.ok(a.jiuwenSessionId.startsWith('dsh-'))
    assert.equal(a.botId, 'bot-a')

    const again = store.ensure('sess-1')
    assert.equal(again.jiuwenSessionId, a.jiuwenSessionId)

    store.setAgentId('sess-1', 'agent-9')
    const reloaded = new SessionStore(path)
    const hit = reloaded.get('sess-1')
    assert.equal(hit.jiuwenAgentId, 'agent-9')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.mappings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
