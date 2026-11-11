import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../workspace/store.js';
import { createWorkspace, type Workspace } from '../workspace/workspace.js';
import { acceptPopOut, HANDOFF_TIMEOUT_MS, RELOAD_GRACE_MS } from './pop-out.js';
import { arrange, type Tiles } from './tiles.js';

/**
 * Tiles in jsdom: headers, keyboard moves and resizes, size buttons, close, and the pop-out
 * handoff between a desk and a window. jsdom lays nothing out, so the grid is what
 * getComputedStyle is made to say here; dragging with a real pointer over a laid-out grid is
 * exercised in Chromium by e2e/starport-example.e2e.ts.
 */

let area: HTMLElement;
let workspace: Workspace;
let tiles: Tiles | undefined;
let columns = 3;

const names = () => [...area.children].map((slot) => slot.getAttribute('name'));
const slotOf = (name: string) => area.querySelector<HTMLElement>(`:scope > fragment-slot[name="${name}"]`)!;
const part = (name: string, selector: string) => slotOf(name).querySelector<HTMLElement>(selector)!;
const key = (target: HTMLElement, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const announced = () => document.querySelector('.braid-tiles-announcer')?.textContent;
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  columns = 3;
  area = document.createElement('main');
  document.body.append(area);
  workspace = createWorkspace({ container: area, store: memoryStore() });
  const real = window.getComputedStyle.bind(window);
  // the area's grid, as a browser would lay it out
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (element !== area) return real(element, pseudo);
    return {
      gridTemplateColumns: Array.from({ length: columns }, () => '300px').join(' '),
      columnGap: '20px',
      rowGap: '20px',
      gridAutoRows: '200px',
    } as CSSStyleDeclaration;
  });
  for (const id of ['flights', 'map', 'cargo']) workspace.open(id);
});

afterEach(() => {
  tiles?.destroy();
  tiles = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

const titles: Record<string, string> = { flights: 'Flights', map: 'Star Map', cargo: 'Cargo' };

describe('arrange', () => {
  it('gives every app a header and edges: those there already, those launched later, and those a layout restores', async () => {
    tiles = arrange(workspace, { title: (id) => titles[id] ?? id, glyph: (id) => (id === 'map' ? '🗺️' : undefined) });
    for (const name of ['flights', 'map', 'cargo']) {
      expect(slotOf(name).querySelector(':scope > .braid-tile-head')?.getAttribute('slot')).toBe('header');
      expect([...slotOf(name).querySelectorAll(':scope > .braid-tile-frame .braid-tile-edge')].map((edge) => (edge as HTMLElement).dataset.edge)).toEqual([
        'right',
        'bottom',
        'corner',
      ]);
    }
    expect(part('map', '.braid-tile-title').textContent).toBe('🗺️ Star Map');
    expect(part('map', '.braid-tile-grip').getAttribute('aria-label')).toBe('Move Star Map');
    // no pop-out link unless the host says where a window goes
    expect(part('map', '.braid-tile-pop')).toBeNull();

    workspace.open('radar');
    await tick();
    expect(slotOf('radar').querySelectorAll(':scope > .braid-tile-head')).toHaveLength(1);

    await workspace.layouts.save('ops');
    await workspace.layouts.restore('ops');
    await tick();
    expect(names()).toEqual(['flights', 'map', 'cargo', 'radar']);
    for (const slot of area.children) expect(slot.querySelectorAll(':scope > .braid-tile-head')).toHaveLength(1);
  });

  it('moves a tile with Alt and an arrow key, and says where it went', () => {
    tiles = arrange(workspace, { title: (id) => titles[id] ?? id });
    const grip = part('cargo', '.braid-tile-grip');
    key(grip, { key: 'ArrowLeft', altKey: true });
    expect(names()).toEqual(['flights', 'cargo', 'map']);
    key(grip, { key: 'ArrowUp', altKey: true });
    expect(names()).toEqual(['cargo', 'flights', 'map']);
    expect(announced()).toBe('Cargo moved to position 1 of 3');
    // an arrow without Alt is the page's
    key(grip, { key: 'ArrowRight' });
    expect(names()).toEqual(['cargo', 'flights', 'map']);
  });

  it('moves a tile from the grip menu', () => {
    tiles = arrange(workspace);
    part('flights', '.braid-tile-grip').click();
    expect(part('flights', '.braid-tile-grip').getAttribute('aria-expanded')).toBe('true');
    part('flights', '.braid-tile-menu button[data-step="1"]').click();
    expect(names()).toEqual(['map', 'flights', 'cargo']);
    expect(part('flights', '.braid-tile-menu').hidden).toBe(true);
  });

  it('resizes a tile with Shift, Alt and an arrow key, no wider than the grid and no taller than maxRows, and says so', () => {
    tiles = arrange(workspace, { title: (id) => titles[id] ?? id, defaultRows: 2, maxRows: 3 });
    const map = slotOf('map');
    const grip = part('map', '.braid-tile-grip');
    key(grip, { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(workspace.placementOf(map)).toEqual({ columns: 2 });
    expect(announced()).toBe('Star Map is 2 columns wide and 2 rows tall');
    key(grip, { key: 'ArrowRight', altKey: true, shiftKey: true });
    key(grip, { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(workspace.placementOf(map)).toEqual({ columns: 3 });
    key(grip, { key: 'ArrowDown', altKey: true, shiftKey: true });
    key(grip, { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(workspace.placementOf(map)).toEqual({ columns: 3, rows: 3 });
    expect(announced()).toBe('Star Map is 3 columns wide and 3 rows tall');
    // back to one column and the default height: no span at all
    for (let i = 0; i < 4; i++) key(grip, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    key(grip, { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(workspace.placementOf(map)).toEqual({});
    expect(names()).toEqual(['flights', 'map', 'cargo']);
    expect(part('map', '.braid-tile-wider').textContent).toBe('⇔ 1');
    expect(part('map', '.braid-tile-taller').textContent).toBe('⇕ 2');

    // two columns on the grid now: no span past them
    columns = 2;
    for (let i = 0; i < 3; i++) key(grip, { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(workspace.placementOf(map)).toEqual({ columns: 2 });
  });

  it('cycles a tile through its spans with its size buttons, and labels them', () => {
    tiles = arrange(workspace, { title: (id) => titles[id] ?? id, maxColumns: 3, defaultRows: 2, maxRows: 3 });
    const map = slotOf('map');
    const wider = part('map', '.braid-tile-wider');
    const taller = part('map', '.braid-tile-taller');
    wider.click();
    expect(map.getAttribute('data-braid-columns')).toBe('2');
    expect(wider.getAttribute('aria-label')).toBe('Star Map is 2 columns wide. Change width');
    wider.click();
    wider.click();
    expect(map.getAttribute('data-braid-columns')).toBeNull();
    expect(wider.getAttribute('aria-label')).toBe('Star Map is 1 column wide. Change width');
    taller.click();
    expect(map.getAttribute('data-braid-rows')).toBe('3');
    taller.click();
    expect(map.getAttribute('data-braid-rows')).toBe('1');
    expect(taller.textContent).toBe('⇕ 1');
  });

  it('calls the host back to describe a tile, again as its state changes', async () => {
    const said: string[] = [];
    tiles = arrange(workspace, { describe: (slot) => said.push(`${slot.getAttribute('name')}:${slot.getAttribute('state') ?? 'loading'}`) });
    expect(said).toEqual(['flights:loading', 'map:loading', 'cargo:loading']);
    slotOf('map').setAttribute('state', 'mounted');
    await tick();
    expect(said.at(-1)).toBe('map:mounted');
  });

  it('closes a tile, moves focus to the next one, and tells the host', () => {
    const closed: string[] = [];
    tiles = arrange(workspace, { onClose: (id) => closed.push(id) });
    part('map', '.braid-tile-close').click();
    expect(names()).toEqual(['flights', 'cargo']);
    expect(document.activeElement).toBe(part('cargo', '.braid-tile-grip'));
    part('cargo', '.braid-tile-close').click();
    expect(document.activeElement).toBe(part('flights', '.braid-tile-grip'));
    expect(closed).toEqual(['map', 'cargo']);
  });

  it('marks a one-column grid, where spans mean nothing', () => {
    columns = 1;
    tiles = arrange(workspace);
    expect(area.hasAttribute('data-braid-tiles-single')).toBe(true);
  });

  it('takes its headers and edges away again', () => {
    tiles = arrange(workspace);
    tiles.destroy();
    tiles = undefined;
    expect(area.querySelectorAll('.braid-tile-head, .braid-tile-frame')).toHaveLength(0);
    expect(area.hasAttribute('data-braid-tiles')).toBe(false);
  });
});

describe('popping out', () => {
  const KEY = 'test/';
  const url = (appId: string, handoff?: string) => `/desk/?app=${appId}${handoff ? `&handoff=${handoff}` : ''}`;

  /** What the desk opened: the URL of each window. */
  let opened: string[];
  beforeEach(() => {
    opened = [];
    vi.spyOn(window, 'open').mockImplementation((href) => {
      opened.push(String(href));
      return {} as Window;
    });
  });
  const handoffOf = (href: string) => new URL(href, location.href).searchParams.get('handoff')!;

  /** A second page's workspace: the window an app is popped out to. */
  function windowWorkspace() {
    const other = document.createElement('section');
    document.body.append(other);
    return { other, workspace: createWorkspace({ container: other, store: memoryStore() }) };
  }

  it('links each tile to its window, and a modified click is left to the browser', () => {
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    const pop = part('map', '.braid-tile-pop') as HTMLAnchorElement;
    expect(pop.getAttribute('href')).toBe('/desk/?app=map');
    expect(pop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))).toBe(true);
    expect(opened).toEqual([]);
    expect(names()).toEqual(['flights', 'map', 'cargo']);
  });

  it('carries an app to its window with its state and channel, and back to its place with its latest state', async () => {
    const events: string[] = [];
    workspace.open('radar', { state: { zoom: 3 }, channel: 'fdc3.channel.2', placement: { columns: 2 } });
    tiles = arrange(workspace, {
      popOut: { key: KEY, url, onPoppedOut: (id) => events.push(`out:${id}`), onReturned: (_slot, id) => events.push(`back:${id}`) },
    });
    workspace.move(slotOf('radar'), 1);
    part('radar', '.braid-tile-pop').click();
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'map', 'cargo']));
    expect(events).toEqual(['out:radar']);
    const handoff = handoffOf(opened[0]);
    expect(opened[0]).toBe(`/desk/?app=radar&handoff=${handoff}`);

    // in the window: the app, with what it left with, but not its span
    const popped = windowWorkspace();
    const accepted = await acceptPopOut(popped.workspace, { key: KEY, appId: 'radar', handoff });
    expect(accepted.fromDesk).toBe(true);
    expect(await popped.workspace.snapshot(accepted.slot)).toEqual({ appId: 'radar', state: { zoom: 3 }, channel: 'fdc3.channel.2' });
    // read once: the handoff is gone from storage
    expect(localStorage.getItem(`${KEY}handoff/${handoff}`)).toBeNull();

    // the window closes with a newer state; the desk waits out the reload grace, then takes it back
    const window = new BroadcastChannel(`${KEY}dock`);
    window.postMessage({ handoff, appId: 'radar', snapshot: { state: { zoom: 1 } } });
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'radar', 'map', 'cargo']), { timeout: RELOAD_GRACE_MS + 1000 });
    window.close();
    expect(events).toEqual(['out:radar', 'back:radar']);
    expect(await workspace.snapshot(slotOf('radar'))).toEqual({ appId: 'radar', state: { zoom: 1 }, channel: 'fdc3.channel.2', placement: { columns: 2 } });
  });

  it('ignores a return it did not send, and takes nothing back twice', async () => {
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    part('map', '.braid-tile-pop').click();
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'cargo']));
    const handoff = handoffOf(opened[0]);
    const forger = new BroadcastChannel(`${KEY}dock`);
    forger.postMessage({ handoff: 'made-up', appId: 'map', snapshot: {} });
    forger.postMessage({ handoff, appId: 'cargo', snapshot: {} });
    await tick(RELOAD_GRACE_MS + 200);
    expect(names()).toEqual(['flights', 'cargo']);
    forger.postMessage({ handoff, appId: 'map', snapshot: {} });
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'map', 'cargo']), { timeout: RELOAD_GRACE_MS + 1000 });
    forger.postMessage({ handoff, appId: 'map', snapshot: {} });
    await tick(RELOAD_GRACE_MS + 200);
    forger.close();
    expect(names()).toEqual(['flights', 'map', 'cargo']);
  }, 15_000);

  it('keeps an app in a window that gives it back and takes it again within the grace: a reload', async () => {
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    part('map', '.braid-tile-pop').click();
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'cargo']));
    const handoff = handoffOf(opened[0]);
    const window = new BroadcastChannel(`${KEY}dock`);
    window.postMessage({ handoff, appId: 'map', taken: true });
    await tick(50);
    window.postMessage({ handoff, appId: 'map', snapshot: {} });
    await tick(RELOAD_GRACE_MS / 3);
    window.postMessage({ handoff, appId: 'map', taken: true });
    await tick(RELOAD_GRACE_MS + 200);
    window.close();
    expect(names()).toEqual(['flights', 'cargo']);
  });

  it('takes an app back from a window that never takes it', async () => {
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await tiles.popOut(slotOf('map'));
    expect(names()).toEqual(['flights', 'cargo']);
    vi.advanceTimersByTime(HANDOFF_TIMEOUT_MS + 1);
    expect(names()).toEqual(['flights', 'map', 'cargo']);
  });

  it('takes back, after a reload of the desk, what the desk popped out before it', async () => {
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    await tiles.popOut(slotOf('cargo'));
    const handoff = handoffOf(opened[0]);
    // the desk reloads: a new arrange reads what this tab kept
    tiles.destroy();
    tiles = arrange(workspace, { popOut: { key: KEY, url } });
    const window = new BroadcastChannel(`${KEY}dock`);
    window.postMessage({ handoff, appId: 'cargo', snapshot: {} });
    await vi.waitFor(() => expect(names()).toEqual(['flights', 'map', 'cargo']), { timeout: RELOAD_GRACE_MS + 1000 });
    window.close();
  });

  it('says so when the browser blocks the window, and keeps the app', async () => {
    vi.mocked(window.open).mockReturnValue(null);
    const blocked: string[] = [];
    tiles = arrange(workspace, { popOut: { key: KEY, url, onBlocked: (id) => blocked.push(id) } });
    await tiles.popOut(slotOf('map'));
    expect(blocked).toEqual(['map']);
    expect(names()).toEqual(['flights', 'map', 'cargo']);
  });

  it('opens a copy fresh in a window the desk did not open', async () => {
    const popped = windowWorkspace();
    const accepted = await acceptPopOut(popped.workspace, { key: KEY, appId: 'map', handoff: null });
    expect(accepted.fromDesk).toBe(false);
    expect(await popped.workspace.snapshot(accepted.slot)).toEqual({ appId: 'map' });
  });
});
