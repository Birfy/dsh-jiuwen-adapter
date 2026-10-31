/**
 * Tiny RFC6455 WebSocket server (no external deps). Path /ws or any upgrade.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

export async function WebSocketServer({ port, host }) {
  try {
    const ws = await import('ws')
    const wss = new ws.WebSocketServer({ port, host, path: '/ws' })
    return wss
  } catch {
    // fall through to built-in mini server
  }

  const emitter = new EventEmitter()
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('dsh-jiuwen mock-gateway\n')
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const client = new MiniWs(socket)
    if (head?.length) client._feed(head)
    emitter.emit('connection', client, req)
  })

  await new Promise((resolve) => server.listen(port, host, resolve))

  emitter.close = () => new Promise((resolve) => {
    for (const s of sockets) {
      try { s.destroy() } catch { /* ignore */ }
    }
    sockets.clear()
    server.close(() => resolve())
    // force if close hangs
    setTimeout(() => resolve(), 500).unref?.()
  })

  return emitter
}

class MiniWs extends EventEmitter {
  constructor(socket) {
    super()
    this.socket = socket
    this._buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this._feed(chunk))
    socket.on('close', () => this.emit('close'))
    socket.on('error', (err) => this.emit('error', err))
  }

  send(data) {
    const payload = Buffer.from(String(data))
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(2)
      header[0] = 0x81
      header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x81
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    if (this.socket.destroyed || this.socket.writableEnded) return
    this.socket.write(Buffer.concat([header, payload]))
  }

  close() {
    try { this.socket.end() } catch { /* ignore */ }
  }

  _feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    while (true) {
      if (this._buffer.length < 2) return
      this._frameOp = this._buffer[0] & 0x0f
      const second = this._buffer[1]
      const masked = (second & 0x80) !== 0
      let len = second & 0x7f
      let offset = 2
      if (len === 126) {
        if (this._buffer.length < 4) return
        len = this._buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this._buffer.length < 10) return
        len = Number(this._buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      if (this._buffer.length < offset + maskLen + len) return
      let payload = this._buffer.subarray(offset + maskLen, offset + maskLen + len)
      if (masked) {
        const mask = this._buffer.subarray(offset, offset + 4)
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
      }
      this._buffer = this._buffer.subarray(offset + maskLen + len)
      if (this._frameOp === 0x8) { // close: echo the close frame, then end (clients otherwise wait for a timeout)
        try { this.socket.write(Buffer.from([0x88, 0x00])); this.socket.end() } catch { /* ignore */ }
        return
      }
      if (this._frameOp === 0x9 || this._frameOp === 0xa) continue // ping/pong
      this.emit('message', payload)
    }
  }
}
