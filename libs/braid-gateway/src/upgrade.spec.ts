import { afterEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createGateway } from './gateway.js';
import { toNodeMiddleware, toNodeUpgradeHandler } from './node.js';

/**
 * Websocket pass-through, tested against a real socket handshake rather than a mock.
 *
 * This is what keeps a fragment's dev-server live reload working when the fragment is reached
 * through the gateway, so the test drives an actual upgrade and echoes bytes both ways.
 */

const servers: Server[] = [];
const openSockets: Duplex[] = [];

afterEach(async () => {
  // A socket that has been upgraded is detached from the server's connection tracking, so
  // `close()` (and even `closeAllConnections()`) waits on it forever. Track them ourselves.
  openSockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server: Server): Promise<{ origin: string; port: number }> {
  servers.push(server);
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port };
}

/** A minimal websocket-ish endpoint: completes the handshake, then echoes uppercase. */
function upstreamWithSockets() {
  const seenPaths: string[] = [];
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
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

/** Performs a raw upgrade request and returns the response head plus one echoed frame. */
function attemptUpgrade(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
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
          Object.entries(extraHeaders)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join('') +
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
function hostServer(gateway: Parameters<typeof toNodeUpgradeHandler>[0]) {
  const middleware = toNodeMiddleware(gateway);
  return createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end('shell');
    }),
  );
}

describe('websocket pass-through', () => {
  it('proxies a fragment upgrade to the endpoint with the prefix stripped', async () => {
    const upstream = upstreamWithSockets();
    const { origin } = await listen(upstream.server);

    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: origin }] });
    const host = hostServer(gateway);
    host.on('upgrade', toNodeUpgradeHandler(gateway));
    const { port } = await listen(host);

    const { head, echo } = await attemptUpgrade(port, '/__braid/frag/billing/ng-cli-ws');

    expect(head).toContain('101 Switching Protocols');
    expect(head).toContain('x-upstream: yes');
    expect(echo).toBe('PING');
    // the endpoint sees the path it would serve standalone
    expect(upstream.seenPaths).toEqual(['/ng-cli-ws']);
  });

  it("does not hand the caller's credentials to the endpoint unless forwardCredentials says so", async () => {
    const upstream = upstreamWithSockets();
    const { origin } = await listen(upstream.server);
    const credentials = { cookie: 'session=abc', authorization: 'Bearer user-token' };

    for (const forwardCredentials of [undefined, true]) {
      const gateway = createGateway({
        registry: [{ id: 'billing', endpoint: origin }],
        ...(forwardCredentials === undefined ? {} : { forwardCredentials }),
      });
      const host = hostServer(gateway);
      host.on('upgrade', toNodeUpgradeHandler(gateway));
      const { port } = await listen(host);

      const { echo } = await attemptUpgrade(port, '/__braid/frag/billing/live', credentials);
      expect(echo).toBe('PING');
    }

    // the same trust boundary as a fetch: a socket is not a way around it
    expect(upstream.seenHeaders[0].cookie).toBeUndefined();
    expect(upstream.seenHeaders[0].authorization).toBeUndefined();
    expect(upstream.seenHeaders[1].cookie).toBe('session=abc');
    expect(upstream.seenHeaders[1].authorization).toBe('Bearer user-token');
    // and the endpoint can tell a gateway sent it, which is what bounds a loop
    expect(upstream.seenHeaders[0]['x-braid-via']).toBe('braid');
  });

  it('leaves upgrades it does not own to the next handler', async () => {
    const upstream = upstreamWithSockets();
    const { origin } = await listen(upstream.server);

    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: origin }] });
    const host = hostServer(gateway);

    let shellUpgrades = 0;
    host.on(
      'upgrade',
      toNodeUpgradeHandler(gateway, (_req, socket) => {
        shellUpgrades++;
        socket.destroy();
      }),
    );
    const { port } = await listen(host);

    // the shell's own dev socket, not a fragment's
    await attemptUpgrade(port, '/_shell/hmr').catch(() => undefined);

    expect(shellUpgrades).toBe(1);
    expect(upstream.seenPaths).toEqual([]);
  });

  it('refuses an upgrade for a fragment the caller may not load', async () => {
    const upstream = upstreamWithSockets();
    const { origin } = await listen(upstream.server);

    const gateway = createGateway({
      registry: [{ id: 'billing', endpoint: origin, access: { fetch: { roles: ['dev'] } } }],
      mode: 'production',
      principal: () => ({ roles: [] }),
    });
    const host = hostServer(gateway);
    host.on('upgrade', toNodeUpgradeHandler(gateway));
    const { port } = await listen(host);

    await expect(attemptUpgrade(port, '/__braid/frag/billing/ng-cli-ws')).rejects.toThrow();
    expect(upstream.seenPaths).toEqual([]);
  });

  it('resolveUpgrade ignores realm and document namespaces', async () => {
    const gateway = createGateway({ registry: [{ id: 'billing', endpoint: 'http://localhost:1' }] });

    expect(await gateway.resolveUpgrade(new Request('http://host/__braid/realm/billing/'))).toBeNull();
    expect(await gateway.resolveUpgrade(new Request('http://host/__braid/doc/billing/'))).toBeNull();
    expect(await gateway.resolveUpgrade(new Request('http://host/__braid/frag/billing/ws'))).not.toBeNull();
  });
});
