# @braidlabs/fdc3

An FDC3 3.0 Desktop Agent for Braid pages. Every composed fragment gets a `window.fdc3` bound to its
own app identity, so FDC3 apps share user channels, app channels and intents across fragments,
resolved against an FDC3 App Directory that the Braid registry serves.

---

## Installation

```bash
npm install @braidlabs/fdc3
```

---

## Usage

Load the directory, create the agent, and hand its `realmGlobals` hook to `initBraid`. Do this before any
`<fragment-slot>` connects. The gateway serves the directory when discovery has `appd: true`:

```ts
import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';

// createGateway({ registry, discovery: { appd: true } }) on the server
const response = await fetch('/__braid/registry/appd/v2/apps');
const applications = response.ok ? (await response.json()).applications : [];
const agent = createBraidDesktopAgent({ directory: applications });

initBraid({ realmGlobals: agent.realmGlobals });
```

A directory that fails to load leaves fragments without `fdc3` rather than stopping the page from
composing.

A fragment is an FDC3 app with no changes to its code. `window.fdc3` exists before its first script
runs, and `getAgent()` from `@finos/fdc3` finds it:

```ts
// inside the blotter fragment
await fdc3.joinUserChannel('fdc3.channel.1');
await fdc3.broadcast({ type: 'fdc3.instrument', id: { ticker: 'AAPL' } });

// inside the billing fragment
await fdc3.addIntentListener('ViewInvoice', async (instrument) => ({ type: 'fdc3.invoice', id: { invoice: 'INV-1' } }));
```

---

## Where the directory comes from

Each fragment's `fdc3` and `appd` manifest blocks become an App Directory record:

```ts
{ id: 'billing', endpoint: '…', pierce: ['/billing/*'],
  fdc3: { listensFor: { ViewInvoice: { contexts: ['fdc3.instrument'] } },
          raises: { ViewChart: ['fdc3.instrument'] },
          userChannels: { broadcasts: ['fdc3.instrument'] } },
  appd: { publisher: 'Payments', icons: [{ src: '/billing.png' }] } }
```

Either of two endpoints serves those records:

| Endpoint | Serves | Filtered by |
| :--- | :--- | :--- |
| Gateway: `discovery: { appd: true }` → `/__braid/registry/appd/v2/apps` | what this gateway is serving | the caller's `access.list` |
| Registry: `createRegistryApi({ appd: { origin, environment } })` → `{basePath}/appd/v2/apps` | HEAD, or an environment's pin (e.g. `production`) | the `read` right, or `read:directory` alone |

For a page's own agent, use the gateway endpoint: it shows each user only the apps they may list.
The registry endpoint is the governed, organization-wide directory, for an external desktop agent
or a catalog. With `environment: 'production'`, it lists only apps that were promoted, and approved
if the environment requires approval. It is not filtered per user. To open it to agents without also
opening `/head` (which returns whole manifests), grant `read:directory` rather than `read`. Both
endpoints produce records that Braid's tests validate against FDC3 2.2's own App Directory schema.
Links that are not http(s), such as `javascript:` icons, are dropped.

---

## How it works

The agent is the FINOS reference implementation: `@finos/fdc3-web-impl` provides the agent, and
each fragment's `fdc3` is a `DesktopAgentProxy` from `@finos/fdc3-agent-proxy`. Channel and intent
semantics are therefore FDC3's own. Braid supplies the parts that FDC3 for the Web leaves to the
platform:

- **Identity is known, not claimed.** A fragment's app id is its registry id, which the host
  already knows when it boots the fragment. It is registered under that id directly, with no Web
  Connection Protocol handshake or URL matching. Nothing reachable from a fragment's `fdc3` leads
  to the agent or to another instance, so through FDC3 a fragment can only speak as itself. Trusted
  fragments are same-origin, though, and the trusted tier is not a security boundary. Don't
  authorize on `metadata.source` against fragment code you don't trust.
- **The transport is in-process.** Messages cross as structured clones, one task per message as
  a MessagePort delivers them, so neither side holds the other's objects. A context that cannot be
  cloned is refused with `MalformedContext`. A handler that throws is reported, and the fragment's
  other listeners still run.
- **A fragment's lifetime is its slot's.** When a fragment is torn down, its instance is
  terminated: its listeners stop receiving, it leaves its channels, `findInstances` stops
  reporting it, and any call still pending is answered with `AgentDisconnected`.
- **Intents wait for a fragment that is still booting.** A fragment is mounted before its bundle
  has added its intent listener. An intent raised to it in that window is held until the listener
  arrives, or for up to 20 seconds, rather than lost. `raiseIntent` by app (`{ appId: 'billing' }`)
  resolves to that app's live instance. A raise with `newInstance: false` and no target is not
  held: while the app's only instance is still booting, it rejects with `TargetInstanceUnavailable`.
- **FDC3 3.0 metadata comes through.** A `traceId` passed to `broadcast` or `raiseIntent` reaches
  the receiver's metadata, and `getCurrentContextWithMetadata`, `clearContext` and the
  `contextCleared` event work across fragments. A listener added with
  `addIntentListenerWithContext` gets only raises of its context types. A raise with no context
  arrives as `fdc3.nothing`, so it reaches only a fragment whose manifest lists `fdc3.nothing` among
  that intent's `contexts`. As in FINOS 3.0, a directory record whose `fdc3Version` range excludes 3.0 is ignored; the
  records Braid serves set no `fdc3Version`.

---

## The workspace: launching, choosing, preferences, layouts

FDC3 standardizes the App Directory but not layouts or user preferences. Those are features each
desktop agent provides itself, and these are Braid's. Give the agent a `container` and a `store`:

```ts
import { createBraidDesktopAgent, serverStore } from '@braidlabs/fdc3';

const agent = createBraidDesktopAgent({
  directory: applications,
  container: document.getElementById('desk')!, // where launched apps mount; what layouts save
  store: serverStore(), // or localStorageStore(), the default
});
```

### Launching

With a `container`, launching an app means mounting a `<fragment-slot name="{appId}">` at the end
of it:

- `fdc3.open({ appId }, context?)` resolves with the new instance's `AppIdentifier`. The context
  reaches the instance's first context listener for its type. An app the directory doesn't have
  rejects with `AppNotFound`.
- An intent that no running app can take launches the app that declares it, and the intent is
  delivered once that fragment adds its listener.
- `raiseIntent(intent, context, app, true)` (`newInstance: true`) launches a new instance even
  when one is running, and the intent goes to that new instance.
- An intent for an app that is already open but not listening yet (still booting, or mounted in
  the container and not yet connected) waits for that instance instead of launching another. So two
  quick raises for an app that isn't running mount it once.

Without a container nothing is launched. `fdc3.open` rejects with `ErrorOnLaunch` and a
`newInstance: true` raise with `TargetAppUnavailable`, as they always have. A raise that only an app
with no instance could take rejects with `NoAppsFound`.

### Choosing an app for an intent

When more than one app can take a raise, the agent asks a resolver. In a browser the default is a
built-in modal dialog. Each choice is marked:

- **open**: a running instance that listens for the intent;
- **starting**: an app that is open but not listening yet, so choosing it waits for that instance;
- **new**: an app with no instance, so choosing it launches one.

A `newInstance: true` raise is offered only **new** entries, one for each app that declares the
intent. Tab moves between choices, Enter picks one and Escape cancels, which rejects the raise with
`UserCancelledResolution`. Ticking **Remember my choice** saves the app for that intent and context
type, and the next raise goes straight to it. If that app is no longer a candidate, the dialog comes
back.

To use your own UI, pass `resolveIntent`. Pass `false` to refuse such raises:

```ts
createBraidDesktopAgent({
  directory,
  resolveIntent: async ({ context, raisedBy, candidates }) => {
    const candidate = await myPicker(candidates); // { intent, appId, instanceId?, starting?, title, icon? }
    return candidate && { candidate, remember: true };
  },
});
```

A resolver can only pick one of the candidates it was given. Anything else cancels the raise.

### Preferences

```ts
await agent.preferences.setHost({ defaultUserChannel: 'fdc3.channel.1', hiddenApps: ['legacy-chart'] }); // replaces, does not merge
await agent.preferences.getHost(); // { defaultUserChannel: 'fdc3.channel.1', hiddenApps: ['legacy-chart'] }
await agent.preferences.intentChoice('ViewChart', 'fdc3.instrument'); // 'chart', or undefined
await agent.preferences.forgetIntentChoice('ViewChart', 'fdc3.instrument');
```

- `defaultUserChannel` is joined for every fragment before its code runs.
- The agent reads these once, when the first fragment connects, and keeps them; `setHost` updates
  the kept copy. A store that takes longer than a second to answer is skipped. Fragments connect
  without the preferences rather than waiting, and the next connect tries the store again.
- `hiddenApps` are never offered as a choice. When hiding apps leaves one candidate, the raise goes
  to it without asking; when it leaves none, the raise rejects with `UserCancelledResolution`.
  Hiding governs the choice, not delivery: an app that is the only one able to take an intent
  still gets it.

### App settings: `window.braidDesktop`

Each fragment gets `braidDesktop` alongside `fdc3`:

```ts
// inside the billing fragment
await braidDesktop.settings.set('columns', ['due', 'amount']);
await braidDesktop.settings.get('columns'); // ['due', 'amount'], after a reload too
await braidDesktop.settings.keys();
await braidDesktop.settings.delete('columns');
```

Settings belong to the app and the user, and every instance of the app shares them. One app can't
name another app's keys through `braidDesktop`. That keeps apps' settings apart, but it is not a
security boundary: trusted fragments share the page's origin, so code that wants to can reach the
store directly. With `serverStore`, separation *between users* is enforced by the gateway.

### Layouts

A layout is the container's `<fragment-slot>`s, in order: each one's app, `src` and `props`, the
user channel its instance is on, and whatever state the app gives when the layout is saved.

```ts
await agent.layouts.save('morning');
await agent.layouts.list(); // ['morning']
await agent.layouts.restore('morning'); // replaces the container's slots
await agent.layouts.delete('morning');
```

```ts
// inside a fragment
braidDesktop.onSaveLayout(() => ({ tab: currentTab })); // must be JSON; 2 seconds at most
if (braidDesktop.restoredState) showTab(braidDesktop.restoredState.tab);
```

Restoring mounts fresh slots, rejoins each to its saved channel, and hands each app its saved state
as `braidDesktop.restoredState`. A saved slot for an app the directory doesn't have (or no longer
has) comes back as a plain slot, without FDC3, channel or state. Slots outside the
container aren't saved or touched.

### Where it is all kept

All of it lives in the `store`, under keys like `host`, `intents/{intent}/{contextType}`,
`apps/{appId}/{key}` and `layouts/{name}`:

| Store | Kept | Per |
| :--- | :--- | :--- |
| `localStorageStore()` (default) | in `localStorage`, under `braid.fdc3/` | origin and browser profile |
| `serverStore({ url })` | on the gateway, `createGateway({ preferences })` | signed-in user, in any browser |
| `memoryStore()` | in memory, until reload | page |

Any object with `get`, `set`, `delete` and `list` is a `PreferenceStore`. If the store can't be
read, fragments still connect, just without preferences. Setting up the gateway side is described
under [Per-user preferences](./gateway.md#per-user-preferences-opt-in).

---

## What is not supported yet

- **Closing apps.** `fdc3.close()` rejects with `ErrorOnClose`: a fragment is torn down by its
  host. To launch at all, the agent needs a `container` (see above).
- **Untrusted and contract fragments.** `trust="untrusted"` (cross-origin) and contract-mode
  fragments do not get `window.fdc3`, matching how `realmGlobals` treats them.
- **A live directory.** The directory is read once, when the agent is created. Apps added to the
  registry later are not seen until the page reloads.
- **Bounded state.** The agent keeps the last context of each type on each channel, and every app
  channel that was ever created, for the life of the page. That is FINOS's behaviour, and it means
  a fragment that broadcasts many distinct context types grows the agent's memory.
- **Shared layouts and window geometry.** A layout belongs to one user, and records slots in order,
  not sizes or positions.
