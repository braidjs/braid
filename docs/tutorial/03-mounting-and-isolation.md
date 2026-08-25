# Step 3: Mounting with Shadow DOM & Isolated Realms

In this step, you will wire the Angular host application to mount the React billing fragment using `@braidlabs/angular` and inspect how Braid achieves complete CSS encapsulation and JavaScript realm isolation.

---

## 1. Install Angular Bindings in Host

In your monorepo, install `@braidlabs/angular`:

```bash
npm install @braidlabs/angular
```

---

## 2. Register `provideBraid()` in Angular Config

Open `apps/shell/src/app/app.config.ts` and add `provideBraid()`:

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
    provideBraid(), // Synchronizes Angular router navigation with Braid fragments
  ],
};
```

---

## 3. Mount `<braid-fragment>` in the Shell Template

Open `apps/shell/src/app/app.component.ts`:

```ts
import { Component } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { BraidFragmentComponent } from '@braidlabs/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, BraidFragmentComponent],
  template: `
    <header style="background: #18181b; color: white; padding: 1rem; display: flex; gap: 1rem;">
      <h1 style="font-size: 1.25rem; margin: 0;">Acme Enterprise Portal</h1>
      <nav style="display: flex; gap: 1rem; align-items: center;">
        <a routerLink="/" style="color: #a1a1aa; text-decoration: none;">Dashboard</a>
        <a routerLink="/billing" style="color: white; font-weight: bold; text-decoration: none;">Billing</a>
      </nav>
    </header>

    <main style="padding: 1.5rem;">
      <!-- Mount the React Billing Microfrontend -->
      <braid-fragment
        name="billing"
        (ready)="onFragmentReady($event)"
        (failed)="onFragmentFailed($event)"
      />
    </main>
  `,
})
export class AppComponent {
  onFragmentReady(event: { fragmentId: string }) {
    console.log(`[Host] Fragment ${event.fragmentId} successfully booted!`);
  }

  onFragmentFailed(error: any) {
    console.error('[Host] Fragment boot error:', error);
  }
}
```

---

## 4. Inspecting the Isolation Boundaries in DevTools

Open your browser to `http://localhost:3000/billing` and open Chrome DevTools:

### 1. The Declarative Shadow DOM
Look at the Elements panel under `<fragment-slot name="billing">`:
- Inside is `#shadow-root (open)`.
- The React application's DOM is mounted inside this Shadow Root.
- Any CSS defined inside the React app cannot leak out and affect the Angular shell's headers or fonts.

### 2. The Hidden Execution Realm
Look at the bottom of `<body>`:
- You will see a hidden `<iframe>` with `display: none`.
- The React application's JavaScript is executing entirely inside this iframe realm.
- Open the DevTools Console:
  ```js
  // In the host window:
  window.React // undefined!
  ```
  The host window global scope remains completely pure and unpolluted.

---

## Next Step

In **[Step 4: Props, Events & Context Bus](./04-props-and-events.md)**, we will add bidirectional communication: passing active tenant and user properties from Angular into the React fragment, and listening for payment completion events.
