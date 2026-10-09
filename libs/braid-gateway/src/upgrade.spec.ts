import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from './gateway.js';
import { toNodeUpgradeHandler } from './node.js';
import { attemptUpgrade, closeAll, hostServer, listen, upstreamWithSockets } from './upgrade.helpers.js';

/**
 * Websocket pass-through, tested against a real socket handshake rather than a mock.
 *
 * This is what keeps a fragment's dev-server live reload working when the fragment is reached
 * through the gateway, so the test drives an actual upgrade and echoes bytes both ways.
 */

afterEach(closeAll);

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
