import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { BROWSER_MAX_MESSAGE_BYTES } from './browserBridgeProtocol'

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export type LocalWebSocketConnection = {
  readonly origin: string
  readonly remoteAddress: string
  sendJson(value: unknown): void
  close(code?: number, reason?: string): void
  onMessage(listener: (value: unknown) => void): void
  onClose(listener: () => void): void
}

export type LocalWebSocketServer = {
  listen(port: number): Promise<void>
  close(): Promise<void>
}

type Frame = {
  opcode: number
  payload: Buffer
  consumed: number
}

function createAcceptValue(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  if (length <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload])
  }
  if (length <= 0xffff) {
    const header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }

  const header = Buffer.allocUnsafe(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

function decodeFrame(buffer: Buffer): Frame | null {
  if (buffer.length < 2) return null
  const first = buffer[0]
  const second = buffer[1]
  const final = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let payloadLength = second & 0x7f
  let offset = 2

  if (!final || !masked) throw new Error('Unsupported WebSocket frame.')
  if (payloadLength === 126) {
    if (buffer.length < 4) return null
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    const largeLength = buffer.readBigUInt64BE(2)
    if (largeLength > BigInt(BROWSER_MAX_MESSAGE_BYTES)) {
      throw new Error('WebSocket message is too large.')
    }
    payloadLength = Number(largeLength)
    offset = 10
  }

  if (payloadLength > BROWSER_MAX_MESSAGE_BYTES) throw new Error('WebSocket message is too large.')
  if (buffer.length < offset + 4 + payloadLength) return null

  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.allocUnsafe(payloadLength)
  for (let index = 0; index < payloadLength; index += 1) {
    payload[index] = buffer[offset + index] ^ mask[index % 4]
  }

  return { opcode, payload, consumed: offset + payloadLength }
}

class Connection implements LocalWebSocketConnection {
  private messageListener: ((value: unknown) => void) | undefined
  private readonly closeListeners = new Set<() => void>()
  private incoming = Buffer.alloc(0)
  private closed = false

  constructor(
    private readonly socket: Socket,
    readonly origin: string,
    readonly remoteAddress: string,
    initialData: Buffer
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', () => this.finish())
    socket.on('close', () => this.finish())
    socket.setTimeout(90_000, () => this.close(1001, 'Idle timeout'))
    if (initialData.length > 0) this.receive(initialData)
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  sendJson(value: unknown): void {
    if (this.closed || !this.socket.writable) return
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    if (payload.length > BROWSER_MAX_MESSAGE_BYTES) {
      this.close(1009, 'Message too large')
      return
    }
    this.socket.write(encodeFrame(0x1, payload))
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    const reasonBuffer = Buffer.from(reason.slice(0, 120), 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length)
    payload.writeUInt16BE(code, 0)
    reasonBuffer.copy(payload, 2)
    if (this.socket.writable) this.socket.write(encodeFrame(0x8, payload))
    this.socket.end()
    this.notifyClosed()
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return
    this.incoming = Buffer.concat([this.incoming, chunk])

    try {
      while (this.incoming.length > 0) {
        const frame = decodeFrame(this.incoming)
        if (!frame) return
        this.incoming = this.incoming.subarray(frame.consumed)

        if (frame.opcode === 0x8) {
          this.close(1000)
          return
        }
        if (frame.opcode === 0x9) {
          if (this.socket.writable) this.socket.write(encodeFrame(0x0a, frame.payload))
          continue
        }
        if (frame.opcode === 0x0a) continue
        if (frame.opcode !== 0x1) throw new Error('Only text WebSocket messages are supported.')

        const text = frame.payload.toString('utf8')
        const parsed = JSON.parse(text) as unknown
        this.messageListener?.(parsed)
      }
    } catch {
      this.close(1003, 'Invalid message')
    }
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.notifyClosed()
  }

  private notifyClosed(): void {
    for (const listener of this.closeListeners) listener()
    this.closeListeners.clear()
  }
}

export function createLocalWebSocketServer(
  path: string,
  onConnection: (connection: LocalWebSocketConnection, request: IncomingMessage) => void
): LocalWebSocketServer {
  let server: Server | undefined
  const connections = new Set<LocalWebSocketConnection>()

  return {
    listen: (port): Promise<void> =>
      new Promise((resolve, reject) => {
        if (server) {
          reject(new Error('The WebSocket server is already running.'))
          return
        }

        const accessProbePath = `${path}/access`
        const nextServer = createServer((request, response) => {
          const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
          if (request.method === 'GET' && requestUrl.pathname === accessProbePath) {
            response.writeHead(204, {
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              Pragma: 'no-cache',
              Expires: '0'
            })
            response.end()
            return
          }
          response.writeHead(404, { 'Content-Type': 'text/plain' })
          response.end('Not found')
        })
        server = nextServer
        nextServer.on('upgrade', (request, socket, head) => {
          const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
          const key = request.headers['sec-websocket-key']
          const origin = request.headers.origin ?? ''
          const remoteAddress = request.socket.remoteAddress ?? ''

          if (
            requestUrl.pathname !== path ||
            request.headers.upgrade?.toLocaleLowerCase() !== 'websocket' ||
            request.headers['sec-websocket-version'] !== '13' ||
            typeof key !== 'string' ||
            !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
            (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1')
          ) {
            socket.destroy()
            return
          }

          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Accept: ${createAcceptValue(key)}\r\n` +
              '\r\n'
          )
          const connection = new Connection(socket as Socket, origin, remoteAddress, head)
          connections.add(connection)
          connection.onClose(() => connections.delete(connection))
          onConnection(connection, request)
        })
        nextServer.once('error', (error) => {
          if (server === nextServer) server = undefined
          reject(error)
        })
        nextServer.listen(port, '127.0.0.1', () => {
          nextServer.removeAllListeners('error')
          nextServer.on('error', () => undefined)
          resolve()
        })
      }),
    close: async (): Promise<void> => {
      for (const connection of connections) connection.close(1001, 'Orbit is closing')
      connections.clear()
      const current = server
      server = undefined
      if (!current) return
      await new Promise<void>((resolve) => current.close(() => resolve()))
    }
  }
}
