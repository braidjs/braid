import type { Placement, SavedSlot, Workspace } from '../workspace/workspace.js';

/**
 * Popping an app out of a workspace into a window of its own, and docking it back when that
 * window closes. Two pages take part, both of one origin: the **desk**, whose tile is popped out
 * ({@link PopOutOptions}, given to `arrange`), and the **window**, which opens the app with the
 * state it left with ({@link acceptPopOut}).
 *
 * - The state crosses in `localStorage`, under a one-time handoff id the desk makes up: in the
 *   clear, to any page of the origin. Fine for a layout's state; worth knowing before carrying
 *   anything private this way.
 * - Only what the desk popped out comes back, once each, with the src, props, span and place the
 *   desk kept. The window returns only the app's state and channel, and anything else that arrives
 *   on the channel is ignored.
 * - A window that never takes its app (blocked, closed at once, never started) gives it back after
 *   {@link HANDOFF_TIMEOUT_MS}. A window that gives it back and takes it again within
 *   {@link RELOAD_GRACE_MS} was only reloading, and keeps it.
 * - The desk keeps what it popped out in its tab's `sessionStorage`, so a desk that reloads still
 *   takes back what it popped out before.
 */
export interface PopOutOptions {
  /**
   * The URL of the window for an app: the host's page, holding that one app. With a `handoff` id it
   * is the window the desk opens; without one, the link a modified click (Cmd, Ctrl, Shift) opens
   * as a copy, as any link would.
   */
  url(appId: string, handoff?: string): string;
  /**
   * Names the storage keys and the channel the desk and its windows share. Two desks on one origin
   * with the same key take each other's apps back; put the page's path in it.
   */
  key: string;
  /** `window.open` features. Defaults to a popup of 760 × 720. */
  features?: string;
  /** The app is in its own window now. */
  onPoppedOut?(appId: string): void;
  /** The browser kept the window from opening; the app stays where it was. */
  onBlocked?(appId: string): void;
  /** The app is back in the workspace, in `slot`. */
  onReturned?(slot: Element, appId: string): void;
}

export interface AcceptPopOutOptions {
  /** The same key the desk was given. */
  key: string;
  /** The app this window holds: the desk's `url` put it in the window's URL. */
  appId: string;
  /** The handoff id from the window's URL; none for a copy opened in a tab. */
  handoff?: string | null;
}

export interface AcceptedPopOut {
  /** The app's slot in this window's workspace. */
  slot: Element;
  /** True when the app came from a desk and goes back to it; false for a copy. */
  fromDesk: boolean;
  /** Gives the app back to the desk now, with its latest state, and closes the window. */
  dockBack(): Promise<void>;
}

/** How long a popped-out window has to take its app before the desk takes it back. */
export const HANDOFF_TIMEOUT_MS = 10_000;
/** A window that gives its app back may only be reloading: if it takes it again this soon, it keeps it. */
export const RELOAD_GRACE_MS = 1_500;
/** How long a window waits for the desk to write its app's state. */
const HANDOFF_READ_MS = 3_000;
/** How often a window asks its app for its state, besides after each thing the user does. */
const REFRESH_MS = 3_000;

const handoffKey = (key: string, id: string) => `${key}handoff/${id}`;
const channelName = (key: string) => `${key}dock`;

/** What the desk keeps of an app it popped out. */
interface Sent {
  appId: string;
  snapshot: Omit<SavedSlot, 'appId'>;
  index: number;
  taken?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  returning?: ReturnType<typeof setTimeout>;
}

/** What crosses between a window and its desk. */
interface DockMessage {
  handoff: string;
  appId: string;
  taken?: boolean;
  snapshot?: { state?: unknown; channel?: unknown };
}

/** The desk's half: pops tiles out, and takes them back. */
export interface PopOutDesk {
  popOut(slot: Element): Promise<void>;
  close(): void;
}

export function popOutDesk(workspace: Workspace, options: PopOutOptions, slots: () => Element[]): PopOutDesk {
  const { key } = options;
  const outKey = `${key}out`;
  const out = new Map<string, Sent>();
  const dock = new BroadcastChannel(channelName(key));

  // the timers are this page's; everything else is kept
  const keep = () =>
    sessionStorage.setItem(outKey, JSON.stringify([...out].map(([id, { appId, snapshot, index, taken }]) => [id, { appId, snapshot, index, taken }])));

  /** Gives the window `id` its time to take its app; a window that has taken it gets none. */
  function waitForTaking(id: string) {
    const sent = out.get(id)!;
    clearTimeout(sent.timer);
    if (!sent.taken) sent.timer = setTimeout(() => takeBack(id), HANDOFF_TIMEOUT_MS);
  }

  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(outKey) ?? '[]');
    for (const entry of Array.isArray(kept) ? kept : []) {
      const [id, sent] = Array.isArray(entry) ? entry : [];
      if (typeof id === 'string' && typeof sent?.appId === 'string' && sent.snapshot && typeof sent.snapshot === 'object') {
        out.set(id, { appId: sent.appId, snapshot: sent.snapshot, index: Number.isInteger(sent.index) ? sent.index : -1, taken: sent.taken === true });
      }
    }
  } catch {
    // nothing kept, or not ours to read
  }
  for (const id of out.keys()) waitForTaking(id);

  function takeBack(id: string, change: DockMessage['snapshot'] = {}) {
    const sent = out.get(id);
    if (!sent) return;
    out.delete(id);
    keep();
    clearTimeout(sent.timer);
    clearTimeout(sent.returning);
    localStorage.removeItem(handoffKey(key, id));
    const snapshot: Omit<SavedSlot, 'appId'> = { ...sent.snapshot };
    if (change.state !== undefined) snapshot.state = change.state;
    if (typeof change.channel === 'string') snapshot.channel = change.channel;
    const slot = workspace.open(sent.appId, snapshot as { placement?: Placement; state?: unknown; channel?: string });
    // back where it was, and the size it was
    if (sent.index >= 0) workspace.move(slot, sent.index);
    options.onReturned?.(slot, sent.appId);
  }

  dock.addEventListener('message', ({ data }: MessageEvent<DockMessage>) => {
    if (typeof data?.handoff !== 'string') return;
    const sent = out.get(data.handoff);
    if (!sent || sent.appId !== data.appId) return;
    clearTimeout(sent.returning);
    // taken: the window has the app now, and gives it back when it closes
    if (data.taken === true) {
      sent.taken = true;
      waitForTaking(data.handoff);
      keep();
      return;
    }
    const snapshot = data.snapshot && typeof data.snapshot === 'object' ? data.snapshot : {};
    sent.returning = setTimeout(() => takeBack(data.handoff, snapshot), RELOAD_GRACE_MS);
  });

  return {
    async popOut(slot) {
      const appId = slot.getAttribute('name')!;
      const id = crypto.randomUUID();
      // opened straight from the click, so a popup blocker lets it through; filled in a moment later
      const popup = window.open(options.url(appId, id), `braid-tile-${id}`, options.features ?? 'popup,width=760,height=720');
      if (!popup) return options.onBlocked?.(appId);
      const { appId: _appId, ...snapshot } = await workspace.snapshot(slot);
      const index = slots().indexOf(slot);
      localStorage.setItem(handoffKey(key, id), JSON.stringify({ appId, snapshot }));
      out.set(id, { appId, snapshot, index });
      waitForTaking(id);
      keep();
      slot.remove();
      options.onPoppedOut?.(appId);
    },
    close() {
      dock.close();
      for (const sent of out.values()) {
        clearTimeout(sent.timer);
        clearTimeout(sent.returning);
      }
    },
  };
}

/**
 * In the window a tile was popped out to: opens the app in this page's workspace with the state it
 * left the desk with, and gives it back, with its latest state, when the window closes. A window
 * the desk did not open (a copy, opened by a modified click) gets the app fresh, with nothing to
 * give back.
 *
 * The app fills the window, so the span it had on the desk is left behind; the desk keeps it.
 */
export async function acceptPopOut(workspace: Workspace, options: AcceptPopOutOptions): Promise<AcceptedPopOut> {
  const { key, appId, handoff } = options;
  // what this window held when it last unloaded: a reload takes it up again
  const soloKey = `${key}solo`;
  let given: { appId?: unknown; snapshot?: Omit<SavedSlot, 'appId'> } | undefined;
  try {
    const kept = JSON.parse(sessionStorage.getItem(soloKey) ?? 'null');
    if (handoff && kept?.handoff === handoff && kept.appId === appId) given = kept;
  } catch {
    given = undefined;
  }
  if (handoff && !given) {
    const read = () => localStorage.getItem(handoffKey(key, handoff));
    let raw = read();
    // the desk writes it a moment after opening this window
    for (let waited = 0; !raw && waited < HANDOFF_READ_MS; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      raw = read();
    }
    localStorage.removeItem(handoffKey(key, handoff));
    try {
      given = raw ? JSON.parse(raw) : undefined;
    } catch {
      given = undefined;
    }
  }
  const fromDesk = Boolean(handoff) && given?.appId === appId;
  const { placement: _placement, ...snapshot } = (fromDesk && given?.snapshot && typeof given.snapshot === 'object' ? given.snapshot : {}) as Omit<SavedSlot, 'appId'>;
  const slot = workspace.open(appId, snapshot as { state?: unknown; channel?: string });
  if (!fromDesk) return { slot, fromDesk, dockBack: async () => window.close() };

  const dock = new BroadcastChannel(channelName(key));
  dock.postMessage({ handoff, appId, taken: true });
  // kept fresh, because a window that is closing has no time to ask its app for its state
  const latest: { state?: unknown; channel?: string } = snapshot.state !== undefined ? { state: snapshot.state } : {};
  let asking: Promise<void> | undefined;
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
  setInterval(refresh, REFRESH_MS);
  let returned = false;
  const giveBack = () => {
    if (returned) return;
    returned = true;
    dock.postMessage({ handoff, appId, snapshot: latest });
  };
  // A page kept in the back-forward cache may come back; it has not closed. One that is reloading
  // gives its app back too (pagehide cannot tell), but keeps it here, and takes it up again in
  // time for the desk to leave it be.
  addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    sessionStorage.setItem(soloKey, JSON.stringify({ handoff, appId, snapshot: { ...snapshot, ...latest } }));
    giveBack();
  });
  return {
    slot,
    fromDesk,
    async dockBack() {
      await refresh();
      giveBack();
      sessionStorage.removeItem(soloKey);
      window.close();
    },
  };
}
