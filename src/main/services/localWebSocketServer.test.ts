import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import {
  createConnection,
  createServer as createNetServer,
  type AddressInfo,
  type Socket
} from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORBIT_BROWSER_EXTENSION_ORIGIN } from './browserBridgeCompatibility'
import {
  createLocalWebSocketServer,
  type LocalWebSocketServer
} from './localWebSocketServer'

type HttpResult = {
  statusCode: number | undefined
  headers: IncomingHttpHeaders
  body: string
}

async function getUnusedLoopbackPort(): Promise<number> {
  const reservation = createNetServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', () => resolve())
  })
  const address = reservation.address() as AddressInfo | null
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()))
  })
  if (!address) throw new Error('Could not reserve a loopback test port.')
  return address.port
}

function sendHttpRequest(port: number, path: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function openWebSocketUpgrade(
  port: number,
  origin: string = ORBIT_BROWSER_EXTENSION_ORIGIN
): Promise<{ socket: Socket; response: string }> {
  const socket = createConnection({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const key = randomBytes(16).toString('base64')
  socket.write(
    [
      'GET /orbit-browser-v1 HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Origin: ${origin}`,
      '',
      ''
    ].join('\r\n')
  )
  const response = await Promise.race([
    once(socket, 'data').then(([chunk]) => (chunk as Buffer).toString('utf8')),
    once(socket, 'close').then(() => '')
  ])
  return { socket, response }
}

describe('local browser WebSocket server', () => {
  let server: LocalWebSocketServer | undefined
  let clientSocket: Socket | undefined

  afterEach(async () => {
    clientSocket?.destroy()
    clientSocket = undefined
    await server?.close()
    server = undefined
  })

  it('serves only the no-cache Local Network Access probe over HTTP', async () => {
    const port = await getUnusedLoopbackPort()
    server = createLocalWebSocketServer(
      '/orbit-browser-v1',
      ORBIT_BROWSER_EXTENSION_ORIGIN,
      vi.fn()
    )
    await server.listen(port)

    const probe = await sendHttpRequest(port, '/orbit-browser-v1/access')
    expect(probe.statusCode).toBe(204)
    expect(probe.headers['cache-control']).toBe('no-store, no-cache, must-revalidate')
    expect(probe.headers.pragma).toBe('no-cache')
    expect(probe.headers.expires).toBe('0')
    expect(probe.body).toBe('')

    const unrelated = await sendHttpRequest(port, '/orbit-browser-v1/other')
    expect(unrelated.statusCode).toBe(404)
    expect(unrelated.body).toBe('Not found')

    const wrongMethod = await sendHttpRequest(port, '/orbit-browser-v1/access', 'POST')
    expect(wrongMethod.statusCode).toBe(404)
  })

  it('continues accepting the authenticated extension WebSocket upgrade path', async () => {
    const port = await getUnusedLoopbackPort()
    const onConnection = vi.fn()
    server = createLocalWebSocketServer(
      '/orbit-browser-v1',
      ORBIT_BROWSER_EXTENSION_ORIGIN,
      onConnection
    )
    await server.listen(port)

    const upgraded = await openWebSocketUpgrade(port)
    clientSocket = upgraded.socket
    expect(upgraded.response).toContain('HTTP/1.1 101 Switching Protocols')
    expect(upgraded.response).toContain('Upgrade: websocket')
    expect(onConnection).toHaveBeenCalledOnce()
  })

  it('rejects every extension origin except the permanent Orbit extension ID', async () => {
    const port = await getUnusedLoopbackPort()
    const onConnection = vi.fn()
    server = createLocalWebSocketServer(
      '/orbit-browser-v1',
      ORBIT_BROWSER_EXTENSION_ORIGIN,
      onConnection
    )
    await server.listen(port)

    const rejected = await openWebSocketUpgrade(
      port,
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
    clientSocket = rejected.socket
    expect(rejected.response).not.toContain('101 Switching Protocols')
    expect(onConnection).not.toHaveBeenCalled()
  })

  it('binds the browser bridge server only to IPv4 loopback', async () => {
    const source = await readFile(join(process.cwd(), 'src/main/services/localWebSocketServer.ts'), 'utf8')
    expect(source).toContain("nextServer.listen(port, '127.0.0.1'")
    expect(source).not.toContain("nextServer.listen(port, '0.0.0.0'")
  })
})
