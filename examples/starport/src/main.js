import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';
import { createWorkspace } from '@braidlabs/console/workspace';

/**
 * The desk's whole runtime. The workspace is the `[data-braid-workspace]` element in index.html;
 * everything the user keeps (layouts, app settings, remembered choices) goes to localStorage.
 */

const APPS = {
  flights: { title: 'Flights', glyph: '🛫' },
  'star-map': { title: 'Star Map', glyph: '🌌' },
  radar: { title: 'Radar', glyph: '📡' },
  cargo: { title: 'Cargo', glyph: '📦' },
  comms: { title: 'Comms', glyph: '🛰️' },
};
const $ = (selector) => document.querySelector(selector);
function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
/** Says what went wrong where the desk's one status line is. */
function report(message) {
  $('#empty').textContent = message;
  $('#empty').hidden = false;
}

const workspace = createWorkspace();

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
        const glyph = element('span', 'glyph', APPS[candidate.appId]?.glyph ?? '✨');
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
// A directory that fails to load leaves the apps without fdc3, rather than the desk without apps.
const response = await fetch('/__braid/registry/appd/v2/apps').catch(() => undefined);
const directory = response?.ok ? (await response.json()).applications : [];
if (!response?.ok) report('The app directory did not load, so the apps cannot talk to each other. Is the gateway running?');

const onDesk = workspace.fdc3(chooser);
const agent = createBraidDesktopAgent({
  directory,
  ...onDesk,
  // the workspace has stored a remembered choice by the time its resolver answers
  resolveIntent: (request) => onDesk.resolveIntent(request).finally(() => showRemembered().catch(() => undefined)),
});

// Every app joins the same channel before its code runs, so a ship picked in one is seen in all.
// setHost replaces the preferences, so whatever else is there is carried over.
const preferences = await workspace.preferences.getHost();
if (!preferences.defaultUserChannel) {
  await workspace.preferences.setHost({ ...preferences, defaultUserChannel: 'fdc3.channel.1' });
}
initBraid({ realmGlobals: workspace.realmGlobals(agent.realmGlobals) });

// ── The dock: launch an app, see what is open, close it ──────────────────────────────────────
// Closing an app is removing its slot; the workspace and the agent see it go.
const desk = workspace.container;
const slotsOf = (id) => [...desk.querySelectorAll(`:scope > fragment-slot[name="${id}"]`)];
for (const [id, app] of Object.entries(APPS)) {
  const entry = element('span', 'app');
  entry.dataset.app = id;
  const launch = element('button', 'launch');
  launch.type = 'button';
  const glyph = element('span', 'glyph', app.glyph);
  glyph.setAttribute('aria-hidden', 'true');
  launch.append(glyph, element('span', 'title', app.title), element('span', 'count'));
  launch.onclick = () => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    workspace.open(id).scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
  };
  const close = element('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', `Close ${app.title}`);
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
    entry.querySelector('.launch').setAttribute('aria-label', count ? `Launch another ${APPS[id].title} (${count} open)` : `Launch ${APPS[id].title}`);
  }
  $('#empty').hidden = open > 0;
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
  const choice = await workspace.preferences.intentChoice('PlotRoute', 'starport.ship');
  $('#remembered').hidden = !choice;
  $('#remembered-app').textContent = APPS[choice]?.title ?? choice ?? '';
}
$('#forget').onclick = async () => {
  await workspace.preferences.forgetIntentChoice('PlotRoute', 'starport.ship');
  await showRemembered();
};
await showRemembered();

document.documentElement.dataset.ready = '';
