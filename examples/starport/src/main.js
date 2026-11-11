import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';
import { createWorkspace, localStorageStore } from '@braidlabs/console/workspace';
import { createEventBus } from '@braidlabs/data';
import { APPS, baseOf, basePathOf } from './registry.js';

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
  const registration = await navigator.serviceWorker.register(`${base}sw.js`, { type: 'module', scope: base });
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
const directory = APPS.map(({ id, title, fdc3 }) => ({
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


