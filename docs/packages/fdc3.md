# @braidlabs/fdc3

An FDC3 2.2 Desktop Agent for Braid pages. Every composed fragment gets a `window.fdc3` bound to its
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
  arrives, or for up to 20 seconds, rather than lost. Raising by app (`{ appId: 'billing' }`)
  resolves to that app's live instance.

---

## What is not supported yet

- **Launching apps.** `fdc3.open()` rejects with `ErrorOnLaunch`. An intent raised to an app with
  no mounted instance rejects with `NoAppsFound`, because nothing can mount a fragment on the
  agent's behalf yet.
- **An intent resolver UI.** When a raise matches more than one live instance, it rejects with
  `UserCancelledResolution`. To choose without a UI, name the target:
  `raiseIntent(intent, context, instance)`.
- **Untrusted and contract fragments.** `trust="untrusted"` (cross-origin) and contract-mode
  fragments do not get `window.fdc3`, matching how `realmGlobals` treats them.
- **A live directory.** The directory is read once, when the agent is created. Apps added to the
  registry later are not seen until the page reloads.
- **Bounded state.** The agent keeps the last context of each type on each channel, and every app
  channel that was ever created, for the life of the page. That is FINOS's behaviour, and it means
  a fragment that broadcasts many distinct context types grows the agent's memory.
