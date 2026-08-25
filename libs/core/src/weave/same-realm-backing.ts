import { Envelope } from './envelope.js';
import { ChannelBacking } from './channel.js';

/**
 * The trusted-tier transport: a linked pair of backings that hand envelopes straight to each other.
 *
 * No serialization, no `postMessage`, no clone — a same-origin realm shares a heap with its host, so
 * paying for a structured clone at this layer would be a cost with no buyer. Clone discipline lives
 * one level up, where the *bus* decides what a fragment is allowed to keep a reference to.
 *
 * **Delivery is asynchronous anyway, and that is the whole design.** Dispatching synchronously would
 * be faster and would make this backing behave differently from `port-backing` in the one way that
 * matters most: reentrancy. A synchronous backing lets a handler observe a send completing before
 * its own frame returns, so code written against it works on the trusted tier and deadlocks or
 * reorders on the untrusted one — a bug that would only surface in Phase 5, in a fragment nobody
 * has the source of. Queuing a microtask costs nothing measurable and makes the two transports
 * behave identically.
 */
export interface SameRealmBackingPair {
  host: ChannelBacking;
  fragment: ChannelBacking;
}

export function createSameRealmBackingPair(): SameRealmBackingPair {
  let hostHandler: ((envelope: Envelope) => void) | undefined;
  let fragmentHandler: ((envelope: Envelope) => void) | undefined;
  let closed = false;

  const deliver = (to: () => ((envelope: Envelope) => void) | undefined, envelope: Envelope) => {
    if (closed) return;
    queueMicrotask(() => {
      if (closed) return;
      to()?.(envelope);
    });
  };

  const closeBoth = () => {
    closed = true;
    hostHandler = undefined;
    fragmentHandler = undefined;
  };

  return {
    host: {
      post: (envelope) => deliver(() => fragmentHandler, envelope),
      receive(handler) {
        hostHandler = handler;
        return () => {
          if (hostHandler === handler) hostHandler = undefined;
        };
      },
      close: closeBoth,
    },
    fragment: {
      post: (envelope) => deliver(() => hostHandler, envelope),
      receive(handler) {
        fragmentHandler = handler;
        return () => {
          if (fragmentHandler === handler) fragmentHandler = undefined;
        };
      },
      close: closeBoth,
    },
  };
}
