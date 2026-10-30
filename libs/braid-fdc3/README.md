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

An intent raised to a fragment that is mounted but still booting is held until its listener
arrives. Not supported yet: `fdc3.open()`, `fdc3.close()`, raising with `newInstance: true`, and
launching apps that aren't mounted; an intent resolver UI; and FDC3 for untrusted or contract
fragments.

Full documentation: https://braidjs.github.io/braid/packages/fdc3
