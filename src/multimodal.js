import { readFileSync, statSync } from 'node:fs'
/**
 * Project DSH message image/file blocks into Jiuwen chat.send media attachments.
 * Jiuwen owns persistence (media.persist); we pass inline data URLs / refs when present.
 */

/**
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions | { messages?: unknown[] }} options
 * @returns {{ mediaItems: object[], filesHint: object | undefined, textExtras: string[] }}
 */
export function extractMediaFromOptions(options) {
  const mediaItems = []
  const textExtras = []
  for (const message of options.messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') {
        const item = imageBlockToMediaItem(block)
        if (item) mediaItems.push(item)
        else textExtras.push('[image:unavailable]')
      } else if (block.type === 'file') {
        const name = block.attachment?.name || block.attachment?.filename || 'file'
        const path = block.attachment?.path || block.attachment?.hostPath
        const mime = block.attachment?.mimeType || 'application/octet-stream'
        const inline = block.attachment?.dataUrl
          || (block.attachment?.base64 ? `data:${mime};base64,${block.attachment.base64}` : undefined)
          || (path ? readInline(String(path), mime) : undefined)
        mediaItems.push({
          type: 'document',
          name,
          filename: name,
          ...(path ? { path } : {}),
          mime_type: mime,
          mimeType: mime,
          ...(inline ? { base64Data: inline } : {}),
        })
        textExtras.push(`[file:${name}]`)
      }
    }
  }
  return {
    mediaItems,
    filesHint: mediaItems.length
      ? {
          uploaded_images: mediaItems.filter(m => m.type === 'image'),
          uploaded_documents: mediaItems.filter(m => m.type === 'document'),
        }
      : undefined,
    textExtras,
  }
}

function imageBlockToMediaItem(block) {
  const att = block.attachment || {}
  // Prefer data URL / base64 if the attachment store already projected one onto the block
  const dataUrl = att.dataUrl || att.dataURL || block.dataUrl
  const base64 = att.base64 || block.base64
  const mime = att.mimeType || att.mediaType || 'image/png'
  const filename = att.name || att.filename || 'image'
  // Jiuwen web shape: base64Data + mimeType + filename (gateway uploads it to the session).
  const wire = (url) => ({ type: 'image', mime_type: mime, mimeType: mime, filename, data_url: url, base64Data: url })
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) return wire(dataUrl)
  if (typeof base64 === 'string' && base64.length > 0) return wire(`data:${mime};base64,${base64}`)
  const path = att.path || att.hostPath || att.readPath
  if (path) {
    const inline = readInline(String(path), mime)
    if (inline) return { ...wire(inline), path: String(path), name: filename }
    return { type: 'image', mime_type: mime, mimeType: mime, path: String(path), name: filename, filename }
  }
  // Offloaded / handle-only — leave a text marker; Gateway cannot fetch DSH attachment bytes.
  if (block.offloaded) return null
  return null
}

const MAX_INLINE_BYTES = 10 * 1024 * 1024

/** Read a local file into a data URL when small enough (best effort). */
function readInline(path, mime) {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_INLINE_BYTES) return undefined
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * Merge media into chat.send params (Jiuwen web shape).
 * @param {Record<string, unknown>} params
 * @param {{ mediaItems: object[], filesHint?: object }} media
 */
export function attachMediaToChatParams(params, media) {
  if (!media.mediaItems.length) return params
  const attachments = {
    media_items: media.mediaItems,
    ...(media.filesHint ? { files: media.filesHint } : {}),
  }
  return {
    ...params,
    attachments,
    media_items: media.mediaItems,
    files: media.filesHint,
  }
}

/** dsh-llm ≥0.2 projects every file block to this handle text before the adapter sees it. */
const FILE_HANDLE_RE = /\[File ("(?:[^"\\]|\\.)*") \((\d+) bytes, sha256:[0-9a-f]+\): verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")\./g
const MIME_BY_EXT = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }

/**
 * Recover document attachments from dsh-llm file handle texts in the LAST user message (so a file is
 * persisted once, on the turn it was attached) and append them as `file` blocks for documentPersist.
 * Messages without handles are returned unchanged.
 */
export function fileBlocksFromHandles(options) {
  const messages = options?.messages
  if (!Array.isArray(messages)) return options
  let idx = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') { idx = i; break }
  if (idx < 0) return options
  const msg = messages[idx]
  const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (Array.isArray(msg.content) ? msg.content : [])
  if (blocks.some(b => b?.type === 'file')) return options
  const files = []
  for (const b of blocks) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue
    for (const m of b.text.matchAll(FILE_HANDLE_RE)) {
      let name, path
      try { name = JSON.parse(m[1]); path = JSON.parse(m[3]) } catch { continue }
      const ext = String(name).split('.').pop().toLowerCase()
      files.push({ type: 'file', attachment: { name, path, bytes: Number(m[2]), mimeType: MIME_BY_EXT[ext] || 'application/octet-stream' } })
    }
  }
  if (!files.length) return options
  const next = messages.slice()
  next[idx] = { ...msg, content: [...blocks, ...files] }
  return { ...options, messages: next }
}
