/**
 * Helpers to emit DSH StreamChunk sequences for plain text / tool-call replies.
 */

/**
 * Emit a complete text reply as block-start → text-delta(s) → block-end → finish.
 * @param {string} text
 * @param {{ index?: number, chunkSize?: number }} [opts]
 * @returns {AsyncGenerator<import('@deepseek-ai/dsh-llm').StreamChunk>}
 */
export async function *emitTextReply(text, opts = {}) {
  const index = opts.index ?? 0
  const chunkSize = opts.chunkSize ?? 48
  yield { type: 'block-start', index, blockType: 'text' }
  const body = text ?? ''
  if (body.length === 0) {
    // still emit an empty text block so assemblers see a coherent response
  } else if (chunkSize <= 0 || body.length <= chunkSize) {
    yield { type: 'text-delta', index, text: body }
  } else {
    for (let i = 0; i < body.length; i += chunkSize) {
      yield { type: 'text-delta', index, text: body.slice(i, i + chunkSize) }
    }
  }
  yield { type: 'block-end', index, block: { type: 'text', text: body } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Emit incremental text deltas for a live stream (caller yields finish).
 * @param {number} index
 * @param {string} delta
 * @param {{ started: boolean }} state
 */
export function *emitTextDelta(index, delta, state) {
  if (!state.started) {
    state.started = true
    yield { type: 'block-start', index, blockType: 'text' }
  }
  if (delta) yield { type: 'text-delta', index, text: delta }
}

/**
 * Close an open text block and finish.
 * @param {number} index
 * @param {string} fullText
 * @param {{ started: boolean }} state
 * @param {{ kind: string, failure?: object }} [reason]
 */
export function *finishText(index, fullText, state, reason = { kind: 'stop' }) {
  if (state.started) {
    yield { type: 'block-end', index, block: { type: 'text', text: fullText } }
  } else if (fullText) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text: fullText }
    yield { type: 'block-end', index, block: { type: 'text', text: fullText } }
  }
  yield { type: 'finish', reason }
}

/**
 * Emit OpenAI-style tool_calls as DSH tool-call blocks then finish tool-calls.
 * @param {Array<{ id: string, name: string, arguments: string }>} calls
 */
export async function *emitToolCalls(calls) {
  let index = 0
  for (const call of calls) {
    const id = call.id || `call_${index}`
    const name = call.name || 'tool'
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {})
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name, arguments: args },
    }
    index += 1
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** @param {unknown} error */
export function failureFromError(error, signal) {
  if (signal?.aborted) {
    return {
      type: 'finish',
      reason: {
        kind: 'aborted',
        failure: { message: 'aborted', code: 'ABORTED' },
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = error?.code && typeof error.code === 'string' ? error.code : 'TRANSPORT'
  const status = typeof error?.status === 'number' ? error.status : undefined
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message,
        code,
        ...(status === undefined ? {} : { status }),
      },
    },
  }
}
