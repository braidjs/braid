import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';
import { createWorkspace, localStorageStore } from '@braidlabs/console/workspace';
import { acceptPopOut, arrange } from '@braidlabs/console/tiles';
import { createEventBus } from '@braidlabs/data';
import { APPS, baseOf, basePathOf } from './registry.js';
import { departedOf, starportBus } from './traffic.js';

/**
 * The desk's whole runtime. The workspace is the `[data-braid-workspace]` element in index.html;
 * everything the user keeps (layouts, app settings, preferences) goes to localStorage.
 */

const $ = (selector) => document.querySelector(selector);
const app = (id) => APPS.find((known) => known.id === id);
function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
/** Says something passing in the desk's notice line, for a few seconds. */
let noticeTimer;
function notice(message) {
  $('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($('#notice').textContent = ''), 6000);
}

// ── One desk, or one app in a window of its own ──────────────────────────────────────────────
// `?app=star-map` is the same page holding one app: what a tile becomes when it is popped out.
const query = new URLSearchParams(location.search);
const solo = APPS.some(({ id }) => id === query.get('app')) ? query.get('app') : undefined;
const handoff = solo ? query.get('handoff') : null;
if (solo) {
  document.body.dataset.solo = '';
  document.title = `${APPS.find(({ id }) => id === solo).title} — Starport`;
  // the desk's starting apps are not this window's; removed before Braid starts, they never boot
  for (const slot of document.querySelectorAll('[data-braid-workspace] > fragment-slot')) slot.remove();
}

/** Says what went wrong, in the desk's status line. It stays until the page is reloaded. */
let failed = false;
function report(message) {
  failed = true;
  $('#empty').textContent = message;
  $('#empty').hidden = false;
}

// ── The gateway is a service worker ──────────────────────────────────────────────────────────
// Until the worker controls this page nothing answers /__braid/: the server only has files. So
// Braid starts once a controller exists. On a first visit that is a moment after the page paints.
const base = baseOf(import.meta.url);
async function controlled() {
  if (navigator.serviceWorker.controller) return;
  const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });
  // a hard reload loads the page past an active worker, which does not claim a page unasked
  registration.active?.postMessage({ type: 'braid-sw:claim' });
  // a worker that fails to install never takes control; say so rather than wait for ever
  const gaveUp = new Promise((_, reject) => setTimeout(() => reject(new Error('the worker did not take control')), 15_000));
  await Promise.race([changed, gaveUp]);
}

// Other pages may share this origin (the desk is hosted beside the docs), and localStorage is per
// origin. The desk's folder in the prefix keeps its layouts and preferences its own.
const workspace = createWorkspace({ store: localStorageStore({ prefix: `braid.workspace${base}` }) });

// ── Choosing an app for an intent ────────────────────────────────────────────────────────────
// The agent asks this only when several apps could take a raise. The workspace wraps it: a
// remembered choice answers without asking, and `remember: true` is kept for next time.
//
// `dialogResolver` from @braidlabs/fdc3 does all of this, in a shadow root the page's styles do
// not reach. This one is the desk's own so it can wear the desk's theme; it assumes one intent
// per raise, which is all Starport's apps do.
function chooser({ candidates, context }) {
  return new Promise((resolve) => {
    const dialog = $('#chooser');
    let answer;
    $('#chooser-what').textContent = `${candidates[0].intent} · ${context?.name ?? context?.type ?? ''}`;
    $('#chooser-remember').checked = false;
    $('#chooser-list').replaceChildren(
      ...candidates.map((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.app = candidate.appId;
        button.autofocus = index === 0;
        const glyph = element('span', 'glyph', app(candidate.appId)?.glyph ?? '✨');
        glyph.setAttribute('aria-hidden', 'true');
        const state = candidate.instanceId ? 'open' : candidate.starting ? 'starting' : 'will launch';
        button.append(glyph, element('span', 'name', candidate.title), element('span', 'state', state));
        button.onclick = () => {
          answer = { candidate, remember: $('#chooser-remember').checked };
          dialog.close();
        };
        return button;
      }),
    );
    // Escape and Cancel close it with no answer, which cancels the raise
    dialog.addEventListener('close', () => resolve(answer), { once: true });
    dialog.showModal();
  });
}
$('#chooser-cancel').onclick = () => $('#chooser').close();

// ── The agent, and Braid ─────────────────────────────────────────────────────────────────────
// The agent resolves intents against FDC3 App Directory records. A gateway can serve them from
// its registry (`discovery: { appd: true }`), but not yet under a basePath, so the desk writes
// the records itself from the same registry the worker uses. These are the members the agent
// reads; a gateway's own records carry more.
// The desk itself is in the directory too, though nothing ever mounts it: it is how the desk gets an
// fdc3 of its own, to carry the selected ship between windows (see "Between windows" below).
const DESK = { id: 'desk', title: 'Desk', fdc3: { userChannels: { broadcasts: ['starport.ship'], listensFor: ['starport.ship'] } } };
const directory = [...APPS, DESK].map(({ id, title, fdc3 }) => ({
  appId: id,
  title,
  type: 'web',
  details: { url: new URL(`${base}apps/${id}/`, location.origin).href },
  interop: {
    intents: { ...(fdc3.listensFor ? { listensFor: fdc3.listensFor } : {}), ...(fdc3.raises ? { raises: fdc3.raises } : {}) },
    ...(fdc3.userChannels ? { userChannels: fdc3.userChannels } : {}),
  },
}));

const onDesk = workspace.fdc3(chooser);
const agent = createBraidDesktopAgent({
  directory,
  ...onDesk,
  // the workspace has stored a remembered choice by the time its resolver answers
  resolveIntent: (request) => onDesk.resolveIntent(request).finally(() => showRemembered().catch(() => undefined)),
});

// Every app joins the same channel before its code runs, so a ship picked in one is seen in all.
// setHost replaces the preferences, so whatever else is there is carried over.
let preferences = await workspace.preferences.getHost();
if (!preferences.defaultUserChannel) {
  preferences = { ...preferences, defaultUserChannel: 'fdc3.channel.1' };
  await workspace.preferences.setHost(preferences);
}

controlled().then(
  () => {
    initBraid({ basePath: basePathOf(base), realmGlobals: workspace.realmGlobals(agent.realmGlobals) });
    if (solo) void openSolo();
    // the desk is wired and Braid has started; each app is ready when its own content says so
    document.documentElement.dataset.ready = '';
  },
  () => report("The service worker could not start, and it is this desk's gateway. Starport needs a browser with service workers, over https or on localhost."),
);

// ── The dock: launch an app, see what is open, close it ──────────────────────────────────────
// Closing an app is removing its slot; the workspace and the agent see it go.
const desk = workspace.container;
const slotsOf = (id) => [...desk.querySelectorAll(`:scope > fragment-slot[name="${id}"]`)];
for (const { id, title, glyph: icon } of APPS) {
  const entry = element('span', 'entry');
  entry.dataset.app = id;
  const launch = element('button', 'launch');
  launch.type = 'button';
  const glyph = element('span', 'glyph', icon);
  glyph.setAttribute('aria-hidden', 'true');
  launch.append(glyph, element('span', 'title', title), element('span', 'count'));
  launch.onclick = () => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    workspace.open(id).scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  };
  const close = element('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', `Close ${title}`);
  close.onclick = () => {
    slotsOf(id).at(-1)?.remove();
    launch.focus();
  };
  entry.append(launch, close);
  $('#dock').append(entry);
}

function showOpen() {
  let open = 0;
  for (const entry of $('#dock').children) {
    const id = entry.dataset.app;
    const count = slotsOf(id).length;
    open += count;
    entry.classList.toggle('running', count > 0);
    entry.querySelector('.count').textContent = count > 1 ? String(count) : '';
    entry.querySelector('.close').hidden = count === 0;
    entry.querySelector('.launch').setAttribute('aria-label', count ? `Launch another ${app(id).title} (${count} open)` : `Launch ${app(id).title}`);
  }
  if (!failed) $('#empty').hidden = open > 0;
}
new MutationObserver(showOpen).observe(desk, { childList: true });
showOpen();

// ── Tiles: move, resize, pop out, and show the seams ─────────────────────────────────────────
// All of it is @braidlabs/console/tiles: a header on each app, drag or Alt+arrows to move, the
// edges or Shift+Alt+arrows to resize, and popping out to a window of its own. The desk adds only
// the seam line, and its own look (shell.css).
const POP_KEY = `starport${base}`;
const tiles = arrange(workspace, {
  title: (id) => app(id)?.title ?? id,
  glyph: (id) => app(id)?.glyph ?? '✨',
  maxColumns: 3,
  maxRows: 3,
  // a tile with no height of its own spans two rows (see shell.css)
  defaultRows: 2,
  // the popped-out window is this page, holding one app; there, nothing pops out again
  popOut: solo
    ? undefined
    : {
        key: POP_KEY,
        url: (id, handoff) => `${base}?app=${encodeURIComponent(id)}${handoff ? `&handoff=${handoff}` : ''}`,
        onPoppedOut: (id) => notice(`${app(id).title} is in its own window. Close that window to bring it back.`),
        onBlocked: (id) => notice(`The browser kept ${app(id).title} from opening a window, so it stays on the desk.`),
        onReturned: (slot, id) => {
          slot.scrollIntoView({ block: 'nearest' });
          notice(`${app(id).title} is back on the desk.`);
        },
      },
  // with the seams shown, each tile says what it is: its element, its state, its realm, its URL
  describe(slot, head) {
    const id = slot.getAttribute('name');
    let seam = head.querySelector('.seam');
    if (!seam) {
      seam = element('code', 'seam');
      head.append(seam);
    }
    seam.textContent = `<fragment-slot name="${id}">  ·  ${slot.getAttribute('state') ?? 'loading'}  ·  own realm  ·  ${base}__braid/frag/${id}/`;
  },
  // the last tile closed: focus goes to the dock, where the user can open one again
  onClose: (id) => {
    if (!desk.querySelector(':scope > fragment-slot')) $(`#dock [data-app="${id}"] .launch`)?.focus();
  },
});
$('#seams-toggle').addEventListener('click', () => {
  const on = !document.body.hasAttribute('data-seams');
  document.body.toggleAttribute('data-seams', on);
  tiles.refresh();
  $('#seams-toggle').setAttribute('aria-pressed', String(on));
});

// ── Between windows ──────────────────────────────────────────────────────────────────────────
// A popped-out app takes its state with it and comes back with its latest state when its window
// closes (@braidlabs/console/tiles, above and in openSolo below). It also follows the ship picked
// on the desk, which is the desk's own doing:
//
// Each window has its own FDC3 agent, so a channel does not reach across them by itself. The desk
// asks its agent for an fdc3 of its own (the `desk` record above) and relays the selected ship to
// every other window of this origin over a @braidlabs/data channel, which each relays into its own
// agent's channel. A broadcast does not come back to the one who sent it, and the last ship relayed
// is not relayed again, so nothing echoes.
/** A ship as Flights sends it; anything else on the relay is not passed on to the apps. */
const isShip = (ship) => ship?.type === 'starport.ship' && typeof ship.name === 'string' && typeof ship.id?.registry === 'string';

async function relayShips() {
  // A workaround, until @braidlabs/fdc3 gives a host page an fdc3 of its own: the agent's hook for
  // a fragment, called for a directory record no slot will ever mount. Its signal never aborts,
  // because the desk lives as long as the page.
  const hostFdc3 = (await agent.realmGlobals({ fragmentId: DESK.id, signal: new AbortController().signal }))?.fdc3;
  if (!hostFdc3) return;
  await hostFdc3.joinUserChannel(preferences.defaultUserChannel ?? 'fdc3.channel.1').catch(() => undefined);
  // partitioned by the desk's folder, so another deployment on this origin is not on the same channel
  const between = createEventBus({ consumer: solo ? `window:${solo}` : 'desk', partition: () => `starport${base}` }).channel('starport.ship', {
    scope: 'origin',
  });
  let relayed;
  const seen = (ship) => (ship.id.registry === relayed ? false : ((relayed = ship.id.registry), true));
  // the relay says what it passes on, for the desk's Traffic panel
  const { report } = starportBus('relay');
  await hostFdc3.addContextListener('starport.ship', (ship) => {
    if (!isShip(ship) || !seen(ship)) return;
    report('write', 'starport.ship', `ship: ${ship.name}`);
    between.broadcast(ship);
  });
  between.subscribe((ship) => {
    if (!isShip(ship) || !seen(ship)) return;
    report('read', 'starport.ship', `ship: ${ship.name}`);
    hostFdc3.broadcast(ship);
  });
}
relayShips().catch((error) => console.warn('starport: the ship relay between windows did not start', error));

/** In a popped-out window: the app, with the state it left the desk with; it goes back when the window closes. */
async function openSolo() {
  const { fromDesk, dockBack } = await acceptPopOut(workspace, { key: POP_KEY, appId: solo, handoff });
  // a copy opened in a tab: nothing to return to
  if (!fromDesk) return void ($('#back').hidden = true);
  $('#back').addEventListener('click', () => void dockBack());
}

// ── Layouts ──────────────────────────────────────────────────────────────────────────────────
async function showLayouts() {
  const names = (await workspace.layouts.list()).sort();
  $('#layouts').replaceChildren(
    ...names.map((name) => {
      const item = document.createElement('li');
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.dataset.restore = name;
      restore.textContent = name;
      // a layout deleted in another tab is no longer there to restore
      restore.onclick = () => workspace.layouts.restore(name).catch(showLayouts);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'x';
      remove.setAttribute('aria-label', `Delete layout ${name}`);
      remove.textContent = '×';
      remove.onclick = () => workspace.layouts.delete(name).then(showLayouts, showLayouts);
      item.append(restore, remove);
      return item;
    }),
  );
}
$('#save-layout').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#layout-name');
  const name = input.value.trim();
  if (!name) return;
  // saving under a name that exists replaces that layout
  await workspace.layouts.save(name).then(() => (input.value = ''), () => report('That layout could not be saved.'));
  await showLayouts();
});
await showLayouts();

// ── The remembered choice, and forgetting it ─────────────────────────────────────────────────
async function showRemembered() {
  // a remembered app that is now hidden is not used, so it is not announced either
  const remembered = await workspace.preferences.intentChoice('PlotRoute', 'starport.ship');
  const choice = preferences.hiddenApps?.includes(remembered) ? undefined : remembered;
  $('#remembered').hidden = !choice;
  $('#remembered-app').textContent = app(choice)?.title ?? choice ?? '';
}
$('#forget').onclick = async () => {
  await workspace.preferences.forgetIntentChoice('PlotRoute', 'starport.ship');
  await showRemembered();
};
await showRemembered();

// ── Preferences: apps the chooser never offers ───────────────────────────────────────────────
// `hiddenApps` governs the choice, not delivery: hide Radar and Plot route goes straight to Star
// Map, the one app left that can take it.
const takers = APPS.filter(({ fdc3 }) => fdc3.listensFor?.PlotRoute);
$('#hidden-apps').replaceChildren(
  ...takers.map(({ id, title }) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.hide = id;
    box.checked = preferences.hiddenApps?.includes(id) ?? false;
    box.onchange = async () => {
      const hiddenApps = takers.map((taker) => taker.id).filter((taker) => $(`[data-hide="${taker}"]`).checked);
      preferences = { ...preferences, hiddenApps };
      await workspace.preferences.setHost(preferences);
      keepOneTaker();
      await showRemembered();
      $('#hidden-apps').dataset.saved = hiddenApps.join(',');
    };
    label.append(box, ` ${title}`);
    return label;
  }),
);

// with every taker hidden a raise would be cancelled, so the last one cannot be ticked
function keepOneTaker() {
  const boxes = [...$('#hidden-apps').querySelectorAll('input')];
  const shown = boxes.filter((box) => !box.checked);
  for (const box of boxes) box.disabled = shown.length === 1 && box === shown[0];
}
keepOneTaker();

// ── The tower's event bus ────────────────────────────────────────────────────────────────────
// Not everything is a selection or a request. "A ship departed" is an event: whoever is listening
// hears it once, and nobody is asked to act. Flights emits it on a @braidlabs/data channel; the
// desk and Comms listen. The channel's state half carries the running count, which a late
// listener does get. It reaches every window of this origin, so a popped-out app is on it too.
//
// The Traffic panel shows what crosses: everyone on the bus reports what it writes and reads to
// `starport.traffic`, from the desk, its apps, and every popped-out window. A popped-out window
// reports; only the desk shows the log.
if (!solo) {
  const { tower, traffic, report } = starportBus('desk');
  tower.addEventListener('ship.departed', ({ payload, source }) => {
    report('read', 'tower', `event: ship.departed (${payload.name}, from ${source})`);
    $('#ticker-event').textContent = `${payload.name} departed for ${payload.to}`;
  });
  tower.subscribe((state) => {
    const departures = departedOf(state).length;
    if (state !== undefined) report('read', 'tower', `state: ${departures} departed`);
    $('#ticker-count').textContent = `${departures} ${departures === 1 ? 'departure' : 'departures'} today`;
  });

  const MAX_LINES = 60;
  // what any page of this origin may send: kept short, so a flood of long lines stays cheap
  const clip = (value) => String(value).slice(0, 160);
  const lines = $('#traffic-lines');
  traffic.addEventListener('crossing', ({ payload, at }) => {
    if (!['write', 'read'].includes(payload?.kind)) return;
    const line = document.createElement('li');
    line.className = payload.kind;
    line.dataset.kind = payload.kind;
    line.dataset.where = clip(payload.where);
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return;
    line.dataset.at = String(when.getTime());
    const time = element('time', 'at', when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    time.dateTime = when.toISOString();
    line.append(
      time,
      element('span', 'kind', payload.kind),
      element('span', 'who', clip(`${payload.app} · ${payload.where}`)),
      element('span', 'channel', clip(payload.channel)),
      element('span', 'what', clip(payload.what)),
    );
    // newest first, by when each was sent: reports travel on their own channel, so a read can
    // arrive before the write it followed
    const later = [...lines.children].find((other) => Number(other.dataset.at) <= when.getTime());
    lines.insertBefore(line, later ?? null);
    while (lines.children.length > MAX_LINES) lines.lastElementChild.remove();
    $('#traffic-empty').hidden = true;
  });
  $('#traffic-clear').addEventListener('click', () => {
    lines.replaceChildren();
    $('#traffic-empty').hidden = false;
  });
  $('#traffic-toggle').addEventListener('click', () => {
    const on = $('#traffic').hidden;
    $('#traffic').hidden = !on;
    $('#traffic-toggle').setAttribute('aria-expanded', String(on));
  });
}

// ── Boundaries: what the desk and the apps do not share ──────────────────────────────────────
// Checked when the panel opens, against the page as it is, not asserted.
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
function checkBoundaries() {
  const slots = [...desk.querySelectorAll(':scope > fragment-slot')];
  const inApps = (selector) => slots.filter((slot) => slot.shadowRoot?.querySelector(selector)).length;
  const hiddenByDesk = slots.filter((slot) => {
    const root = slot.shadowRoot?.querySelector('.app');
    return root && getComputedStyle(root).display === 'none';
  }).length;
  // each app's realm is a frame of this page: same origin, so the desk can look, and does here
  const realmsWithShips = Array.from({ length: window.frames.length }, (_, index) => window.frames[index]).filter((realm) => {
    try {
      return Array.isArray(realm.SHIPS);
    } catch {
      return false;
    }
  }).length;
  const facts = [
    [
      realmsWithShips > 0 && typeof globalThis.SHIPS === 'undefined',
      'Globals',
      `Flights keeps its ships in a global, window.SHIPS. ${plural(realmsWithShips, 'realm on this page has', 'realms on this page have')} one. The desk's own window has ${typeof globalThis.SHIPS === 'undefined' ? 'none' : 'one too'}: each app runs in its own realm.`,
    ],
    [
      document.getElementById('status') === null && inApps('#status') > 0,
      'Element ids',
      `${plural(inApps('#status'), 'open app has', 'open apps each have')} an element with id="status". The desk's document.getElementById('status') finds ${document.getElementById('status') ? 'one of them' : 'nothing'}: each app's markup is in its own shadow root.`,
    ],
    [
      inApps('.app') > 0 && hiddenByDesk === 0,
      'Styles',
      `The desk's stylesheet says .app { display: none }. ${plural(inApps('.app'), 'open app uses', 'open apps use')} class="app", and ${hiddenByDesk} of them ${hiddenByDesk === 1 ? 'is' : 'are'} hidden by it.`,
    ],
  ];
  $('#boundary-facts').replaceChildren(
    ...facts.map(([holds, name, detail]) => {
      const item = element('li', holds ? 'holds' : 'broken');
      item.dataset.holds = String(holds);
      item.append(element('b', '', `${name}: ${holds ? 'holds' : 'broken'}`), element('span', '', detail));
      return item;
    }),
  );
}
for (const [button, dialog, before] of [
  ['#open-boundaries', '#boundaries', checkBoundaries],
  ['#open-preferences', '#preferences'],
]) {
  $(button).onclick = () => {
    before?.();
    $(dialog).showModal();
    // focus lands on Done, at the foot; on a short screen that would open the panel scrolled past its start
    $(dialog).scrollTop = 0;
  };
  $(`${dialog} .done`).onclick = () => $(dialog).close();
}


