import { createEventBus } from '@braidlabs/data';

/**
 * The buses Starport's desk, apps and popped-out windows share. A stand-in for a library the apps'
 * teams would agree on: it is bundled into each app, as such a library would be, and shares no
 * memory between them. Everything here crosses through `@braidlabs/data` channels.
 *
 * - `tower`: departures. Its state is which ships have left; its event is `ship.departed`. Scoped
 *   to the origin, so an app in a popped-out window hears it as one on the desk does.
 * - `starport.traffic`: a log of that. Whoever writes to or reads from a channel says so here, and
 *   the desk's Traffic panel shows it. The apps report their own traffic: the bus has no tap.
 *
 * Both are partitioned by the folder the page is served from, so another deployment on this
 * origin is not on the same channels (by accident: not against a hostile page). An app's realm
 * sees the page's location, so it is the desk's folder there too, and in a popped-out window, the
 * same page under `?app=`. The ship relay takes the folder from its script's URL instead; the two
 * agree wherever the desk is served at its folder with the trailing slash, as Pages and server.mjs
 * redirect it to.
 */
export const partitionOf = (path = location.pathname) => `starport${path.replace(/[^/]*$/, '')}`;

/** Where this code runs: on the desk, or in the window an app was popped out to. */
export function whereAmI() {
  const solo = new URLSearchParams(location.search).get('app');
  return solo ? `${solo} window` : 'desk';
}

/** `consumer` names who reports: an app's id, or `desk`. */
export function starportBus(consumer) {
  const bus = createEventBus({ consumer, partition: () => partitionOf() });
  const traffic = bus.channel('starport.traffic', { scope: 'origin' });
  const where = whereAmI();
  return {
    bus,
    tower: bus.channel('tower', { scope: 'origin' }),
    traffic,
    /** `kind` is `write` or `read`; `what` says what crossed, in a few words. */
    report(kind, channel, what) {
      traffic.emit('crossing', { kind, channel, what, app: consumer, where }).catch(() => undefined);
    },
  };
}

/**
 * The ships a Tower state says have left. Any page of this origin can write the channel, so what
 * arrives is cleaned before anyone reads it: anything but a list of strings is no departures.
 */
export const departedOf = (state) => (Array.isArray(state?.departed) ? state.departed.filter((id) => typeof id === 'string') : []);

/** A departed list, as the traffic log says it. */
export const departedText = (state) => {
  const departed = departedOf(state);
  return `state: ${departed.length} departed${departed.length ? ` (${departed.join(', ')})` : ''}`;
};
