import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';
import { createWorkspace, localStorageStore } from '@braidlabs/console/workspace';
import { createEventBus } from '@braidlabs/data';
import { APPS, baseOf, basePathOf } from './registry.js';
import { setupTiles } from './tiles.js';

/**
 * The desk's whole runtime. The workspace is the `[data-braid-workspace]` element in index.html;
 * everything the user keeps (layouts, app settings, preferences) goes to localStorage.
 */

const $ = (selector) => document.querySelector(selector);
const app = (id) => APPS.find((known) => known.id === id);
/** `object` without `key`. */
const without = (object, key) => Object.fromEntries(Object.entries(object ?? {}).filter(([name]) => name !== key));
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
const tiles = setupTiles({ workspace, desk, app, base, onPopOut: popOut });
$('#seams-toggle').addEventListener('click', () => {
  const on = !document.body.hasAttribute('data-seams');
  tiles.setSeams(on);
  $('#seams-toggle').setAttribute('aria-pressed', String(on));
});

// ── Between windows ──────────────────────────────────────────────────────────────────────────
// A popped-out app takes its state with it (`workspace.snapshot`), follows the ship picked on the
// desk, and comes back with its latest state when its window closes.
//
// Each window has its own FDC3 agent, so a channel does not reach across them by itself. The desk
// asks its agent for an fdc3 of its own (the `desk` record above) and relays the selected ship to
// every other window of this origin over a @braidlabs/data channel, which each relays into its own
// agent's channel. A broadcast does not come back to the one who sent it, and the last ship relayed
// is not relayed again, so nothing echoes.
const handoffKey = (id) => `starport${base}handoff/${id}`;
const dock = new BroadcastChannel(`starport${base}dock`);
/** How long a popped-out window has to take its app before the desk takes it back. */
const HANDOFF_TIMEOUT_MS = 10_000;

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
  await hostFdc3.addContextListener('starport.ship', (ship) => isShip(ship) && seen(ship) && between.broadcast(ship));
  between.subscribe((ship) => isShip(ship) && seen(ship) && hostFdc3.broadcast(ship));
}
relayShips().catch((error) => console.warn('starport: the ship relay between windows did not start', error));

/**
 * Apps this desk has popped out, by handoff id: what it needs to take each one back. Only these
 * come back, once each, and with the src, props, span and place the desk sent; the window returns
 * only the app's state and channel. Kept in this tab's sessionStorage too, so a desk that reloads
 * still takes back what it popped out before.
 */
const OUT_KEY = `starport${base}out`;
const out = new Map();
// the timer is this page's; everything else is kept
const keepOut = () =>
  sessionStorage.setItem(OUT_KEY, JSON.stringify([...out].map(([id, sent]) => [id, without(without(sent, 'timer'), 'returning')])));

/** Gives the window `id` its time to take its app; a window that has taken it gets none. */
function waitForTaking(id) {
  const sent = out.get(id);
  clearTimeout(sent.timer);
  if (!sent.taken) sent.timer = setTimeout(() => takeBack(id), HANDOFF_TIMEOUT_MS);
}

if (!solo) {
  try {
    for (const [id, sent] of JSON.parse(sessionStorage.getItem(OUT_KEY) ?? '[]')) {
      if (app(sent?.appId)) out.set(id, sent);
    }
  } catch {
    // nothing kept, or not ours to read
  }
  for (const id of out.keys()) waitForTaking(id);
}

function takeBack(id, change = {}) {
  const sent = out.get(id);
  if (!sent) return;
  out.delete(id);
  keepOut();
  clearTimeout(sent.timer);
  clearTimeout(sent.returning);
  localStorage.removeItem(handoffKey(id));
  const snapshot = { ...sent.snapshot };
  if (change.state !== undefined) snapshot.state = change.state;
  if (typeof change.channel === 'string') snapshot.channel = change.channel;
  const slot = workspace.open(sent.appId, snapshot);
  // back where it was, and the size it was
  if (Number.isInteger(sent.index)) workspace.move(slot, sent.index);
  slot.scrollIntoView({ block: 'nearest' });
  notice(`${app(sent.appId).title} is back on the desk.`);
}

async function popOut(slot) {
  const appId = slot.getAttribute('name');
  const id = crypto.randomUUID();
  // opened straight from the click, so a popup blocker lets it through; filled in a moment later
  const popup = window.open(`${base}?app=${encodeURIComponent(appId)}&handoff=${id}`, `starport-${id}`, 'popup,width=760,height=720');
  if (!popup) {
    notice(`The browser kept ${app(appId).title} from opening a window, so it stays on the desk.`);
    return;
  }
  const snapshot = without(await workspace.snapshot(slot), 'appId');
  const index = [...desk.querySelectorAll(':scope > fragment-slot')].indexOf(slot);
  // The state crosses in localStorage: in the clear, to any page of this origin, which is fine
  // for Starport and is worth knowing before carrying anything private this way.
  localStorage.setItem(handoffKey(id), JSON.stringify({ appId, snapshot }));
  // a window that never takes its app (closed at once, or never started) gives it back
  out.set(id, { appId, snapshot, index });
  waitForTaking(id);
  keepOut();
  slot.remove();
  notice(`${app(appId).title} is in its own window. Close that window to bring it back.`);
}

/** A window that gives its app back may only be reloading: if it takes it again this soon, it keeps it. */
const RELOAD_GRACE_MS = 1500;

dock.addEventListener('message', ({ data }) => {
  if (solo || typeof data?.handoff !== 'string' || out.get(data.handoff)?.appId !== data.appId) return;
  const sent = out.get(data.handoff);
  // taken: the window has the app now, and will give it back when it closes
  if (data.taken) {
    clearTimeout(sent.returning);
    sent.taken = true;
    waitForTaking(data.handoff);
    keepOut();
    return;
  }
  clearTimeout(sent.returning);
  sent.returning = setTimeout(() => takeBack(data.handoff, data.snapshot ?? {}), RELOAD_GRACE_MS);
});

/** In a popped-out window: the app, with the state it left the desk with. */
async function openSolo() {
  // what this window held when it last unloaded: a reload takes it up again
  const SOLO_KEY = `starport${base}solo`;
  let given;
  try {
    const kept = JSON.parse(sessionStorage.getItem(SOLO_KEY) ?? 'null');
    if (kept?.handoff === handoff && kept.appId === solo) given = kept;
  } catch {
    given = undefined;
  }
  if (handoff && !given) {
    const read = () => localStorage.getItem(handoffKey(handoff));
    let raw = read();
    // the desk writes it a moment after opening this window
    for (let waited = 0; !raw && waited < 3000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      raw = read();
    }
    localStorage.removeItem(handoffKey(handoff));
    try {
      given = raw ? JSON.parse(raw) : undefined;
    } catch {
      given = undefined;
    }
  }
  const mine = given?.appId === solo;
  // the app fills this window, so the span it had on the desk is left behind
  const slot = workspace.open(solo, without(mine ? given.snapshot : {}, 'placement'));
  if (!mine) {
    // a copy opened in a tab: nothing to return to
    $('#back').hidden = true;
    return;
  }
  dock.postMessage({ handoff, appId: solo, taken: true });
  // kept fresh, because a window that is closing has no time to ask its app for its state
  const latest = { ...(given.snapshot?.state !== undefined ? { state: given.snapshot.state } : {}) };
  let asking;
  /** Asks the app for its state; a second ask while one is out waits for that one. */
  const refresh = () =>
    (asking ??= (async () => {
      try {
        if (!slot.isConnected) return;
        const { state, channel } = await workspace.snapshot(slot);
        // no answer (still booting, or slow) is not "no state": keep what there was
        if (state !== undefined) latest.state = state;
        if (channel !== undefined) latest.channel = channel;
      } finally {
        asking = undefined;
      }
    })());
  // after anything the user does in the app (once the app has handled it), and every few seconds
  // besides, for state the app changes by itself
  for (const type of ['click', 'keyup', 'change', 'input']) document.addEventListener(type, () => setTimeout(refresh), true);
  setInterval(refresh, 3000);
  let returned = false;
  const giveBack = () => {
    if (returned) return;
    returned = true;
    dock.postMessage({ handoff, appId: solo, snapshot: latest });
  };
  // A page kept in the back-forward cache may come back; it has not closed. One that is reloading
  // gives its app back too (pagehide cannot tell), but keeps it here, and takes it up again in
  // time for the desk to leave it be.
  addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    sessionStorage.setItem(SOLO_KEY, JSON.stringify({ handoff, appId: solo, snapshot: { ...given.snapshot, ...latest } }));
    giveBack();
  });
  $('#back').addEventListener('click', async () => {
    await refresh();
    giveBack();
    sessionStorage.removeItem(SOLO_KEY);
    window.close();
  });
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
// listener does get.
const tower = createEventBus({ consumer: 'desk' }).channel('tower');
tower.addEventListener('ship.departed', ({ payload }) => {
  $('#ticker-event').textContent = `${payload.name} departed for ${payload.to}`;
});
tower.subscribe((state) => {
  const departures = state?.departed?.length ?? 0;
  $('#ticker-count').textContent = `${departures} ${departures === 1 ? 'departure' : 'departures'} today`;
});

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


