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

## Launching and choosing

FDC3 says what `fdc3.open` and a raised intent mean, and leaves how an app is started, and how the
user chooses between apps, to the desktop agent. Give the agent a `container` to launch into:

```ts
import { createBraidDesktopAgent } from '@braidlabs/fdc3';

const agent = createBraidDesktopAgent({
  directory: applications,
  container: document.getElementById('desk')!, // where launched apps mount
});
```

`container` may also be a function returning the element, asked at each launch, for one a
framework renders later or replaces. While it returns nothing, `fdc3.open` rejects with
`ErrorOnLaunch`.

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
  quick raises for an app that isn't running mount it once. If that slot is removed before the app
  listens, as a workspace layout restore does, the intent goes to the instance that replaces it.
- A held intent goes to the instance it was launched for or is waiting on, never to another
  instance of the app that happens to add a listener first.

One case is ambiguous: a fragment that raises the same intent with the same context type twice in
one tick, once with `newInstance: true` and once without, may have the plain raise offered launches
too.

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
`UserCancelledResolution`.

To use your own UI, pass `resolveIntent`. Pass `false` to refuse such raises:

```ts
createBraidDesktopAgent({
  directory,
  resolveIntent: async ({ context, raisedBy, candidates }) => {
    const candidate = await myPicker(candidates); // { intent, appId, instanceId?, starting?, title, icon? }
    return candidate && { candidate };
  },
});
```

A resolver can only pick one of the candidates it was given. Anything else cancels the raise.

The agent keeps nothing between raises. Remembering a choice, hiding apps from the list, and
everything else that outlives the page belongs to the workspace, below.

---

## Preferences, app settings and layouts: the workspace

FDC3 standardizes none of these, so they are not part of this package. They are the workspace in
[`@braidlabs/console/workspace`](./console.md#the-workspace), which works on any Braid page, with
or without FDC3. Beside an agent it composes through the agent's two hooks:

```ts
import { createBraidDesktopAgent, dialogResolver } from '@braidlabs/fdc3';
import { createWorkspace, serverStore } from '@braidlabs/console/workspace';

const workspace = createWorkspace({ store: serverStore() }); // the page's [data-braid-workspace]
const agent = createBraidDesktopAgent({
  directory: applications,
  // launches into the workspace area; hidden apps are never offered, a remembered choice answers
  // without asking, and ticking "Remember my choice" in the dialog is kept
  ...workspace.fdc3(dialogResolver(document, { remember: true })),
});
// each fragment joins its saved or default user channel before its code runs, and gets braidDesktop
initBraid({ realmGlobals: workspace.realmGlobals(agent.realmGlobals) });
```

`workspace.fdc3(resolver)` returns the agent's `container` and `resolveIntent` options. The
container is a function, asked at each launch, so the area may be rendered by a framework after
the agent is created.

`dialogResolver(document, { remember: true })` is the built-in dialog with its **Remember my
choice** box. Without the option the box is not shown, because nothing would keep the choice.

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
