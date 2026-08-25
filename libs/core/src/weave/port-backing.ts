import { Envelope, isEnvelope } from './envelope.js';
import { ChannelBacking } from './channel.js';

/**
 * The cross-origin transport: one `MessagePort`, structured clone, nothing else.
 *
 * Nothing here is used by the trusted tier — it exists now, and is tested now, so that Phase 5 is
 * the act of *choosing* this backing rather than the act of inventing it. A transport written after
 * the protocol has shipped is a transport that inherits every same-origin assumption the protocol
 * accumulated in the meantime.
 *
 * Two rules this backing enforces that the same-realm one gets for free:
 *
 * 1. **Everything inbound is untrusted.** A port is reachable by whatever holds the other end.
 *    Malformed messages are dropped silently — an untrusted peer must not be able to fill the
 *    host's console by posting garbage in a loop.
 * 2. **Nothing unclonable goes out.** `postMessage` throws `DataCloneError` on a function or a DOM
 *    node, and the throw surfaces at the *sender*, far from whoever put the value in the payload.
 *    Converting it here names the offending message type while that context still exists.
 */
export function createPortBacking(port: MessagePort): ChannelBacking {
  let closed = false;

  return {
    post(envelope: Envelope) {
      if (closed) return;
      try {
        port.postMessage(envelope);
      } catch (error) {
        throw new Error(
          `braid: a "${envelope.type}" payload could not cross the boundary — ` +
            `values sent to a cross-origin fragment must be structured-cloneable ` +
            `(no functions, DOM nodes, or class instances with methods)`,
          { cause: error },
        );
      }
    },

    receive(handler) {
      const listener = (event: MessageEvent) => {
        if (closed) return;
        if (!isEnvelope(event.data)) return;
        handler(event.data);
      };
      port.addEventListener('message', listener);
      port.start();
      return () => port.removeEventListener('message', listener);
    },

    close() {
      if (closed) return;
      closed = true;
      port.close();
    },
  };
}
