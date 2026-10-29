import test from 'node:test'
import assert from 'node:assert/strict'
import { hasQuestionAnswerer } from '../src/plugin.js'

test('hasQuestionAnswerer: headless (no listener) → false; client listener → true; unknown host → true', () => {
  assert.equal(hasQuestionAnswerer({ root: { events: { _hooks: {} } } }), false)
  assert.equal(hasQuestionAnswerer({ root: { events: { _hooks: { 'user-questions/request': [] } } } }), false)
  assert.equal(hasQuestionAnswerer({ root: { events: { _hooks: { 'user-questions/request': [{}] } } } }), true)
  assert.equal(hasQuestionAnswerer({}), true)
  assert.equal(hasQuestionAnswerer({ get root() { throw new Error('inject') } }), true)
})
