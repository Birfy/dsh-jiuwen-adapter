import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshFsToolNames, fsRouteHint, JIUWEN_SIDE_EFFECT_TOOLS, denyJiuwenSideEffectTools } from '../src/fs-route.js'
import { applyFsRouteInjection } from '../src/system-inject.js'

describe('fs-route', () => {
  it('names mcp-prefixed dsh tools', () => {
    const t = dshFsToolNames('dsh-tools')
    assert.equal(t.bash, 'mcp_dsh-tools_bash')
    assert.equal(t.write, 'mcp_dsh-tools_write')
    assert.equal(t.edit, 'mcp_dsh-tools_edit')
  })
  it('hint mentions only side-effect denials and preferred tools', () => {
    const h = fsRouteHint('dsh-tools')
    assert.match(h, /bash \/ write_file \/ edit_file are denied/)
    assert.match(h, /mcp_dsh-tools_bash/)
    assert.doesNotMatch(h, /read_file are denied/)
  })
  it('side-effect list is bash/write_file/edit_file only', () => {
    assert.deepEqual([...JIUWEN_SIDE_EFFECT_TOOLS], ['bash', 'write_file', 'edit_file'])
  })
  it('denyJiuwenSideEffectTools calls permissions.tools.update', async () => {
    const calls = []
    const r = await denyJiuwenSideEffectTools(async (m, p) => { calls.push([m, p]); return {} })
    assert.equal(r.ok, true)
    assert.deepEqual(calls.map(c => c[1].tool), ['bash', 'write_file', 'edit_file'])
    assert.ok(calls.every(c => c[0] === 'permissions.tools.update' && c[1].level === 'deny'))
  })
  it('applyFsRouteInjection is once-per-session', () => {
    const mapping = {}
    const a = applyFsRouteInjection('Q', mapping, true, 'dsh-tools')
    assert.match(a.query, /Host FS routing/)
    assert.match(a.query, /Q$/)
    mapping.fsRouteHash = a.hash
    const b = applyFsRouteInjection('Q2', mapping, true, 'dsh-tools')
    assert.equal(b.query, 'Q2')
  })
})
