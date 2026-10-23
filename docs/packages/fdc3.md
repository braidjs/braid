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
`<fragment-slot>` connects:

```ts
import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';

const { applications } = await (await fetch('/__braid/registry/appd/v2/apps')).json();
const agent = createBraidDesktopAgent({ directory: applications });

initBraid({ realmGlobals: agent.realmGlobals });
```

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
| Registry: `createRegistryApi({ appd: { origin, environment } })` → `{basePath}/appd/v2/apps` | HEAD, or an environment's pin (e.g. `production`) | the `read` right |

The registry endpoint is the one to configure in an external desktop agent. With
`environment: 'production'`, agents only resolve to apps that were promoted, and approved if the
environment requires approval. Both endpoints produce records that are validated in Braid's tests
against FDC3 2.2's own App Directory schema.

---

## How it works

The agent is the FINOS reference implementation: `@finos/fdc3-web-impl` provides the agent, and
each fragment's `fdc3` is a `DesktopAgentProxy` from `@finos/fdc3-agent-proxy`. Channel and intent
semantics are therefore FDC3's own. Braid supplies the parts that FDC3 for the Web leaves to the
platform:

- **Identity is known, not claimed.** A fragment's app id is its registry id, which the host
  already knows when it boots the fragment. It is registered under that id directly, with no Web
  Connection Protocol handshake or URL matching.
- **The transport is in-process.** Messages cross as structured clones on a microtask, so neither
  side holds the other's objects.
- **A fragment's lifetime is its slot's.** When a fragment is torn down, its instance is
  terminated: its listeners stop receiving, it leaves its channels, and `findInstances` stops
  reporting it.

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
