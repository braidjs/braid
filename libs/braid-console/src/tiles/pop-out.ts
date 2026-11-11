import type { Placement, SavedSlot, Workspace } from '../workspace/workspace.js';

/**
 * Popping an app out of a workspace into a window of its own, and docking it back when that
 * window closes. Two pages take part, both of one origin: the **desk**, whose tile is popped out
 * ({@link PopOutOptions}, given to `arrange`), and the **window**, which opens the app with the
 * state it left with ({@link acceptPopOut}).
 *
 * - The state crosses in `localStorage`, under a one-time handoff id the desk makes up: in the
 *   clear, readable **and writable** by any page of the origin. Fine for a layout's state; worth
 *   knowing before carrying anything private this way. What the window opens with (state, channel,
 *   src, props) is as trustworthy as every page of the origin: an app should treat its
 *   `restoredState` as input, as it would a layout's.
 * - The window signs each message it sends the desk (an HMAC keyed by a secret it read from that
 *   entry, over the whole message and a number that only goes up), and the desk takes no message
 *   it cannot verify or has seen the number of. The secret itself never crosses the channel, so a
 *   page that only listens there cannot forge, alter or replay a message: it cannot take an app
 *   back early, keep it away, or change the state it returns with. A page that also reads storage
 *   in time can. Signing needs Web Crypto, so popping out needs a secure context (https, or
 *   localhost); without one, tiles have no pop-out link.
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
  /**
   * Whether `appId` is one of the host's apps. A desk that reloads takes back only those of what
   * its tab kept, as any page of the origin in that tab could have written it. Default: all.
   */
  accepts?(appId: string): boolean;
  /**
   * How long the desk waits, after a window gives its app back, for it to take the app again: a
   * window that reloads does both. Make it longer than your page takes to call `acceptPopOut` on a
   * slow reload, or a reloading window and the desk both end up with the app. Default
   * {@link RELOAD_GRACE_MS}.
   */
  reloadGraceMs?: number;
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
  /** Stops listening and asking the app for its state; the app stays, and is not given back. */
  dispose(): void;
}

/** How long a popped-out window has to take its app before the desk takes it back. */
export const HANDOFF_TIMEOUT_MS = 10_000;
/** A window that gives its app back may only be reloading: if it takes it again this soon, it keeps it. */
export const RELOAD_GRACE_MS = 1_500;
/** How long a window waits for the desk to write its app's state. */
const HANDOFF_READ_MS = 3_000;
/** How often a window asks its app for its state, besides after each thing the user does. */
const REFRESH_MS = 3_000;
/** The most popped-out apps a desk keeps track of; more kept than this is not the desk's doing. */
const MAX_OUT = 32;
/** A handoff entry older than this, that no desk in this tab is waiting on, is left over: removed. */
const STALE_HANDOFF_MS = 60_000;

const handoffKey = (key: string, id: string) => `${key}handoff/${id}`;
const channelName = (key: string) => `${key}dock`;

/** What the desk keeps of an app it popped out. */
interface Sent {
  appId: string;
  /** What the window read from the handoff entry, and signs its messages with. */
  secret: string;
  /** The number of the last message taken from the window: a message must carry a higher one. */
  seq: number;
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
  /** `taken`: the window has the app. `back`: the window gives it back. */
  kind: 'taken' | 'back';
  seq: number;
  snapshot?: { state?: unknown; channel?: unknown };
  /** HMAC-SHA-256 of the rest, keyed by the handoff's secret, in base64. */
  proof: string;
}

/** Whether this page can pop tiles out: it needs Web Crypto to sign the handoff's messages. */
export const popOutAvailable = () => typeof globalThis.crypto?.subtle?.importKey === 'function';

/** The HMAC of a message's fields, keyed by the handoff's secret: what the desk checks. */
export async function proofOf(secret: string, message: Omit<DockMessage, 'proof'>): Promise<string> {
  const encode = (text: string) => new TextEncoder().encode(text);
  const hmac = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = JSON.stringify([message.handoff, message.appId, message.kind, message.seq, message.snapshot ?? null]);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, encode(signed)));
  return btoa(String.fromCharCode(...bytes));
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
  /** Slots on their way out: a second click while the first is opening a window does nothing. */
  const leaving = new WeakSet<Element>();
  const grace = Number.isFinite(options.reloadGraceMs) && options.reloadGraceMs! >= 0 ? options.reloadGraceMs! : RELOAD_GRACE_MS;
  const dock = new BroadcastChannel(channelName(key));

  // the timers are this page's; everything else is kept
  const keep = () =>
    sessionStorage.setItem(
      outKey,
      JSON.stringify([...out].map(([id, { appId, secret, seq, snapshot, index, taken }]) => [id, { appId, secret, seq, snapshot, index, taken }])),
    );

  /** Gives the window `id` its time to take its app; a window that has taken it gets none. */
  function waitForTaking(id: string) {
    const sent = out.get(id)!;
    clearTimeout(sent.timer);
    if (!sent.taken) sent.timer = setTimeout(() => takeBack(id), HANDOFF_TIMEOUT_MS);
  }

  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(outKey) ?? '[]');
    for (const entry of Array.isArray(kept) ? kept.slice(0, MAX_OUT) : []) {
      const [id, sent] = Array.isArray(entry) ? entry : [];
      if (typeof id !== 'string' || typeof sent?.appId !== 'string' || typeof sent.secret !== 'string') continue;
      if (!sent.snapshot || typeof sent.snapshot !== 'object' || options.accepts?.(sent.appId) === false) continue;
      out.set(id, {
        appId: sent.appId,
        secret: sent.secret,
        seq: Number.isFinite(sent.seq) ? sent.seq : 0,
        snapshot: sent.snapshot,
        index: Number.isInteger(sent.index) ? sent.index : -1,
        taken: sent.taken === true,
      });
    }
  } catch {
    // nothing kept, or not ours to read
  }
  for (const id of out.keys()) waitForTaking(id);
  keep();

  // entries no window ever read (the desk closed before its window started, say), once they are
  // old enough not to be another desk tab's handoff in flight
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const name = localStorage.key(index);
    if (!name?.startsWith(handoffKey(key, '')) || out.has(name.slice(handoffKey(key, '').length))) continue;
    let at: unknown;
    try {
      at = JSON.parse(localStorage.getItem(name) ?? 'null')?.at;
    } catch {
      at = undefined;
    }
    if (typeof at !== 'number' || Date.now() - at > STALE_HANDOFF_MS) localStorage.removeItem(name);
  }

  function takeBack(id: string, change: DockMessage['snapshot'] = {}) {
    const sent = out.get(id);
    if (!sent) return;
    out.delete(id);
    keep();
    clearTimeout(sent.timer);
    clearTimeout(sent.returning);
    localStorage.removeItem(handoffKey(key, id));
    const snapshot: Omit<SavedSlot, 'appId'> = { ...sent.snapshot };
    // what the channel carries is any structured-clone value; only JSON is a state
    const state = asJson(change.state);
    if (state !== undefined) snapshot.state = state;
    if (typeof change.channel === 'string') snapshot.channel = change.channel;
    const slot = workspace.open(sent.appId, snapshot as { placement?: Placement; state?: unknown; channel?: string });
    // back where it was, and the size it was
    if (sent.index >= 0) workspace.move(slot, sent.index);
    options.onReturned?.(slot, sent.appId);
  }

  /** Checks a message from a window: one the desk sent an app to, signed with its secret, and new. */
  async function verified(data: DockMessage): Promise<Sent | undefined> {
    if (typeof data?.handoff !== 'string' || typeof data.proof !== 'string' || !Number.isFinite(data.seq)) return undefined;
    if (data.kind !== 'taken' && data.kind !== 'back') return undefined;
    const sent = out.get(data.handoff);
    if (!sent || sent.appId !== data.appId || data.seq <= sent.seq) return undefined;
    const snapshot = data.snapshot && typeof data.snapshot === 'object' ? data.snapshot : undefined;
    let expected: string;
    try {
      expected = await proofOf(sent.secret, { handoff: data.handoff, appId: data.appId, kind: data.kind, seq: data.seq, snapshot });
    } catch {
      return undefined;
    }
    // still out, and still newer than any message taken while this one was being checked
    if (expected !== data.proof || out.get(data.handoff) !== sent || data.seq <= sent.seq) return undefined;
    sent.seq = data.seq;
    return sent;
  }

  // one message at a time, in the order they came: checking each is asynchronous
  let checking = Promise.resolve();
  dock.addEventListener('message', ({ data }: MessageEvent<DockMessage>) => {
    checking = checking.then(() => receive(data)).catch(() => undefined);
  });

  async function receive(data: DockMessage) {
    const sent = await verified(data);
    if (!sent) return;
    clearTimeout(sent.returning);
    // taken: the window has the app now, and gives it back when it closes
    if (data.kind === 'taken') {
      sent.taken = true;
      waitForTaking(data.handoff);
      keep();
      return;
    }
    keep();
    const snapshot = data.snapshot && typeof data.snapshot === 'object' ? data.snapshot : {};
    sent.returning = setTimeout(() => takeBack(data.handoff, snapshot), grace);
  }

  return {
    async popOut(slot) {
      // one of the area's apps, before any window opens for it
      if (!slots().includes(slot)) throw new Error('braid-tiles: can only pop out an app in the workspace area');
      if (leaving.has(slot)) return;
      if (!popOutAvailable()) throw new Error('braid-tiles: popping out needs Web Crypto, which a page has only in a secure context');
      const appId = slot.getAttribute('name')!;
      const id = crypto.randomUUID();
      const secret = crypto.randomUUID();
      // the handoff is this origin's storage: a window anywhere else could never take the app
      const href = sameOrigin(options.url(appId, id));
      if (!href) throw new Error('braid-tiles: popOut.url must give a URL of this origin');
      // opened straight from the click, so a popup blocker lets it through; filled in a moment later
      const popup = window.open(href, `braid-tile-${id}`, options.features ?? 'popup,width=760,height=720');
      if (!popup) return options.onBlocked?.(appId);
      leaving.add(slot);
      // the window needs nothing of the desk's but what crosses in storage
      try {
        popup.opener = null;
      } catch {
        // not ours to change
      }
      try {
        const { appId: _appId, ...snapshot } = await workspace.snapshot(slot);
        const index = slots().indexOf(slot);
        // storage full or off: the window gets nothing, so it is closed and the app stays
        localStorage.setItem(handoffKey(key, id), JSON.stringify({ appId, secret, snapshot, at: Date.now() }));
        out.set(id, { appId, secret, seq: 0, snapshot, index });
      } catch (error) {
        popup.close();
        leaving.delete(slot);
        throw error;
      }
      waitForTaking(id);
      try {
        keep();
      } catch {
        // a desk that reloads will not take this one back; this page still will
      }
      slot.remove();
      leaving.delete(slot);
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
  let given: { appId?: unknown; secret?: unknown; snapshot?: Omit<SavedSlot, 'appId'> } | undefined;
  // `window.open` gave this tab a copy of the desk's sessionStorage: what the desk popped out is the
  // desk's to take back, not this window's, should this page arrange its tiles with popOut too
  sessionStorage.removeItem(`${key}out`);
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
  const fromDesk = Boolean(handoff) && given?.appId === appId && typeof given?.secret === 'string' && popOutAvailable();
  const secret = given?.secret as string;
  const { placement: _placement, ...snapshot } = (fromDesk && given?.snapshot && typeof given.snapshot === 'object' ? given.snapshot : {}) as Omit<SavedSlot, 'appId'>;
  const slot = workspace.open(appId, snapshot as { state?: unknown; channel?: string });
  if (!fromDesk) return { slot, fromDesk, dockBack: async () => window.close(), dispose: () => undefined };

  const dock = new BroadcastChannel(channelName(key));
  // numbers that only go up, across a reload of this window too: the desk takes each once
  let count = 0;
  const signed = async (kind: DockMessage['kind'], snapshot?: DockMessage['snapshot']): Promise<DockMessage> => {
    const message = { handoff: handoff!, appId, kind, seq: Date.now() * 1000 + (count++ % 1000), ...(snapshot ? { snapshot } : {}) };
    return { ...message, proof: await proofOf(secret, message) };
  };
  void signed('taken').then((message) => dock.postMessage(message));
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
        await prepare();
      } finally {
        asking = undefined;
      }
    })());
  // after anything the user does in the app (once the app has handled it), and every few seconds
  // besides, for state the app changes by itself
  const soon = () => setTimeout(refresh);
  const types = ['click', 'keyup', 'change', 'input'];
  for (const type of types) document.addEventListener(type, soon, true);
  const ticking = setInterval(refresh, REFRESH_MS);
  /**
   * The give-back, signed ahead of time with the latest state: a window that is closing has no
   * time to wait for a signature, so `pagehide` posts what is ready.
   */
  let ready: DockMessage | undefined;
  async function prepare() {
    const message = await signed('back', JSON.parse(JSON.stringify(latest)));
    if (!ready || message.seq > ready.seq) ready = message;
  }
  await prepare();
  let returned = false;
  const giveBack = () => {
    if (returned || !ready) return;
    returned = true;
    dock.postMessage(ready);
  };
  // A page kept in the back-forward cache may come back; it has not closed. One that is reloading
  // gives its app back too (pagehide cannot tell), but keeps it here, and takes it up again in
  // time for the desk to leave it be.
  const hide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    sessionStorage.setItem(soloKey, JSON.stringify({ handoff, appId, secret, snapshot: { ...snapshot, ...latest } }));
    giveBack();
  };
  addEventListener('pagehide', hide);
  return {
    slot,
    fromDesk,
    async dockBack() {
      await refresh();
      giveBack();
      sessionStorage.removeItem(soloKey);
      window.close();
    },
    dispose() {
      for (const type of types) document.removeEventListener(type, soon, true);
      clearInterval(ticking);
      removeEventListener('pagehide', hide);
      dock.close();
    },
  };
}

/** `value` as JSON would keep it, or undefined when it is none (a BigInt, say, or a cycle). */
function asJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** `url` resolved against this page, when it is of this page's origin; otherwise undefined. */
export function sameOrigin(url: string): string | undefined {
  try {
    const resolved = new URL(url, location.href);
    return resolved.origin === location.origin ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}
