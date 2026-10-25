import { defineFragment } from '@braidlabs/core';
import { SEAMS_KEY, frame } from './frame';

/**
 * Registers one homepage section as a contract fragment.
 *
 * It runs in its own blob-booted realm, asks the host for nothing but a place to draw and the seams
 * setting, and refuses to mount on a host older than the contract it was written against.
 */
export function defineSection(markup: string): void {
  defineFragment({
    // What these sections were written against, not whatever the host is today: a host that bumps
    // its contract must not silently raise every fragment's requirement with it.
    contract: { version: '1.0.0', requires: { host: '>=1.0.0' } },
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
