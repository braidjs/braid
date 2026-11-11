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
 * Both are partitioned by the folder the desk is served from, as the ship relay is, so another
 * deployment on this origin is not on the same channels. An app's realm sees the page's location,
 * so it is the desk's folder there too, and in a popped-out window, the same page under `?app=`.
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

/** A departed list, as the traffic log says it. */
export const departedText = (state) => {
  const count = state?.departed?.length ?? 0;
  return `state: ${count} departed${count ? ` (${state.departed.join(', ')})` : ''}`;
};
