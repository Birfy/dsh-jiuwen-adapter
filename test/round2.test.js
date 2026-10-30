import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJiuwenCommand } from '../src/commands.js'

function harness(gw) {
  const maps = new Map()
  const sessions = {
    ensure: (id) => { if (!maps.has(id)) maps.set(id, { jiuwenSessionId: `jw-${id}` }); return maps.get(id) },
    remove: (id) => maps.delete(id), update() {},
  }
  return { maps, cmd: createJiuwenCommand({ sessions, gateway: () => gw, config: () => ({ commandName: 'jw2' }) }) }
}

test('round2: /jiuwen delete requires confirm; usage names the configured command', async () => {
  let deleted = 0
  const { maps, cmd } = harness({ sessionDelete: async () => { deleted++ } })
  assert.match(await cmd.run('a', 'delete'), /Refusing to delete Jiuwen session jw-a .*\/jw2 delete confirm.*\/jw2 unmap/)
  assert.equal(deleted, 0); assert.ok(maps.has('a'))
  assert.match(await cmd.run('a', 'delete confirm'), /deleted and local mapping cleared/)
  assert.equal(deleted, 1); assert.ok(!maps.has('a'))
  assert.match(await cmd.run('b', 'unmap'), /Removed local mapping/, 'unmap stays confirm-free')
})

test('round2: delete of a never-used / already-deleted session still clears the local mapping', async () => {
  const { maps, cmd } = harness({ sessionDelete: async () => { throw new Error('"session not found"') } })
  assert.match(await cmd.run('n', 'delete confirm'), /does not exist on the Gateway.*local mapping cleared/)
  assert.ok(!maps.has('n'))
  const other = harness({ sessionDelete: async () => { throw new Error('boom') } })
  await assert.rejects(other.cmd.run('x', 'delete confirm'), /boom/)
  assert.ok(other.maps.has('x'), 'other errors keep the mapping')
})

test('round2: workflows get uses 0.2.7 action get_workflow, falls back to get', async () => {
  const seen = []
  const { cmd } = harness({ workflows: async (_s, action) => { seen.push(action); if (action === 'get_workflow') return { id: 'wf1' }; throw new Error('x') } })
  assert.match(await cmd.run('w', 'workflows get wf1'), /Workflow wf1/)
  assert.deepEqual(seen, ['get_workflow'])
  const old = []
  const h2 = harness({ workflows: async (_s, action) => { old.push(action); if (action === 'get_workflow') throw new Error('"unknown action: get_workflow"'); return { id: 'wf1' } } })
  assert.match(await h2.cmd.run('w', 'workflows get wf1'), /Workflow wf1/)
  assert.deepEqual(old, ['get_workflow', 'get'])
})

test('round2: document with a bad argument prints its usage instead of "Unknown subcommand"', async () => {
  const { cmd } = harness({ rpc: async () => ({ forbidden_formats: ['.exe'] }) })
  assert.match(await cmd.run('d', 'document bogus'), /Usage: \/jiuwen document formats/)
  assert.match(await cmd.run('d', 'document'), /\.exe/)
})
