import { initBraid } from '@braidlabs/core';
import { A2UI_DEFAULT_CSS, defineA2uiSurface } from '@braidlabs/sdui/web';
import catalog from '../content/catalog.json';
import { registry } from './registry.js';

/**
 * The Concierge host app. It has a design of its own — `host.css` — and A2UI surfaces are drawn
 * into it, not beside it: in light DOM, so its styles apply, and with two of the agent's component
 * types drawn by the host's own element and by another team's fragment.
 */

/** The host's own panel, used on every screen of the app — and now for the agent's cards too. */
class ConciergeCard extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 18px;
        padding: 1.25rem; box-shadow: 0 10px 30px -18px rgba(8, 27, 33, .5); }
      .mark { font: 600 .7rem/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--thread); }
    `;
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.part = 'mark';
    mark.textContent = 'Concierge';
    const slot = document.createElement('slot');
    slot.name = 'child';
    root.append(style, mark, slot);
  }
}
customElements.define('concierge-card', ConciergeCard);

// The starting styles sit at zero specificity under the host's own, which win.
const defaults = document.createElement('style');
defaults.textContent = A2UI_DEFAULT_CSS;
document.head.prepend(defaults);

// Braid's runtime, for the flights team's fragment; then the renderer.
initBraid();
// Media loads by itself, so it is a way out for data: the app names the hosts it loads from.
defineA2uiSurface({
  registry,
  catalog,
  urlPolicy: { mediaHosts: ['images.unsplash.com'] },
});

// For whoever is looking: what the surfaces say back.
const log = document.querySelector('#traffic');
document.addEventListener('a2ui:message', (event) => {
  const message = event.detail;
  const sent = (window.__a2uiSent ??= []);
  sent.push(message);
  if (sent.length > 1_000) sent.splice(0, sent.length - 1_000);
  if (!log) return;
  const line = document.createElement('li');
  line.textContent = message.action
    ? `action ${message.action.name} from ${message.action.sourceComponentId}`
    : `error ${message.error?.code}: ${message.error?.message}`;
  log.prepend(line);
  // a log for a person: the last few lines, not every message a long session sends
  while (log.childElementCount > 50) log.lastElementChild.remove();
});
document.documentElement.dataset.ready = '';
