import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toOpenAiMessages, toGatewayQuery, toOpenAiTools, contentToText } from '../src/messages.js'

test('toOpenAiMessages projects roles and tool results', () => {
  const messages = toOpenAiMessages({
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
        ],
      },
      { role: 'tool', content: 'ok', source: { toolCallId: 'c1' } },
    ],
  })
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].content, 'hi')
  assert.equal(messages[2].tool_calls[0].function.name, 'shell')
  assert.equal(messages[3].tool_call_id, 'c1')
})

test('toGatewayQuery uses transcript for multi-turn', () => {
  const q = toGatewayQuery({
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: 'three' },
    ],
  })
  assert.match(q, /user: one/)
  assert.match(q, /three/)
})

test('toOpenAiTools maps schemas', () => {
  const tools = toOpenAiTools([{ name: 'shell', description: 'run', parameters: { type: 'object' } }])
  assert.equal(tools[0].type, 'function')
  assert.equal(tools[0].function.name, 'shell')
})

test('contentToText joins blocks', () => {
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
})
