# Step 7: Production Hardening, Service Workers & Monitoring

In this final step, you will harden your composed architecture for real-world production deployment:
1. Adding `@braidlabs/sw` to eliminate stale lazy-chunk 404s during rolling updates.
2. Configuring error boundary and fallback UI states for upstream fragment outages.
3. Mounting `@braidlabs/console` to monitor gateway and registry health.

---

## 1. Eliminate Chunk 404s with `@braidlabs/sw`

When a new version of the React billing remote deploys, old chunk hashes (`main.abc123.js`) are purged from the CDN. A user with an active browser tab navigating to a new route would normally hit a white-screen 404.

### Enable Service Worker in Braid Gateway

In `apps/gateway/server.mjs`:

```js
import { createGateway } from '@braidlabs/gateway';

const gateway = createGateway({
  registry: [manifest],
  serviceWorker: true, // Automatically serves sw with 'Service-Worker-Allowed: /'
});
```

### Register the Service Worker in the Angular Shell

In `apps/shell/src/app/app.config.ts`:

```ts
import { inject, provideAppInitializer } from '@angular/core';
import { registerBraidServiceWorker } from '@braidlabs/core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideClientHydration(),
    provideBraid(),
    provideAppInitializer(async () => {
      // Registers the skew-aware service worker on client boot
      await registerBraidServiceWorker({ buildId: '2026.08.25.v1' });
    }),
  ],
};
```

---

## 2. Configure Graceful Degradation & Fallbacks

What happens if the billing service goes down in production? Braid ensures the host shell never crashes.

Update `apps/billing/braid.manifest.json`:

```json
{
  "id": "billing",
  "endpoint": "http://localhost:4201/__braid/frag/billing",
  "pierce": ["/billing", "/billing/*"],
  "timeoutMs": 1500,
  "fallback": "placeholder"
}
```

In the Angular Shell (`apps/shell/src/app/app.component.ts`), handle fallback states:

```html
<braid-fragment
  name="billing"
  [props]="{ accountId: currentAccount() }"
  (failed)="onBillingFailed($event)"
>
  <!-- Slot content rendered if billing upstream is down or times out -->
  <div class="fallback-card" style="padding: 1.5rem; background: #fef2f2; border: 1px solid #f87171; border-radius: 8px;">
    <h3>Billing Service Temporarily Unavailable</h3>
    <p>We are experiencing a temporary delay retrieving invoice records. Other portal features remain active.</p>
  </div>
</braid-fragment>
```

---

## 3. Monitor Registry with `@braidlabs/console`

Install `@braidlabs/console` in the shell or admin app:

```bash
npm install @braidlabs/console
```

Mount the `<RegistryConsole>` component in an internal admin route to inspect active manifest states, route matches, and upstream health:

```tsx
import React from 'react';
import { RegistryConsole } from '@braidlabs/console';
import '@braidlabs/console/styles.css';

export function AdminStatusPage() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Gateway Registry Status</h1>
      <RegistryConsole
        api={{ baseUrl: 'http://localhost:3000' }}
        theme="light"
      />
    </div>
  );
}
```

---

## Summary of What You Built

🎉 **Congratulations!** You have constructed a complete, resilient microfrontend architecture:

1. **True Runtime Composition:** An Angular shell and a React remote composed on a single origin (`http://localhost:3000`) without bundling dependencies together.
2. **Zero Blast Radius:** JavaScript execution runs in hidden iframe realms, and DOM nodes live in Declarative Shadow Roots.
3. **Zero-Layout-Shift SSR Piercing:** The Gateway concurrently streams shell and fragment markup on initial page load.
4. **Local-First Resilient Data:** `@braidlabs/data` and `@braidlabs/skew` store versioned records in IndexedDB that survive offline periods and schema evolutions.
5. **Production Hardened:** Skew-aware service worker chunk caching with `@braidlabs/sw` and graceful timeout degradation.

---

## Next Steps

- Explore the **[Package Reference Docs](../packages/index.md)** for complete API documentation on each `@braidlabs/*` package.
- Read **[Braid Failure Modes](../braid-failure-modes.md)** to learn how Braid diagnoses and recovers from runtime edge cases.
