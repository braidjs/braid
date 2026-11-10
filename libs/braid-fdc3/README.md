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

Give the agent a `container` and it can launch apps:

```ts
const agent = createBraidDesktopAgent({
  directory: applications,
  container: document.getElementById('desk')!, // where fdc3.open and intents mount apps
});
```

- **Launching.** `fdc3.open`, `newInstance: true`, and intents no running app can take mount a
  `<fragment-slot>` in the container.
- **Resolving.** A built-in dialog chooses among several apps; a `resolveIntent` hook replaces it.

Preferences, per-app settings and saved layouts are not part of FDC3 and not part of this package.
They are the workspace in `@braidlabs/console/workspace`, which composes around the agent:

```ts
import { createBraidDesktopAgent, dialogResolver } from '@braidlabs/fdc3';
import { createWorkspace } from '@braidlabs/console/workspace';

const workspace = createWorkspace();
const agent = createBraidDesktopAgent({
  directory: applications,
  container: workspace.container,
  resolveIntent: workspace.intentResolver(dialogResolver(document, { remember: true })),
});
initBraid({ realmGlobals: workspace.realmGlobals(agent.realmGlobals) });
```

Not supported yet: `fdc3.close()`, FDC3 for untrusted or contract fragments, and a live-updating
directory.

Full documentation: https://braidjs.github.io/braid/packages/fdc3
