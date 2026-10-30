/**
 * Project DSH GenerateOptions messages into OpenAI chat messages / Gateway query text.
 */

/**
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions | { messages?: unknown[], system?: string }} options
 * @returns {{ role: string, content: string }[]}
 */
export function toOpenAiMessages(options) {
  const out = []
  if (typeof options.system === 'string' && options.system.trim()) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (role === 'user') {
      out.push({ role: 'user', content: contentToText(message.content) || '' })
      continue
    }
    if (role === 'assistant') {
      const text = contentToText(message.content)
      const toolCalls = (Array.isArray(message.content) ? message.content : [])
        .filter(b => b?.type === 'tool-call')
        .map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.arguments ?? '{}' },
        }))
      const entry = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
      if (toolCalls.length) entry.tool_calls = toolCalls
      out.push(entry)
      continue
    }
    if (role === 'tool') {
      const callId = message.source?.toolCallId || message.toolCallId || message.id
      out.push({
        role: 'tool',
        tool_call_id: String(callId || 'tool'),
        content: contentToText(message.content) || '',
      })
    }
  }
  return out
}

/**
 * Flatten conversation to a single user query for Gateway chat.send.
 * Prefer the latest user text; prepend a short transcript when history exists.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions | { messages?: unknown[], system?: string }} options
 */
export function toGatewayQuery(options) {
  const openAi = toOpenAiMessages(options)
  const users = openAi.filter(m => m.role === 'user')
  const latest = users.length ? String(users[users.length - 1].content || '') : ''
  if (openAi.length <= 2) {
    const system = openAi.find(m => m.role === 'system')?.content
    return system && latest ? `${latest}` : latest || openAi.map(m => m.content).filter(Boolean).join('\n')
  }
  // Include a compact transcript so Gateway (which owns its own session memory)
  // still sees the DSH-side turn context on first map.
  const transcript = openAi
    .filter(m => m.role !== 'system')
    .slice(-8)
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')
  return transcript || latest
}

/**
 * @param {import('@deepseek-ai/dsh-llm').ToolSchema[] | undefined} tools
 */
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    },
  }))
}

/** @param {unknown} content */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' || block.type === 'reasoning') parts.push(String(block.text || ''))
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file:${block.attachment?.name || 'attachment'}]`)
  }
  return parts.join('\n')
}

/**
 * Infer the role of host messages that omit it. dsh-agent-loop hands adapters user messages built
 * from `followup()`/`steer()` input as `{ content, source: { kind: 'user' } }` without `role`; every
 * role check in this adapter would otherwise miss them and the Jiuwen query would fall back to the
 * system prompt. Returns the input array unchanged when every message already has a role, and never
 * mutates host messages (they are frozen); a role-less message is copied with the inferred role.
 * @param {any[]|undefined} messages
 * @returns {any[]|undefined}
 */
export function withInferredRoles(messages) {
  if (!Array.isArray(messages) || messages.every(m => !m || typeof m.role === 'string')) return messages
  return messages.map(m => {
    if (!m || typeof m.role === 'string') return m
    const kind = m.source?.kind
    const role = m.toolCallId !== undefined || kind === 'tool' ? 'tool'
      : kind === 'system-prompt' ? 'system'
        : kind === 'model' ? 'assistant'
          : kind === 'developer' ? 'developer'
            : 'user'
    return { ...m, role }
  })
}
