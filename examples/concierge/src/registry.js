import { h } from '@braidlabs/sdui/web';

/**
 * Which of the agent's components are the host's own. Shared by the server, which prerenders with
 * it, and the browser, which renders with it — so the markup the server writes is the markup the
 * browser adopts.
 *
 * - `Card` is drawn by the host's own `<concierge-card>`, the panel every screen of this app uses.
 * - `FlightCard` is the flights team's fragment: an app of its own, built and deployed apart from
 *   this one, mounted by Braid in contract mode.
 * - `Fare` is in this app's catalog, not the basic one, so the app draws it — here as a view, which
 *   draws the same on the server and in the browser.
 */
export const registry = {
  Card: { element: 'concierge-card' },
  FlightCard: {
    fragment: { name: 'flight-card', entry: '/fragments/flight-card.js' },
    events: { select: 'select' },
  },
  Fare: (c) => {
    const amount = c.value('amount') ?? {};
    const currency =
      typeof amount.currency === 'string' && /^[A-Z]{3}$/.test(amount.currency)
        ? amount.currency
        : 'USD';
    const value =
      typeof amount.value === 'number'
        ? amount.value
        : Number(amount.value ?? 0);
    const price =
      value === 0
        ? 'Free'
        : new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
          }).format(value);
    const badge = c.text('badge');
    return h(
      'div',
      { class: 'fare' },
      h('span', { class: 'fare-label' }, c.text('label')),
      h('strong', { class: 'fare-price', 'data-currency': currency }, price),
      badge ? h('span', { class: 'fare-badge' }, badge) : null,
    );
  },
};
