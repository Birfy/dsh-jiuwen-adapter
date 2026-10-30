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

test('session-store persists chatMode/skills/agentTemplateName and remove()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jiuwen-'))
  const path = join(dir, 'map.json')
  try {
    const store = new SessionStore(path)
    store.ensure('s1')
    store.update('s1', { chatMode: 'agent.plan', skills: ['pptx', 'bash'], agentTemplateName: 'coder' })
    const reloaded = new SessionStore(path)
    const hit = reloaded.get('s1')
    assert.equal(hit.chatMode, 'agent.plan')
    assert.deepEqual(hit.skills, ['pptx', 'bash'])
    assert.equal(hit.agentTemplateName, 'coder')
    assert.equal(reloaded.remove('s1'), true)
    assert.equal(reloaded.get('s1'), undefined)
    assert.equal(reloaded.byJiuwen.get(hit.jiuwenSessionId), undefined)
    const again = new SessionStore(path)
    assert.equal(again.get('s1'), undefined)
    assert.equal(again.list().length, 0)
    assert.equal(again.remove('missing'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
