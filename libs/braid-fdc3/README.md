# @braidlabs/fdc3

An FDC3 3.0 Desktop Agent for Braid pages. Every composed fragment gets a `window.fdc3` bound to its
own app identity. Fragments share user channels, app channels and intents, resolved against an FDC3
App Directory that the Braid registry serves.

```ts
import { initBraid } from '@braidlabs/core';
import { createBraidDesktopAgent } from '@braidlabs/fdc3';

// the gateway serves this with createGateway({ registry, discovery: { appd: true } })
const response = await fetch('/__braid/registry/appd/v2/apps');
const applications = response.ok ? (await response.json()).applications : [];
initBraid({ realmGlobals: createBraidDesktopAgent({ directory: applications }).realmGlobals });
```

The agent is built on the FINOS reference implementation (`@finos/fdc3-web-impl` and
`@finos/fdc3-agent-proxy`). Trusted fragments, compat and custom-element, get `window.fdc3` before
their first script runs. A fragment whose id has no directory record gets none.

FDC3 leaves layouts and user preferences to each desktop agent. Braid's are opt-in: give the agent
a `container` and a `store`.

```ts
import { createBraidDesktopAgent, serverStore } from '@braidlabs/fdc3';

const agent = createBraidDesktopAgent({
  directory: applications,
  container: document.getElementById('desk'), // where fdc3.open and intents mount apps
  store: serverStore(), // per signed-in user, on the gateway; localStorageStore() is the default
});

await agent.layouts.save('morning'); // the container's slots, channels and each app's state
await agent.layouts.restore('morning');
await agent.preferences.setHost({ defaultUserChannel: 'fdc3.channel.1', hiddenApps: ['legacy'] });
```

- **Launching.** `fdc3.open`, `newInstance: true`, and intents no running app can take mount a
  `<fragment-slot>` in the container.
- **Resolving.** A built-in dialog chooses among several apps and can remember the choice; a
  `resolveIntent` hook replaces it.
- **App settings.** Each fragment gets `window.braidDesktop.settings`, plus `onSaveLayout` and
  `restoredState` for layouts.

Not supported yet: `fdc3.close()`, FDC3 for untrusted or contract fragments, and a live-updating
directory.

Full documentation: https://braidjs.github.io/braid/packages/fdc3
