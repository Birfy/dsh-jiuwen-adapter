/**
 * OpenAI-compatible chat.completions (SSE) transport → DSH StreamChunks.
 */
import { toOpenAiMessages, toOpenAiTools } from './messages.js'
import { emitTextDelta, emitToolCalls, finishText, failureFromError } from './stream-emit.js'

export class OpenAiTransport {
  /**
   * @param {{ baseURL: string, apiKey?: string, requestTimeoutMs?: number, fetchImpl?: typeof fetch }} opts
   */
  constructor(opts) {
    this.baseURL = opts.baseURL.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 180_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
   * @returns {AsyncGenerator<import('@deepseek-ai/dsh-llm').StreamChunk>}
   */
  async *stream(options) {
    const signal = options.signal
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const body = {
        model: options.model,
        messages: toOpenAiMessages(options),
        stream: true,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stop ? { stop: options.stop } : {}),
      }
      const tools = toOpenAiTools(options.tools)
      if (tools) {
        body.tools = tools
        body.tool_choice = 'auto'
      }

      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      }
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

      const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const err = new Error(`Jiuwen OpenAI bridge HTTP ${response.status}: ${detail.slice(0, 400)}`)
        err.status = response.status
        err.code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'TRANSPORT'
        throw err
      }

      // Non-SSE JSON fallback
      const ctype = response.headers.get('content-type') || ''
      if (!ctype.includes('text/event-stream')) {
        const json = await response.json()
        yield *this._fromJson(json)
        return
      }

      yield *this._fromSse(response.body, controller.signal)
    } catch (error) {
      yield failureFromError(error, signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async *_fromJson(json) {
    const choice = json?.choices?.[0]
    const message = choice?.message
    if (message?.tool_calls?.length) {
      yield *emitToolCalls(message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments ?? '{}',
      })))
      return
    }
    const text = message?.content ?? ''
    const state = { started: false }
    yield *emitTextDelta(0, text, state)
    yield *finishText(0, text, state, { kind: choice?.finish_reason === 'length' ? 'max-tokens' : 'stop' })
  }

  async *_fromSse(body, signal) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    const state = { started: false }
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const toolCalls = new Map()
    let finishReason = 'stop'

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() ?? ''
        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') {
            if (toolCalls.size > 0) {
              yield *emitToolCalls([...toolCalls.values()])
              return
            }
            yield *finishText(0, text, state, { kind: finishReason === 'length' ? 'max-tokens' : 'stop' })
            return
          }
          let event
          try { event = JSON.parse(data) } catch { continue }
          const choice = event.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta || {}
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content
            yield *emitTextDelta(0, delta.content, state)
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = Number(tc.index ?? 0)
              const current = toolCalls.get(idx) || { id: '', name: '', arguments: '' }
              if (tc.id) current.id = tc.id
              if (tc.function?.name) current.name = tc.function.name
              if (tc.function?.arguments) current.arguments += tc.function.arguments
              toolCalls.set(idx, current)
            }
          }
        }
      }
      if (toolCalls.size > 0) {
        yield *emitToolCalls([...toolCalls.values()])
        return
      }
      yield *finishText(0, text, state, { kind: finishReason === 'tool_calls' ? 'tool-calls' : finishReason === 'length' ? 'max-tokens' : 'stop' })
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  }
}
