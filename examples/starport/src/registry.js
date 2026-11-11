/**
 * The five apps: where each is, and which intents and contexts it deals in. The worker's gateway
 * reads it to know what a fragment is; the desk reads it for the dock and the App Directory.
 * Nothing else on the desk knows the apps.
 */
const SHIP = ['starport.ship'];

export const APPS = [
  {
    id: 'flights',
    title: 'Flights',
    glyph: '🛫',
    fdc3: { raises: { PlotRoute: SHIP, HailShip: SHIP }, userChannels: { broadcasts: SHIP } },
  },
  {
    id: 'star-map',
    title: 'Star Map',
    glyph: '🌌',
    fdc3: { listensFor: { PlotRoute: { contexts: SHIP } }, userChannels: { listensFor: SHIP } },
  },
  {
    id: 'radar',
    title: 'Radar',
    glyph: '📡',
    fdc3: { listensFor: { PlotRoute: { contexts: SHIP } }, userChannels: { listensFor: SHIP } },
  },
  { id: 'cargo', title: 'Cargo', glyph: '📦', fdc3: { userChannels: { listensFor: SHIP } } },
  { id: 'comms', title: 'Comms', glyph: '🛰️', fdc3: { listensFor: { HailShip: { contexts: SHIP } } } },
];

/** The folder the desk is served from (`/starport/`, or `/`), given any URL inside its root. */
export const baseOf = (url) => new URL('.', url).pathname;
/** That folder as Braid's `basePath`: no trailing slash, and nothing at all at the root. */
export const basePathOf = (base) => base.replace(/\/$/, '') || undefined;
