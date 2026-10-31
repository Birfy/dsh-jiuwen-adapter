// Scripted OpenAI-compatible stand-in model. Markers in the LAST user message:
//  TAG:x  SLOW<ms>  REASON  HUGE<kb>  ERR500  ERRMID  TOOL:<name-substring>:<json-args>  (one tool call, then a final answer quoting the tool result)
import http from 'node:http'
import { appendFileSync } from 'node:fs'
const port = Number(process.env.PORT || 18999)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text || '').join('') : ''
// TOOL:<name>:{json} — balanced-brace scan (the query arrives inside Jiuwen's JSON envelope).
const grab = (text, key) => {
  const i = text.indexOf(key); if (i < 0) return null
  const rest = text.slice(i + key.length); const c = rest.indexOf(':'); if (c < 0) return null
  const name = rest.slice(0, c); let depth = 0, j = c + 1, inStr = false
  if (rest[j] !== '{') return null
  for (; j < rest.length; j++) { const ch = rest[j]; if (inStr) { if (ch === '\\') j++; else if (ch === '"') inStr = false; continue } if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) break }
  return [null, name, rest.slice(c + 1, j + 1)]
}
const log = o => appendFileSync(process.env.STANDIN_LOG || '/tmp/standin.jsonl', JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n')
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c
  if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })) }
  let j = {}; try { j = JSON.parse(body) } catch {}
  const msgs = j.messages || []
  const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user')
  const last = textOf(msgs[lastUserIdx]?.content).replace(/\\"/g, '"')
  const after = msgs.slice(lastUserIdx + 1)
  const toolMsgs = after.filter(m => m.role === 'tool')
  const users = msgs.filter(m => m.role === 'user')
  const tools = (j.tools || []).map(t => t.function?.name || t.name).filter(Boolean)
  const sys = textOf(msgs.find(m => m.role === 'system')?.content)
  const m = last.match(/SLOW(\d+)?/); const slowMs = m ? Number(m[1] || 8000) : 0
  const tag = (last.match(/TAG:(\S+)/) || [])[1] || 'x'
  const tm = grab(last, 'TOOL:')
  log({ ...(/LISTTOOLS/.test(last) ? { tools, schemas: (j.tools||[]).filter(t=>/tool_call|tool_search|ask/.test(t.function?.name)).map(t=>t.function) } : {}), tag, stream: !!j.stream, nTools: tools.length, toolMsgs: toolMsgs.length, users: users.length, sysLen: sys.length, persona: /System instructions from host/.test(last), personaText: (last.match(/Deep Persona \w+/) || [])[0], marks: last.match(/MARK[A-Z0-9_]+/g) || [], testAgent: /You are a test agent/.test(last), boiler: /exit code: N|DeepSeek Harness/.test(last), last: last.slice(0, 160) })
  if (/ERR500/.test(last)) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stand-in scripted 500', type: 'server_error' } })) }
  let toolCall
  if (tm && toolMsgs.length === 0) {
    const name = tools.find(n => n === tm[1]) || tools.find(n => n.includes(tm[1]))
    if (name) toolCall = { id: 'call_' + Date.now(), type: 'function', function: { name, arguments: tm[2] } }
    else log({ tag, missingTool: tm[1], tools })
  }
  // MCP:<substr>:<json>  → tool_search, then tool_call with the matching deferred name, then answer.
  const mm = grab(last, 'MCP:')
  if (mm && tools.includes('tool_search')) {
    if (toolMsgs.length === 0) toolCall = { id: 'call_s' + Date.now(), type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: mm[1], limit: 50, call_goal: "find tool" }) } }
    else if (toolMsgs.length === 1) {
      const txt = textOf(toolMsgs[0].content)
      const names = [...txt.matchAll(/"name"\s*:\s*"([^"]+)"|^##\s+(\S+)/gm)].map(x => x[1] || x[2])
      const name = names.find(n => n.includes('dsh') && n.endsWith(mm[1])) || names.find(n => n.endsWith(mm[1]))
      log({ tag, searchNames: names.slice(0, 20), picked: name })
      if (name) toolCall = { id: 'call_c' + Date.now(), type: 'function', function: { name: 'tool_call', arguments: JSON.stringify({ name, args: JSON.parse(mm[2]), call_goal: 'run tool' }) } }
    }
  }
  let reply = toolCall ? '' : toolMsgs.length ? `stand-in tool-result ${tag}: ${textOf(toolMsgs.at(-1).content).slice(0, 300).replace(/\s+/g, ' ')}` : `stand-in reply ${tag} n=${users.length}`
  const hm = last.match(/HUGE(\d+)/); if (hm && !toolCall) reply += ' ' + Array.from({ length: Math.ceil(Number(hm[1]) * 1024 / 12) }, (_, k) => `w${(k * 7919) % 1000003}`).join(' ') + ' END-HUGE'
  const reasoning = /REASON/.test(last) ? `thinking about ${tag} step one. step two.` : ''
  if (!j.stream) {
    if (slowMs) await sleep(slowMs)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 0, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: reply || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, fin) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: j.model, choices: [{ index: 0, delta, finish_reason: fin || null }] })}\n\n`)
  chunk({ role: 'assistant', content: '' })
  for (const w of reasoning.split(' ').filter(Boolean)) chunk({ reasoning_content: w + ' ' })
  if (toolCall) { chunk({ tool_calls: [{ index: 0, ...toolCall }] }); chunk({}, 'tool_calls') }
  else {
    const parts = reply.length > 4000 ? reply.match(/[\s\S]{1,4000}/g) : reply.split(/(?<= )/)
    for (let i = 0; i < parts.length; i++) {
      if (slowMs) await sleep(slowMs / parts.length)
      if (res.destroyed) return
      chunk({ content: parts[i] })
      if (/ERRMID/.test(last) && i === Math.floor(parts.length / 2)) { res.socket.destroy(); return }
    }
    chunk({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
  res.end('data: [DONE]\n\n')
}).listen(port, '127.0.0.1', () => console.log('stand-in on', port))
