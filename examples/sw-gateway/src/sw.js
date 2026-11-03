// The whole gateway, in the worker. Nothing on the server knows Braid exists.
import { setupBraidGateway } from '@braidlabs/sw/gateway';

setupBraidGateway({
  mode: 'production',
  registry: [
    {
      id: 'billing',
      // same origin, so the worker's fetch needs no CORS and carries the browser's own cookies
      endpoint: new URL('/billing-app/', self.location.origin).href,
      pierce: ['/billing', '/billing/*'],
    },
  ],
  // the page that installs the worker composes without a reload
  claimClients: true,
  // and fragment chunks survive a deploy, as they would behind a server gateway
  assets: {},
});
