/**
 * Each app on the desk is a tile: its `<fragment-slot>`, with a header the desk owns. The header is
 * a `slot="header"` child, so it shows above the app in every state and moves with it, while the
 * app's own content stays in the slot's shadow root where the desk cannot reach.
 *
 * From the header the user moves a tile (drag its grip, or Alt+Arrow on it), resizes it (drag its
 * corner, or the width and height buttons), pops it out into a window of its own, and closes it.
 * The workspace does the rest: `move` keeps the app running, `place` gives it a span, and a saved
 * layout keeps both.
 */

/** The spans a tile can take; the grid says how wide and tall a span is. */
const MAX_COLUMNS = 3;
const MAX_ROWS = 3;
/** A tile with no height of its own spans this many rows (see shell.css). */
const DEFAULT_ROWS = 2;

/**
 * Gives every tile on `desk` its header, now and as tiles come and go, and returns a function that
 * turns the seams on or off.
 *
 * - `app(id)` — the registry entry for an app id: its title and glyph.
 * - `base` — the desk's folder, for the URL the worker serves each app from.
 * - `onPopOut(slot, event)` — called when the user pops a tile out.
 */
export function setupTiles({ workspace, desk, app, base, onPopOut }) {
  const tiles = () => [...desk.querySelectorAll(':scope > fragment-slot')];

  function header(slot) {
    const id = slot.getAttribute('name');
    const { title = id, glyph = '✨' } = app(id) ?? {};
    const head = make('div', 'tile-head');
    head.slot = 'header';

    const grip = make('button', 'grip', '⠿');
    grip.type = 'button';
    grip.setAttribute('aria-label', `Move ${title}. Drag, or Alt and an arrow key`);
    grip.title = 'Drag to move (Alt + arrow keys)';

    const name = make('span', 'tile-title');
    const icon = make('span', 'glyph', glyph);
    icon.setAttribute('aria-hidden', 'true');
    name.append(icon, ` ${title}`);

    const seam = make('code', 'seam');

    const wider = make('button', 'size wider');
    wider.type = 'button';
    const taller = make('button', 'size taller');
    taller.type = 'button';

    // A link, so Cmd-click or a long press opens a copy in a tab as any link would; a plain click
    // moves the app itself into a window of its own.
    const pop = make('a', 'pop', '↗');
    pop.href = `${base}?app=${encodeURIComponent(id)}`;
    pop.target = '_blank';
    pop.setAttribute('aria-label', `Pop ${title} out into its own window`);
    pop.title = 'Pop out (Cmd-click for a copy in a tab)';

    const close = make('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${title}`);

    // The corner handle is a header child of its own, not inside the header: the header sticks to
    // the top of the tile, and the corner is placed against the tile itself.
    const corner = make('span', 'resize');
    corner.slot = 'header';
    corner.setAttribute('aria-hidden', 'true');
    corner.title = 'Drag to resize';

    head.append(grip, name, seam, wider, taller, pop, close);
    slot.prepend(head, corner);

    grip.addEventListener('pointerdown', (event) => dragToMove(slot, grip, event));
    grip.addEventListener('keydown', (event) => moveByKey(slot, grip, event));
    corner.addEventListener('pointerdown', (event) => dragToResize(slot, event));
    wider.addEventListener('click', () => cycle(slot, 'columns', 1, MAX_COLUMNS));
    taller.addEventListener('click', () => cycle(slot, 'rows', DEFAULT_ROWS, MAX_ROWS));
    pop.addEventListener('click', (event) => {
      // a modified click is the browser's: a copy, in a tab
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      onPopOut(slot);
    });
    close.addEventListener('click', () => {
      const next = tiles()[tiles().indexOf(slot) + 1] ?? tiles()[tiles().indexOf(slot) - 1];
      slot.remove();
      next?.querySelector('.grip')?.focus();
    });
    describe(slot);
  }

  /** Says what the tile is, in its seam line and its size buttons. */
  function describe(slot) {
    const head = slot.querySelector(':scope > .tile-head');
    if (!head) return;
    const id = slot.getAttribute('name');
    const { columns = 1, rows = DEFAULT_ROWS } = workspace.placementOf(slot);
    head.querySelector('.seam').textContent =
      `<fragment-slot name="${id}">  ·  ${slot.getAttribute('state') ?? 'loading'}  ·  own realm  ·  ${base}__braid/frag/${id}/`;
    const title = app(id)?.title ?? id;
    const wider = head.querySelector('.wider');
    wider.textContent = `⇔ ${columns}`;
    wider.setAttribute('aria-label', `${title} is ${columns} ${columns === 1 ? 'column' : 'columns'} wide. Change width`);
    const taller = head.querySelector('.taller');
    taller.textContent = `⇕ ${rows}`;
    taller.setAttribute('aria-label', `${title} is ${rows} ${rows === 1 ? 'row' : 'rows'} tall. Change height`);
  }

  function cycle(slot, key, fallback, max) {
    const current = workspace.placementOf(slot)[key] ?? fallback;
    resize(slot, { [key]: (current % max) + 1 });
  }

  /** A span of one column, or of the default height, is no span: the tile goes back to the default. */
  function resize(slot, change) {
    const next = { ...workspace.placementOf(slot), ...change };
    if (next.columns === 1) delete next.columns;
    if (next.rows === DEFAULT_ROWS) delete next.rows;
    workspace.place(slot, next);
    describe(slot);
  }

  // ── Moving ─────────────────────────────────────────────────────────────────────────────────
  function moveByKey(slot, grip, event) {
    if (!event.altKey) return;
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = tiles().indexOf(slot);
    workspace.move(slot, at + step);
    grip.focus();
    announce(`${app(slot.getAttribute('name'))?.title} moved to position ${tiles().indexOf(slot) + 1} of ${tiles().length}`);
  }

  /**
   * Follows the pointer and moves the tile into the place of whichever tile it is over, as it goes.
   * Listens on the window rather than capturing the pointer: the grip is inside the tile being
   * moved, and a browser without `moveBefore` drops a capture when its element moves.
   */
  function dragToMove(slot, grip, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    slot.classList.add('dragging');
    document.body.classList.add('moving');
    const follow = (move) => {
      const under = document.elementFromPoint(move.clientX, move.clientY)?.closest?.('fragment-slot');
      if (!under || under === slot || under.parentElement !== desk) return;
      workspace.move(slot, tiles().indexOf(under));
    };
    const end = () => {
      slot.classList.remove('dragging');
      document.body.classList.remove('moving');
      removeEventListener('pointermove', follow);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      grip.focus({ preventScroll: true });
    };
    addEventListener('pointermove', follow);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  // ── Resizing ───────────────────────────────────────────────────────────────────────────────
  /** Snaps the tile to whole columns and rows of the grid as its corner is dragged. */
  function dragToResize(slot, event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const grid = getComputedStyle(desk);
    const columns = grid.gridTemplateColumns.split(' ').filter(Boolean).length;
    if (columns < 2) return; // one column: nothing to span
    const gap = parseFloat(grid.columnGap) || 0;
    const rowGap = parseFloat(grid.rowGap) || 0;
    const columnWidth = (desk.clientWidth - parseFloat(grid.paddingLeft) - parseFloat(grid.paddingRight) - gap * (columns - 1)) / columns;
    const rowHeight = parseFloat(grid.gridAutoRows) || 240;
    const box = slot.getBoundingClientRect();
    slot.classList.add('resizing');
    const follow = (move) => {
      const width = box.width + (move.clientX - event.clientX);
      const height = box.height + (move.clientY - event.clientY);
      resize(slot, {
        columns: clamp(Math.round((width + gap) / (columnWidth + gap)), 1, Math.min(MAX_COLUMNS, columns)),
        rows: clamp(Math.round((height + rowGap) / (rowHeight + rowGap)), 1, MAX_ROWS),
      });
    };
    const end = () => {
      slot.classList.remove('resizing');
      removeEventListener('pointermove', follow);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
    };
    addEventListener('pointermove', follow);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  // ── Keeping every tile's header up to date ─────────────────────────────────────────────────
  // A tile can arrive from the markup, the dock, a restored layout, or the agent launching an app
  // for an intent; each gets its header here. The `state` attribute is Braid's: the seam line
  // follows it.
  const ensure = () => {
    for (const slot of tiles()) if (!slot.querySelector(':scope > .tile-head')) header(slot);
  };
  new MutationObserver((records) => {
    ensure();
    for (const record of records) if (record.type === 'attributes') describe(record.target);
  }).observe(desk, { childList: true, subtree: true, attributes: true, attributeFilter: ['state', 'data-braid-columns', 'data-braid-rows'] });
  ensure();

  return {
    /** Outlines every tile and shows what it is, or stops. */
    setSeams(on) {
      document.body.toggleAttribute('data-seams', on);
      for (const slot of tiles()) describe(slot);
    },
  };
}

function make(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Tells a screen reader what a keyboard move did. */
function announce(message) {
  let live = document.getElementById('tile-announcer');
  if (!live) {
    live = make('p', 'visually-hidden');
    live.id = 'tile-announcer';
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = message;
}
