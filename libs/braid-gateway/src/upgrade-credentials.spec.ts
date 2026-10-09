import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, GatewayOptions } from './gateway.js';
import { toNodeUpgradeHandler } from './node.js';
import { attemptUpgrade, closeAll, hostServer, listen, upstreamWithSockets } from './upgrade.helpers.js';

/**
 * Websocket upgrades cross the same trust boundary as fragment fetches, so they follow the same
 * credential rule: the caller's `Cookie` and `Authorization` stay with the shell unless
 * `forwardCredentials` says the whole registry is inside it. See credentials.spec.ts for the
 * HTTP path.
 */

afterEach(closeAll);

const signedIn = ['Cookie: session=a-real-session-value; theme=dark', 'Authorization: Bearer a-token-for-the-shell'];

/** Mounts a gateway in front of a recording endpoint, with the upgrade handler wired up. */
async function mountGateway(options: Omit<GatewayOptions, 'registry'> = {}) {
  const upstream = upstreamWithSockets();
  const { origin } = await listen(upstream.server);

  const gateway = createGateway({ registry: [{ id: 'billing', endpoint: origin }], ...options });
  const host = hostServer(gateway);
  host.on('upgrade', toNodeUpgradeHandler(gateway));
  const { port } = await listen(host);

  return { upstream, origin, port };
}

/** Drives a signed-in upgrade through the gateway and returns what the endpoint received. */
async function upgradeThrough(options: Omit<GatewayOptions, 'registry'> = {}) {
  const { upstream, origin, port } = await mountGateway(options);

  const result = await attemptUpgrade(port, '/__braid/frag/billing/ws', signedIn);
  expect(upstream.seenHeaders).toHaveLength(1);
  return { ...result, sent: upstream.seenHeaders[0], endpointHost: new URL(origin).host };
}

describe('websocket upgrade credentials', () => {
  it('does not forward the caller cookie or authorization by default', async () => {
    const { head, echo, sent, endpointHost } = await upgradeThrough();

    expect(sent.cookie).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
    // the handshake headers survived the rebuild
    expect(head).toContain('101 Switching Protocols');
    expect(echo).toBe('PING');
    expect(sent.host).toBe(endpointHost);
  });

  it('forwards them when forwardCredentials is set', async () => {
    const { sent } = await upgradeThrough({ forwardCredentials: true });

    expect(sent.cookie).toBe('session=a-real-session-value; theme=dark');
    expect(sent.authorization).toBe('Bearer a-token-for-the-shell');
  });

  it('applies additionalHeaders after the strip, so a host can supply its own authorization', async () => {
    const { sent } = await upgradeThrough({
      additionalHeaders: () => ({ 'x-caller': 'alice', authorization: 'Bearer scoped' }),
    });

    expect(sent['x-caller']).toBe('alice');
    expect(sent.authorization).toBe('Bearer scoped');
    expect(sent.cookie).toBeUndefined();
  });

  it('hands additionalHeaders the original upgrade request, credentials intact', async () => {
    // the point of the hook: derive an endpoint credential from the caller's own session
    const { sent } = await upgradeThrough({
      additionalHeaders: (request) => ({
        authorization: `Bearer for-${/session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]}`,
      }),
    });

    expect(sent.authorization).toBe('Bearer for-a-real-session-value');
    expect(sent.cookie).toBeUndefined();
  });

  it('fails closed when additionalHeaders throws: the socket is destroyed and the endpoint is never dialed', async () => {
    const { upstream, port } = await mountGateway({
      additionalHeaders: () => {
        throw new Error('token service down');
      },
    });

    await expect(attemptUpgrade(port, '/__braid/frag/billing/ws', signedIn)).rejects.toThrow(/socket closed/);
    expect(upstream.seenHeaders).toHaveLength(0);
  });
});
