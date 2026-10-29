import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMediaFromOptions, attachMediaToChatParams } from '../src/multimodal.js'

test('extractMediaFromOptions picks image data_url and file blocks', () => {
  const { mediaItems, filesHint } = extractMediaFromOptions({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image', attachment: { dataUrl: 'data:image/png;base64,aaa', mimeType: 'image/png', name: 'a.png' } },
        { type: 'file', attachment: { name: 'doc.pdf', path: '/tmp/doc.pdf', mimeType: 'application/pdf' } },
      ],
    }],
  })
  assert.equal(mediaItems.length, 2)
  assert.equal(mediaItems[0].type, 'image')
  assert.equal(mediaItems[1].type, 'document')
  assert.equal(filesHint.uploaded_images.length, 1)
})

test('attachMediaToChatParams nests attachments', () => {
  const params = attachMediaToChatParams({ query: 'hi' }, {
    mediaItems: [{ type: 'image', data_url: 'data:image/png;base64,x' }],
    filesHint: { uploaded_images: [{ type: 'image' }] },
  })
  assert.equal(params.attachments.media_items.length, 1)
  assert.ok(params.media_items)
})
