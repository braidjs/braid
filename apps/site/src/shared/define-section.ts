import { defineFragment } from '@braidlabs/core';
import { HOST_CONTRACT_VERSION, SEAMS_KEY, frame } from './frame';

/**
 * Registers one homepage section as a contract fragment.
 *
 * It runs in its own blob-booted realm, asks the host for nothing but a place to draw and the seams
 * setting, and refuses to mount on a host older than the contract it was written against.
 */
export function defineSection(markup: string): void {
  defineFragment({
    contract: { version: '1.0.0', requires: { host: `>=${HOST_CONTRACT_VERSION}` } },
    mount(env) {
      env.root.innerHTML = frame(markup);
      const frag = env.root.querySelector('.frag');
      // Replays the host's current value at once, then follows every change.
      env.context.subscribe(SEAMS_KEY, (on) => frag?.toggleAttribute('data-seams', on !== false), {
        signal: env.signal,
      });
    },
  });
}
