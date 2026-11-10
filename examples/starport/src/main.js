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

const workspace = createWorkspace();

// ── Choosing an app for an intent ────────────────────────────────────────────────────────────
// The agent asks this only when several apps could take a raise. The workspace wraps it: a
// remembered choice answers without asking, and `remember: true` is kept for next time.
function chooser({ candidates, context }) {
  return new Promise((resolve) => {
    const dialog = $('#chooser');
    $('#chooser-what').textContent = `${candidates[0].intent} · ${context?.name ?? context?.type ?? ''}`;
    const list = $('#chooser-list');
    list.replaceChildren(
      ...candidates.map((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.app = candidate.appId;
        button.autofocus = index === 0;
        const state = candidate.instanceId ? 'open' : candidate.starting ? 'starting' : 'will launch';
        button.innerHTML = `<span class="glyph"></span><span class="name"></span><span class="state"></span>`;
        button.children[0].textContent = APPS[candidate.appId]?.glyph ?? '✨';
        button.children[1].textContent = candidate.title;
        button.children[2].textContent = state;
        button.onclick = () => {
          answer = { candidate, remember: $('#chooser-remember').checked };
          dialog.close();
        };
        return button;
      }),
    );
    let answer;
    $('#chooser-remember').checked = false;
    dialog.addEventListener(
      'close',
      () => resolve(answer),
      { once: true },
    );
    dialog.showModal();
  });
}

// ── The agent, and Braid ─────────────────────────────────────────────────────────────────────
const response = await fetch('/__braid/registry/appd/v2/apps');
const directory = response.ok ? (await response.json()).applications : [];
const onDesk = workspace.fdc3(chooser);
const agent = createBraidDesktopAgent({
  directory,
  ...onDesk,
  // the workspace has stored a remembered choice by the time its resolver answers
  resolveIntent: (request) => onDesk.resolveIntent(request).finally(() => showRemembered()),
});

// every app joins the same channel before its code runs, so a ship picked in one is seen in all
if (!(await workspace.preferences.getHost()).defaultUserChannel) {
  await workspace.preferences.setHost({ defaultUserChannel: 'fdc3.channel.1' });
}
initBraid({ realmGlobals: workspace.realmGlobals(agent.realmGlobals) });

// ── The dock: launch an app, see what is open, close it ──────────────────────────────────────
const desk = workspace.container;
for (const [id, app] of Object.entries(APPS)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.launch = id;
  button.title = `Launch ${app.title}`;
  button.innerHTML = `<span class="glyph">${app.glyph}</span><span>${app.title}</span><i></i>`;
  button.onclick = () => workspace.open(id).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('#dock').append(button);
}

function showOpen() {
  const open = [...desk.querySelectorAll(':scope > fragment-slot')];
  const counts = {};
  for (const slot of open) counts[slot.getAttribute('name')] = (counts[slot.getAttribute('name')] ?? 0) + 1;
  for (const button of $('#dock').children) {
    const count = counts[button.dataset.launch] ?? 0;
    button.classList.toggle('running', count > 0);
    button.querySelector('i').textContent = count > 1 ? String(count) : '';
  }
  $('#empty').hidden = open.length > 0;
}
new MutationObserver(showOpen).observe(desk, { childList: true });
showOpen();

// One × for the whole desk: it rides the corner of whichever tile the pointer is over. It is the
// desk's, not the app's — closing an app is just removing its slot.
const close = $('#close-tile');
let hovered;
desk.addEventListener('pointerover', (event) => {
  const slot = event.target.closest?.('fragment-slot');
  if (!slot || slot === hovered) return;
  hovered = slot;
  const box = slot.getBoundingClientRect();
  close.style.top = `${box.top + scrollY + 10}px`;
  close.style.left = `${box.right + scrollX - 40}px`;
  close.setAttribute('aria-label', `Close ${APPS[slot.getAttribute('name')]?.title ?? 'app'}`);
  close.hidden = false;
});
close.onclick = () => {
  hovered?.remove();
  hovered = undefined;
  close.hidden = true;
};

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
      restore.onclick = () => workspace.layouts.restore(name);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'x';
      remove.setAttribute('aria-label', `Delete layout ${name}`);
      remove.textContent = '×';
      remove.onclick = async () => {
        await workspace.layouts.delete(name);
        await showLayouts();
      };
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
  await workspace.layouts.save(name);
  input.value = '';
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
