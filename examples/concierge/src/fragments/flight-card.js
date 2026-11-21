import { defineFragment } from '@braidlabs/core';

/**
 * The flights team's card: an independently built and deployed fragment. The concierge's agent
 * names it as an A2UI component (`FlightCard`); the host's renderer mounts it here, in a realm of
 * its own, and hands it the component's props. Choosing the flight is an event the renderer turns
 * into the A2UI action the agent attached to the card.
 */
defineFragment({
  contract: { version: '1.0.0' },
  mount(env) {
    const doc = env.root.ownerDocument;
    const style = doc.createElement('style');
    style.textContent = `
      .flight { display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; padding: .75rem 1rem;
        border-radius: 12px; background: linear-gradient(135deg, #0b3b4a, #0f766e); color: #ecfeff; }
      .number { font: 600 1.25rem/1.2 ui-monospace, monospace; letter-spacing: .04em; }
      .meta { opacity: .85; font-size: .9rem; }
      button { grid-row: span 2; align-self: center; border: 0; border-radius: 999px; padding: .5rem 1rem;
        background: #fbbf24; color: #1c1917; font-weight: 600; cursor: pointer; }
    `;
    env.document.appendToHead(style);
    const card = doc.createElement('div');
    card.className = 'flight';
    const number = doc.createElement('span');
    number.className = 'number';
    const meta = doc.createElement('span');
    meta.className = 'meta';
    const choose = doc.createElement('button');
    choose.type = 'button';
    choose.textContent = 'Choose this flight';
    choose.addEventListener('click', () =>
      env.emit('select', { flight: env.props.flight, at: 'flight-card' }),
    );
    card.append(number, choose, meta);
    env.root.append(card);

    const render = (props) => {
      number.textContent = String(props.flight ?? '');
      meta.textContent = [props.status, props.gate && `Gate ${props.gate}`]
        .filter(Boolean)
        .join(' · ');
      card.dataset.flight = String(props.flight ?? '');
    };
    render(env.props);
    env.onPropsChanged(render);
    env.settled();
  },
});
