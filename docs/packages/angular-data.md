# @braidlabs/angular-data

Normalized entity store, tag-based query invalidation, and durable mutation outbox for Angular. Built on `@braidlabs/data` and `@braidlabs/skew`.

---

## Installation

```bash
npm install @braidlabs/angular-data @braidlabs/data @braidlabs/skew
```

---

## Key Features

1. **Normalized Entity Store:** Shared identity across components and fragments without duplicate network queries.
2. **Tag-Based Invalidation:** Queries declare tags (e.g. `['funds', 'fund:123']`); mutations invalidate tags to trigger precise background refetches.
3. **Durable Mutation Outbox:** Mutations are recorded to IndexedDB *before* making network requests. If the network drops or the browser crashes, mutations resume automatically on reconnect.
4. **Optimistic Updates:** Immediate UI updates with automatic rollback or conflict resolution on server mismatch.

---

## Usage

### 1. Register Data Providers

```ts
import { ApplicationConfig } from '@angular/core';
import { provideData } from '@braidlabs/angular-data';

export const appConfig: ApplicationConfig = {
  providers: [
    provideData({
      dbName: 'acme-data',
      partition: 'tenant_main',
    }),
  ],
};
```

### 2. Querying & Tag Invalidation

```ts
import { Component, inject } from '@angular/core';
import { EntityStore, query } from '@braidlabs/angular-data';
import { FundSchema } from './fund.schema';

@Component({
  standalone: true,
  template: `
    @for (fund of funds.data(); track fund.id) {
      <div class="fund-card">
        <h3>{{ fund.name }}</h3>
        <p>NAV: {{ fund.nav }}</p>
      </div>
    }
  `,
})
export class FundListComponent {
  private store = inject(EntityStore);

  funds = query(this.store, {
    key: 'fund-list',
    schema: FundSchema,
    tags: ['funds'],
    fetch: () => fetch('/api/funds').then((r) => r.json()),
  });
}
```

### 3. Durable Optimistic Mutations

```ts
import { Component, inject } from '@angular/core';
import { OutboxService } from '@braidlabs/angular-data';
import { FundSchema } from './fund.schema';

@Component({ ... })
export class FundEditorComponent {
  private outbox = inject(OutboxService);

  async updateFund(id: string, newNav: number) {
    await this.outbox.enqueue({
      id: `mut_${Date.now()}`,
      endpoint: `/api/funds/${id}`,
      method: 'PATCH',
      payload: { nav: newNav },
      invalidatesTags: ['funds', `fund:${id}`],
      optimistic: {
        collection: 'funds',
        key: id,
        schema: FundSchema,
        update: (current) => ({ ...current, nav: newNav }),
      },
    });
  }
}
```
