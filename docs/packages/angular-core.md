# @braidlabs/angular-core

First-class Angular Dependency Injection (DI) and reactive Signal wrappers for `@braidlabs/skew`. Synchronous store peeking, signal-based versioned state, and zero UI flicker during migrations.

---

## Installation

```bash
npm install @braidlabs/angular-core @braidlabs/skew
```

---

## Setup & Provider Registration

```ts
import { createSkewStoreToken, provideSkewStore } from '@braidlabs/angular-core';
import { webStorageDriver } from '@braidlabs/skew';
import { UserProfileSchema, UserProfile } from './user-profile.schema';

// Create a typed injection token
export const USER_STORE = createSkewStoreToken<UserProfile>('USER_STORE');

// Application or feature route provider
export function provideUserStore() {
  return provideSkewStore(USER_STORE, UserProfileSchema, {
    driver: webStorageDriver('local'),
    keyPrefix: 'app-users',
  });
}
```

---

## Consuming with Angular Signals

`injectSkewSignal()` eliminates the empty UI flash on initial load by synchronously peeking into local storage while managing background migration promises:

```ts
import { Component } from '@angular/core';
import { injectSkewSignal } from '@braidlabs/angular-core';
import { USER_STORE } from './providers';

@Component({
  standalone: true,
  template: `
    @if (user.loading()) {
      <p>Loading profile...</p>
    } @else if (user.error()) {
      <p class="error">Migration error: {{ user.error()?.message }}</p>
    } @else if (user.data()) {
      <h1>Welcome, {{ user.data()?.firstName }}</h1>
      <button (click)="save()">Update Name</button>
    }
  `,
})
export class UserProfileComponent {
  // Returns reactive signals: { data, error, loading, set, reload }
  user = injectSkewSignal(USER_STORE, 'current_user');

  async save() {
    await this.user.set({ firstName: 'Grace', lastName: 'Hopper' });
  }
}
```

---

## API Reference

| Function / Token | Description |
| :--- | :--- |
| `createSkewStoreToken<T>(name)` | Creates a typed `InjectionToken<VersionedStore<T>>`. |
| `provideSkewStore(token, schema, options)` | Registers a versioned store in Angular DI. |
| `injectSkewSignal(token, key)` | Injects a reactive signal tuple `{ data, error, loading, set, reload }`. |
| `injectSkewStore(token)` | Injects the raw `VersionedStore<T>` instance for services and guards. |
