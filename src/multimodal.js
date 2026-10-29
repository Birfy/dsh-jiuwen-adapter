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
        mediaItems.push({
          type: 'document',
          name,
          ...(path ? { path } : {}),
          ...(block.attachment?.mimeType ? { mime_type: block.attachment.mimeType } : {}),
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
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
    return { type: 'image', mime_type: mime, data_url: dataUrl }
  }
  if (typeof base64 === 'string' && base64.length > 0) {
    return { type: 'image', mime_type: mime, data_url: `data:${mime};base64,${base64}` }
  }
  const path = att.path || att.hostPath || att.readPath
  if (path) {
    return { type: 'image', mime_type: mime, path: String(path), name: att.name || 'image' }
  }
  // Offloaded / handle-only — leave a text marker; Gateway cannot fetch DSH attachment bytes.
  if (block.offloaded) return null
  return null
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
