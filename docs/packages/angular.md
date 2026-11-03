# @braidlabs/angular

Angular bindings for Braid. Provides a typed `<braid-fragment>` standalone component, signal-based state hooks, and `provideBraid()` to synchronize host navigation with the Angular Router.

---

## Installation

```bash
npm install @braidlabs/angular @braidlabs/core
```

---

## Setup & Provider Registration

Register `provideBraid()` in your `app.config.ts` or `bootstrapApplication`:

```ts
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideClientHydration } from '@angular/platform-browser';
import { provideBraid } from '@braidlabs/angular';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideClientHydration(),
    provideBraid(), // Wires NavigationEnd events to bound fragments
  ],
};
```

---

## Component Usage

Import the standalone `BraidFragmentComponent` into your Angular components:

```ts
import { Component, signal } from '@angular/core';
import { BraidFragmentComponent } from '@braidlabs/angular';

@Component({
  selector: 'app-checkout-page',
  standalone: true,
  imports: [BraidFragmentComponent],
  template: `
    <div class="checkout-container">
      <h2>Host Checkout Shell</h2>

      <braid-fragment
        name="billing"
        [props]="{ cartId: cartId(), theme: 'dark' }"
        (ready)="onFragmentReady($event)"
        (failed)="onFragmentFailed($event)"
        (fragmentEvent)="onFragmentEvent($event)"
      />
    </div>
  `,
})
export class CheckoutPageComponent {
  cartId = signal('cart_109283');

  onFragmentReady(event: { fragmentId: string }) {
    console.log(`Fragment ${event.fragmentId} mounted!`);
  }

  onFragmentFailed(err: any) {
    console.error('Fragment failed to load:', err);
  }

  onFragmentEvent(event: { type: string; detail: unknown }) {
    if (event.type === 'invoice:paid') {
      console.log('Payment complete:', event.detail);
    }
  }
}
```

---

## Asking before leaving unsaved work

`braidLeaveGuard` is a `canDeactivate` guard. It asks before the router leaves a route while a fragment on the page holds unsaved work (`env.setDirty`):

```ts
import { braidLeaveGuard } from '@braidlabs/angular';

export const routes: Routes = [
  {
    path: 'billing',
    component: BillingPage,
    canDeactivate: [braidLeaveGuard((slots) => confirm(`You have ${slots.length} unsaved form(s). Leave anyway?`))],
  },
];
```

The guard runs before the URL changes, so declining leaves the router and the address bar where they were. With nothing unsaved it lets the navigation through without asking. For links that leave the app, use `initBraid({ confirmLeave })` (see the core docs).

## Component API Reference

| Input / Output / Signal | Type | Description |
| :--- | :--- | :--- |
| `[name]` | `string` (Required) | The fragment ID registered in the gateway manifest. |
| `[src]` | `string` | Fixed sub-route to render. If omitted, fragment follows host URL. |
| `[props]` | `Record<string, unknown>` | Structured-cloned properties passed across the realm boundary. |
| `(ready)` | `EventEmitter<{ fragmentId: string }>` | Emitted when fragment completes mounting and hydration. |
| `(failed)` | `EventEmitter<BraidFragmentError>` | Emitted on load/mount error with failure stage & fix hint. |
| `(fragmentEvent)` | `EventEmitter<{ type: string; detail: unknown }>` | Emitted when fragment dispatches a custom event. |
| content | projected | `<div slot="loading">` and `<p slot="fallback">` children reach the slot: shown while the fragment boots, and if it fails. See `@braidlabs/core`, "Loading and fallback". |
| `state()` | `Signal<'idle' \| 'loading' \| 'ready' \| 'error'>` | Signal reflecting current slot lifecycle state. |
| `reload()` | `() => Promise<void>` | Destroys current realm and forces a fresh network fetch & boot. |

---

## Hydration Requirement

When using SSR composition with Braid Gateway, enable Angular client hydration via `provideClientHydration()`. Without hydration, Angular discards server-rendered DOM elements, which would destroy the pierced Shadow DOM slot that Braid Gateway injected during SSR.
