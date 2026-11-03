/**
 * `@braidlabs/sw/gateway` — the Braid gateway, run inside the service worker.
 *
 * Its own entry rather than part of `@braidlabs/sw`, because it is a different decision: the main
 * entry keeps a server gateway's assets alive across deploys, and stays small enough to compose
 * into any worker. This one *is* the gateway — the whole router, rewriter, and piercing — for an
 * origin with no server to run it on. A worker that imports only the main entry never bundles it.
 */

export {
  braidGatewayHandler,
  setupBraidGateway,
  BRAID_CLAIM_MESSAGE,
} from './lib/gateway.js';
export type {
  BraidGatewayHandler,
  BraidGatewayHandlerOptions,
  BraidGatewayWorkerOptions,
} from './lib/gateway.js';
