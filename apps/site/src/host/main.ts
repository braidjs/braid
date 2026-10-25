import { braidContext, initBraid } from '@braidlabs/core';
import { HOST_CONTRACT_VERSION, SEAMS_KEY } from '../shared/frame';

/**
 * The host runtime: everything the page itself runs. It owns no section's code; it declares its
 * contract, publishes one shared setting, and lets `<fragment-slot>` boot each section into a blob
 * realm of its own.
 */

const seamsToggle = document.getElementById('seams-toggle');

/** "Show the seams": outlines every section as the separate app it is. */
function setSeams(on: boolean): void {
  document.body.toggleAttribute('data-seams', on);
  // The prerendered copies sit in shadow roots the page's CSS cannot reach, so they are told directly.
  for (const copy of document.querySelectorAll('.ssr')) {
    copy.shadowRoot?.querySelector('.frag')?.toggleAttribute('data-seams', on);
  }
  // The live fragments hear it over the context bus, from inside their own realms.
  braidContext.set(SEAMS_KEY, on);
  if (seamsToggle) {
    seamsToggle.setAttribute('aria-pressed', String(on));
    seamsToggle.textContent = on ? 'Hide the seams' : 'Show the seams';
  }
}

// Published before any slot boots, so every fragment's first read already has it.
setSeams(document.body.hasAttribute('data-seams'));
seamsToggle?.addEventListener('click', () => setSeams(!document.body.hasAttribute('data-seams')));

initBraid({ contract: { version: HOST_CONTRACT_VERSION } });

const copyButton = document.getElementById('copy-install');
const copyLabel = copyButton?.querySelector('[data-copy-label]');
let copyReset: ReturnType<typeof setTimeout> | undefined;
copyButton?.addEventListener('click', async () => {
  if (!copyLabel) return;
  try {
    await navigator.clipboard.writeText('npm i @braidlabs/core');
    copyLabel.textContent = 'Copied';
  } catch {
    copyLabel.textContent = 'Couldn’t copy';
  }
  clearTimeout(copyReset);
  copyReset = setTimeout(() => (copyLabel.textContent = 'Copy'), 1600);
});
