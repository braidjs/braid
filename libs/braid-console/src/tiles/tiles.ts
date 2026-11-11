import type { Placement, Workspace } from '../workspace/workspace.js';
import { popOutDesk, type PopOutDesk, type PopOutOptions } from './pop-out.js';
import { installTilesCss } from './styles.js';

/**
 * Tiles: the hands-on half of a workspace. Each app in the workspace area gets a header — a grip
 * to move it, buttons to size it, a pop-out link and a close button — and edges to drag-resize it,
 * snapped to whole columns and rows of the area's grid. Everything it does goes through the
 * workspace (`move`, `place`, `snapshot`, `open`), so a saved layout keeps it all.
 *
 * The header is a `slot="header"` child of each `<fragment-slot>`, which Braid shows above the
 * app in every state; the app's own content stays in its shadow root, out of the host's reach.
 */
export interface ArrangeOptions {
  /** The title an app is shown and announced by. Defaults to its id. */
  title?(appId: string): string;
  /** A short mark before the title (an emoji, say). None by default. */
  glyph?(appId: string): string | undefined;
  /** The most columns a tile may span; never more than the grid has. Default 12. */
  maxColumns?: number;
  /** The most rows a tile may span. Default 6. */
  maxRows?: number;
  /**
   * The rows a tile with no span of its own takes in the host's CSS (`var(--braid-rows, N)`).
   * Sizing a tile to it gives it no span. Default 1.
   */
  defaultRows?: number;
  /** Lets each tile pop out into a window of its own. Without it, tiles have no pop-out link. */
  popOut?: PopOutOptions;
  /**
   * Called when a tile is set up, and again whenever its span or its `state` attribute changes:
   * the place to add the host's own parts to its header (`head`), or to update them.
   */
  describe?(slot: Element, head: HTMLElement): void;
  /** Called after the user closes a tile; focus is on the next tile's grip, if there is one. */
  onClose?(appId: string): void;
  /** Adds the default look ({@link TILES_CSS}) to the page. Default true. */
  styles?: boolean;
}

export interface Tiles {
  /** Says what every tile is again: its size buttons, and the host's `describe`. */
  refresh(): void;
  /** Pops a tile out, as its pop-out link does. Needs `popOut`. */
  popOut(slot: Element): Promise<void>;
  /** Takes every header and edge away and stops listening. */
  destroy(): void;
}

type Edge = 'right' | 'bottom' | 'corner';

export function arrange(workspace: Workspace, options: ArrangeOptions = {}): Tiles {
  const container = workspace.container;
  if (!container) throw new Error('braid-tiles: the workspace has no area to arrange');
  const document = container.ownerDocument;
  const view = document.defaultView!;
  if (options.styles !== false) installTilesCss(document);
  container.setAttribute('data-braid-tiles', '');

  const maxColumns = whole(options.maxColumns, 12);
  const maxRows = whole(options.maxRows, 6);
  const defaultRows = whole(options.defaultRows, 1);
  const titleOf = (slot: Element) => {
    const id = slot.getAttribute('name') ?? '';
    return options.title?.(id) ?? id;
  };
  const tiles = () => [...container.children].filter((child) => child.localName === 'fragment-slot');
  const headOf = (slot: Element) => slot.querySelector<HTMLElement>(':scope > .braid-tile-head');
  const desk: PopOutDesk | undefined = options.popOut ? popOutDesk(workspace, options.popOut, tiles) : undefined;
  const cleanups: (() => void)[] = [];

  // ── The grid ───────────────────────────────────────────────────────────────────────────────
  /** The area's grid as laid out now: its column count, track sizes and gaps. */
  function grid() {
    const style = view.getComputedStyle(container!);
    const tracks = style.gridTemplateColumns.split(' ').filter((track) => track && track !== 'none');
    return {
      columns: Math.max(1, tracks.length),
      columnWidth: parseFloat(tracks[0] ?? '') || container!.clientWidth,
      columnGap: parseFloat(style.columnGap) || 0,
      rowGap: parseFloat(style.rowGap) || 0,
      rowHeight: parseFloat(style.gridAutoRows),
    };
  }
  /** The most columns a tile can span on the grid as it is now. */
  const columnLimit = () => Math.min(maxColumns, grid().columns);

  /** A tile's span as it shows: one column or the default rows when it has none of its own. */
  function spanOf(slot: Element) {
    const { columns = 1, rows = defaultRows } = workspace.placementOf(slot);
    return { columns: Math.min(columns, columnLimit()), rows };
  }

  /** A span of one column, or of the default height, is no span: the tile goes back to the default. */
  function resize(slot: Element, change: Placement) {
    const next: Placement = { ...workspace.placementOf(slot), ...change };
    if (next.columns === 1) delete next.columns;
    if (next.rows === defaultRows) delete next.rows;
    workspace.place(slot, next);
    describe(slot);
  }

  // ── Headers ────────────────────────────────────────────────────────────────────────────────
  function header(slot: Element) {
    const appId = slot.getAttribute('name') ?? '';
    const title = titleOf(slot);
    const head = make('div', 'braid-tile-head');
    head.slot = 'header';

    const grip = button('braid-tile-grip', '⠿', `Move ${title}`);
    grip.setAttribute('aria-haspopup', 'menu');
    grip.setAttribute('aria-expanded', 'false');
    grip.title = 'Drag to move, or click for Move earlier / later. Alt + arrow keys move, Shift + Alt + arrow keys resize';

    // a click on the grip, for anyone who can't or won't drag: the same moves, as buttons
    const menu = make('div', 'braid-tile-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    for (const [label, step] of [
      ['Move earlier', -1],
      ['Move later', 1],
    ] as const) {
      const item = button('', label);
      item.setAttribute('role', 'menuitem');
      item.dataset.step = String(step);
      item.addEventListener('click', () => {
        moveBy(slot, step);
        closeMenu(grip, menu);
        grip.focus();
      });
      menu.append(item);
    }

    const name = make('span', 'braid-tile-title');
    const glyph = options.glyph?.(appId);
    if (glyph) {
      const mark = make('span', 'braid-tile-glyph', glyph);
      mark.setAttribute('aria-hidden', 'true');
      name.append(mark, ' ');
    }
    name.append(title);

    const wider = button('braid-tile-size braid-tile-wider', '');
    const taller = button('braid-tile-size braid-tile-taller', '');
    const close = button('braid-tile-close', '×', `Close ${title}`);
    head.append(grip, menu, name, wider, taller);

    if (options.popOut) {
      // a link, so Cmd-click or a long press opens a copy in a tab as any link would; a plain click
      // moves the app itself into a window of its own
      const pop = make('a', 'braid-tile-pop', '↗');
      pop.href = options.popOut.url(appId);
      pop.target = '_blank';
      pop.setAttribute('aria-label', `Pop ${title} out into its own window`);
      pop.title = 'Pop out (Cmd-click for a copy in a tab)';
      pop.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void desk!.popOut(slot);
      });
      head.append(pop);
    }
    head.append(close);

    // The edges are a header child of their own, not inside the header: a frame as wide as the
    // tile and stuck to the top of what it shows, so the edges stay at the tile's edges as its
    // content scrolls (see --braid-tile-height).
    const frame = make('div', 'braid-tile-frame');
    frame.slot = 'header';
    frame.setAttribute('aria-hidden', 'true');
    for (const edge of ['right', 'bottom', 'corner'] as const) {
      const handle = make('span', 'braid-tile-edge');
      handle.dataset.edge = edge;
      handle.title = 'Drag to resize';
      handle.addEventListener('pointerdown', (event) => dragToResize(slot, edge, event));
      frame.append(handle);
    }
    slot.prepend(head, frame);
    sizes?.observe(slot);

    grip.addEventListener('pointerdown', (event) => dragToMove(slot, grip, event));
    grip.addEventListener('keydown', (event) => byKey(slot, grip, event));
    grip.addEventListener('click', () => {
      // a drag that moved the tile ends in a click too; that one is not a request for the menu
      if (grip.dataset.dragged !== undefined) return void delete grip.dataset.dragged;
      if (menu.hidden) openMenu(grip, menu);
      else closeMenu(grip, menu);
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeMenu(grip, menu);
      grip.focus();
    });
    wider.addEventListener('click', () => cycle(slot, 'columns'));
    taller.addEventListener('click', () => cycle(slot, 'rows'));
    close.addEventListener('click', () => {
      const all = tiles();
      const next = all[all.indexOf(slot) + 1] ?? all[all.indexOf(slot) - 1];
      slot.remove();
      next?.querySelector<HTMLElement>(':scope > .braid-tile-head .braid-tile-grip')?.focus();
      options.onClose?.(appId);
    });
    describe(slot);
  }

  /**
   * Puts a tile's edges at its edges: they hang from a frame of no height, so they need its visible
   * height. Done as soon as the tile is described (a resize, say), not a frame later when the
   * observer would, so the edges are where the tile is by the time anyone reaches for them.
   */
  function fitEdges(slot: Element) {
    const style = view.getComputedStyle(slot);
    (slot as HTMLElement).style.setProperty('--braid-tile-height', `${slot.clientHeight - (parseFloat(style.paddingTop) || 0)}px`);
  }

  /** Says what a tile is, in its size buttons, and asks the host to say the rest. */
  function describe(slot: Element) {
    const head = headOf(slot);
    if (!head) return;
    fitEdges(slot);
    const title = titleOf(slot);
    const { columns, rows } = spanOf(slot);
    const wider = head.querySelector('.braid-tile-wider')!;
    wider.textContent = `⇔ ${columns}`;
    wider.setAttribute('aria-label', `${title} is ${plural(columns, 'column')} wide. Change width`);
    const taller = head.querySelector('.braid-tile-taller')!;
    taller.textContent = `⇕ ${rows}`;
    taller.setAttribute('aria-label', `${title} is ${plural(rows, 'row')} tall. Change height`);
    options.describe?.(slot, head);
  }

  function cycle(slot: Element, key: 'columns' | 'rows') {
    // no wider than the grid is now: at two columns, a three-column span would look like two
    const limit = key === 'columns' ? columnLimit() : maxRows;
    resize(slot, { [key]: (Math.min(spanOf(slot)[key], limit) % limit) + 1 });
  }

  // ── Moving ─────────────────────────────────────────────────────────────────────────────────
  function moveBy(slot: Element, step: number) {
    workspace.move(slot, tiles().indexOf(slot) + step);
    announce(`${titleOf(slot)} moved to position ${tiles().indexOf(slot) + 1} of ${tiles().length}`);
  }

  /** Alt and an arrow moves the tile; Shift, Alt and an arrow resizes it. */
  function byKey(slot: Element, grip: HTMLElement, event: KeyboardEvent) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const step = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>)[event.key];
    if (!step) return;
    event.preventDefault();
    if (!event.shiftKey) {
      moveBy(slot, step);
      grip.focus();
      return;
    }
    const key = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'columns' : 'rows';
    const limit = key === 'columns' ? columnLimit() : maxRows;
    const now = spanOf(slot)[key];
    const next = clamp(now + step, 1, limit);
    if (next !== now) resize(slot, { [key]: next });
    announceSize(slot);
  }

  function openMenu(grip: HTMLElement, menu: HTMLElement) {
    menu.hidden = false;
    grip.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')!.focus();
    const away = (event: Event) => {
      if (menu.contains(event.target as Node) || event.target === grip) return;
      closeMenu(grip, menu);
      view.removeEventListener('pointerdown', away, true);
    };
    view.addEventListener('pointerdown', away, true);
  }

  function closeMenu(grip: HTMLElement, menu: HTMLElement) {
    menu.hidden = true;
    grip.setAttribute('aria-expanded', 'false');
  }

  /**
   * Follows the pointer and moves the tile into the place of whichever tile it is over, as it goes.
   * Listens on the window rather than capturing the pointer: the grip is inside the tile being
   * moved, and a browser without `moveBefore` drops a capture when its element moves.
   */
  function dragToMove(slot: Element, grip: HTMLElement, event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    // the tile last swapped with, until the pointer leaves it: tiles of different sizes would
    // otherwise swap back and forth under a pointer that has stopped moving
    let swappedWith: Element | undefined;
    let moved = false;
    const follow = (move: PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      // a button let go where this page did not hear it (over a frame, or in another window)
      if (move.buttons === 0 || !slot.isConnected) return end();
      if (!moved && Math.hypot(move.clientX - start.x, move.clientY - start.y) < 4) return;
      if (!moved) {
        moved = true;
        slot.classList.add('braid-tile-dragging');
        document.body.classList.add('braid-tiles-moving');
      }
      const under = document.elementFromPoint(move.clientX, move.clientY)?.closest('fragment-slot') ?? undefined;
      if (under !== swappedWith) swappedWith = undefined;
      if (!under || under === slot || under === swappedWith || under.parentElement !== container) return;
      swappedWith = under;
      workspace.move(slot, tiles().indexOf(under));
    };
    const end = track(event, follow, () => {
      slot.classList.remove('braid-tile-dragging');
      document.body.classList.remove('braid-tiles-moving');
      if (moved) grip.dataset.dragged = '';
      if (slot.isConnected) grip.focus({ preventScroll: true });
    });
  }

  // ── Resizing ───────────────────────────────────────────────────────────────────────────────
  /**
   * Resizes the tile as one of its edges is dragged: the right edge its columns, the bottom edge
   * its rows, the corner both. An outline shows the size it will snap to, in whole tracks; the tile
   * takes it when the pointer is let go, so the grid does not reflow under the pointer. Escape
   * leaves it as it was.
   */
  function dragToResize(slot: Element, edge: Edge, event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const metrics = grid();
    const limit = columnLimit();
    const box = slot.getBoundingClientRect();
    const span = spanOf(slot);
    // rows of a fixed height where the grid has them; otherwise as tall as this tile's rows are
    const rowHeight = metrics.rowHeight || (box.height - metrics.rowGap * (span.rows - 1)) / span.rows;
    const outline = make('div', 'braid-tile-outline');
    outline.setAttribute('aria-hidden', 'true');
    document.body.append(outline);
    document.documentElement.dataset.braidTilesSizing = edge;
    slot.classList.add('braid-tile-resizing');
    let target = span;
    const show = () => {
      const width = target.columns * metrics.columnWidth + (target.columns - 1) * metrics.columnGap;
      const height = target.rows * rowHeight + (target.rows - 1) * metrics.rowGap;
      Object.assign(outline.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${width}px`, height: `${height}px` });
      outline.textContent = `${target.columns} × ${target.rows}`;
      outline.dataset.columns = String(target.columns);
      outline.dataset.rows = String(target.rows);
    };
    show();
    const follow = (move: PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      if (move.buttons === 0 || !slot.isConnected) return end();
      const columns =
        edge === 'bottom'
          ? span.columns
          : clamp(Math.round((box.width + move.clientX - event.clientX + metrics.columnGap) / (metrics.columnWidth + metrics.columnGap)), 1, limit);
      const rows =
        edge === 'right' ? span.rows : clamp(Math.round((box.height + move.clientY - event.clientY + metrics.rowGap) / (rowHeight + metrics.rowGap)), 1, maxRows);
      if (columns === target.columns && rows === target.rows) return;
      target = { columns, rows };
      show();
    };
    let cancelled = false;
    const escape = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      cancelled = true;
      end();
    };
    view.addEventListener('keydown', escape, true);
    const end = track(event, follow, (up) => {
      view.removeEventListener('keydown', escape, true);
      outline.remove();
      delete document.documentElement.dataset.braidTilesSizing;
      slot.classList.remove('braid-tile-resizing');
      // only a release takes the size; a pointer lost (cancelled, or let go unheard) does not
      if (cancelled || !up || !slot.isConnected) return;
      if (target.columns === span.columns && target.rows === span.rows) return;
      resize(slot, target);
      announceSize(slot);
    });
  }

  /**
   * Follows one pointer on the window until it is let go, cancelled, or the window loses focus;
   * `done` hears whether it was let go. Returns a function that ends it early.
   */
  function track(start: PointerEvent, follow: (move: PointerEvent) => void, done: (up: boolean) => void) {
    let over = false;
    const stop = (up: PointerEvent) => {
      if (up.pointerId === start.pointerId) finish(up.type === 'pointerup');
    };
    const blur = () => finish(false);
    function finish(up: boolean) {
      if (over) return;
      over = true;
      view.removeEventListener('pointermove', follow);
      view.removeEventListener('pointerup', stop);
      view.removeEventListener('pointercancel', stop);
      view.removeEventListener('blur', blur);
      done(up);
    }
    view.addEventListener('pointermove', follow);
    view.addEventListener('pointerup', stop);
    view.addEventListener('pointercancel', stop);
    view.addEventListener('blur', blur);
    return () => finish(false);
  }

  function announceSize(slot: Element) {
    const { columns, rows } = spanOf(slot);
    announce(`${titleOf(slot)} is ${plural(columns, 'column')} wide and ${plural(rows, 'row')} tall`);
  }

  /** Tells a screen reader what a keyboard move or resize did. */
  function announce(message: string) {
    let live = document.querySelector('.braid-tiles-announcer');
    if (!live) {
      live = make('p', 'braid-tiles-announcer');
      live.id = 'braid-tiles-announcer';
      live.setAttribute('aria-live', 'polite');
      document.body.append(live);
    }
    live.textContent = message;
  }

  // ── Keeping every tile's header and edges up to date ───────────────────────────────────────
  // Each tile's edges need its visible height (they are placed against a frame of no height), and
  // the area says when its grid is one column, where spans mean nothing.
  const sizes =
    typeof view.ResizeObserver === 'function'
      ? new view.ResizeObserver((entries) => {
          for (const { target } of entries) {
            if (target === container) {
              container.toggleAttribute('data-braid-tiles-single', grid().columns < 2);
              for (const slot of tiles()) describe(slot);
            } else fitEdges(target);
          }
        })
      : undefined;
  sizes?.observe(container);
  cleanups.push(() => sizes?.disconnect());

  // A tile can arrive from the markup, a launch, a restored layout, or an agent launching an app
  // for an intent; each gets its header here. `state` is Braid's attribute: the host's describe
  // follows it.
  const ensure = () => {
    for (const slot of tiles()) if (!headOf(slot)) header(slot);
  };
  const watch = new view.MutationObserver((records) => {
    ensure();
    for (const record of records) if (record.type === 'attributes' && (record.target as Element).parentElement === container) describe(record.target as Element);
  });
  watch.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['state', 'data-braid-columns', 'data-braid-rows'] });
  cleanups.push(() => watch.disconnect());
  ensure();
  container.toggleAttribute('data-braid-tiles-single', grid().columns < 2);
  // there before the first move, so a screen reader is already listening when it speaks
  announce('');

  return {
    refresh() {
      for (const slot of tiles()) describe(slot);
    },
    async popOut(slot) {
      if (!desk) throw new Error('braid-tiles: arrange({ popOut }) is needed to pop a tile out');
      await desk.popOut(slot);
    },
    destroy() {
      for (const cleanup of cleanups) cleanup();
      desk?.close();
      for (const slot of tiles()) for (const part of slot.querySelectorAll(':scope > .braid-tile-head, :scope > .braid-tile-frame')) part.remove();
      container.removeAttribute('data-braid-tiles');
      container.removeAttribute('data-braid-tiles-single');
    },
  };

  function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function button(className: string, text: string, label?: string): HTMLButtonElement {
    const node = make('button', className, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    return node;
  }
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;
/** A whole number from 1 to 12, or `fallback`. */
const whole = (value: number | undefined, fallback: number) => (Number.isInteger(value) && value! >= 1 && value! <= 12 ? value! : fallback);
