import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { toNodeMiddleware, toNodeUpgradeHandler } from './node.js';

/**
 * Real-socket plumbing shared by the websocket upgrade specs. Test-only: excluded from the
 * library build in tsconfig.lib.json.
 */

const servers: Server[] = [];
const openSockets: Duplex[] = [];

/** Call from `afterEach`. */
export async function closeAll(): Promise<void> {
  // A socket that has been upgraded is detached from the server's connection tracking, so
  // `close()` (and even `closeAllConnections()`) waits on it forever. Track them ourselves.
  openSockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
}

export async function listen(server: Server): Promise<{ origin: string; port: number }> {
  servers.push(server);
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port };
}

/** A minimal websocket-ish endpoint: completes the handshake, then echoes uppercase. */
export function upstreamWithSockets() {
  const seenPaths: string[] = [];
  const seenHeaders: IncomingHttpHeaders[] = [];
  const server = createServer((_req, res) => res.end('http'));

  server.on('upgrade', (req, socket: Duplex, head) => {
    seenPaths.push(req.url ?? '');
    seenHeaders.push(req.headers);
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nx-upstream: yes\r\n\r\n`,
    );
    if (head?.length) socket.write(head.toString().toUpperCase());
    socket.on('data', (chunk: Buffer) => socket.write(chunk.toString().toUpperCase()));
  });

  return { server, seenPaths, seenHeaders };
}

/**
 * Performs a raw upgrade request and returns the response head plus one echoed frame.
 *
 * @param extraHeaders additional request header lines, e.g. `['Cookie: sid=1']`
 */
export function attemptUpgrade(
  port: number,
  path: string,
  extraHeaders: string[] = [],
): Promise<{ head: string; echo: string }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = '';
    let pinged = false;

    const finish = (outcome: () => void) => {
      socket.destroy();
      outcome();
    };

    socket.setTimeout(2500, () => finish(() => reject(new Error(`timed out: ${buffer || '(nothing received)'}`))));

    socket.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          extraHeaders.map((line) => `${line}\r\n`).join('') +
          '\r\n',
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // the head can arrive across chunks, so wait for its terminator before replying
      if (!pinged && buffer.includes('\r\n\r\n')) {
        pinged = true;
        socket.write('ping');
        return;
      }

      const [head, ...rest] = buffer.split('\r\n\r\n');
      const echo = rest.join('\r\n\r\n');
      if (echo.includes('PING')) {
        finish(() => resolve({ head, echo }));
      }
    });

    socket.on('close', () => reject(new Error(`socket closed: ${buffer || '(nothing received)'}`)));
    socket.on('error', reject);
  });
}

/** A host server with the gateway mounted, plus a plain 404 for anything it doesn't own. */
export function hostServer(gateway: Parameters<typeof toNodeUpgradeHandler>[0]) {
  const middleware = toNodeMiddleware(gateway);
  return createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('shell');
    }),
  );
}
