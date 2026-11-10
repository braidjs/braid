# Step 4: Talking Across the Boundary

In this step, you will implement decoupled, bidirectional communication between the Angular host shell and the React billing remote without coupling their module bundles or relying on global state.

The billing app is still an unmodified app: it runs in Braid's default compat mode and contains no Braid code. That decides which mechanisms it can use.

| Direction | For this tutorial's unmodified app | For a fragment that is given an `env` |
| :--- | :--- | :--- |
| Host to fragment | a page channel from `@braidlabs/data` | `[props]`, read as `env.props` |
| Fragment to host | a composed DOM event | `env.emit(...)`, heard as `(fragmentEvent)` |

`[props]` and `(fragmentEvent)` travel through the `env` object Braid hands to a fragment's `mount(env)`. A fragment gets an `env` by opting in with `defineFragment`. (A fragment that is a custom element gets the same two things with no Braid code: props as element properties, and the events its manifest lists.) A compat fragment has no `env`, so props set on its slot are never seen by its code, and nothing it dispatches arrives as `(fragmentEvent)`. The [events and data guide](../events-and-data.md) covers every mechanism here, with the tradeoffs.

---

## 1. Install the Data Library

```bash
npm install @braidlabs/data
```

Both apps import it. Each gets its own copy at runtime, and the copies find each other over a `BroadcastChannel`.

---

## 2. Publishing the Account from the Host

In `apps/shell/src/app/app.component.ts`, publish the current account on a channel and listen for the fragment's event:

```ts
import { Component, signal } from '@angular/core';
import { BraidFragment } from '@braidlabs/angular';
import { createEventBus } from '@braidlabs/data';

interface Account {
  accountId: string;
  currency: string;
}

// One bus per app, named for who is speaking
const account = createEventBus({ consumer: 'shell' }).channel<Account>('account');

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [BraidFragment],
  template: `
    <header style="background: #18181b; color: white; padding: 1rem; display: flex; justify-content: space-between;">
      <h1 style="font-size: 1.25rem; margin: 0;">Acme Enterprise Portal</h1>
      <div>
        <span>Account: <strong>{{ currentAccount() }}</strong></span>
        <button (click)="switchAccount()" style="margin-left: 8px;">Switch Account</button>
      </div>
    </header>

    <main style="padding: 1.5rem;">
      <braid-fragment name="billing" (invoice-paid)="onInvoicePaid($event)" />

      @if (lastNotification()) {
        <div style="margin-top: 1rem; padding: 1rem; background: #ecfdf5; border: 1px solid #10b981; border-radius: 6px;">
          {{ lastNotification() }}
        </div>
      }
    </main>
  `,
})
export class AppComponent {
  currentAccount = signal('ACC-99201');
  lastNotification = signal<string | null>(null);

  constructor() {
    this.publishAccount();
  }

  switchAccount() {
    this.currentAccount.set(
      this.currentAccount() === 'ACC-99201' ? 'ACC-44012' : 'ACC-99201'
    );
    this.publishAccount();
  }

  // An ordinary DOM event: it left the fragment and bubbled up to <braid-fragment>
  onInvoicePaid(event: Event) {
    const { invoiceId, amount } = (event as CustomEvent<{ invoiceId: string; amount: string }>).detail;
    this.lastNotification.set(
      `Received payment confirmation for invoice ${invoiceId} (${amount})`
    );
  }

  private publishAccount() {
    account.broadcast({ accountId: this.currentAccount(), currency: 'USD' });
  }
}
```

A channel holds state: the last value broadcast. The shell publishes before the billing app has loaded, and that is fine. A subscriber that arrives later is given the current value.

---

## 3. Subscribing and Emitting from the React Fragment

Update `apps/billing/src/app/app.tsx` to follow the account and tell the host when an invoice is paid:

```tsx
import React, { useEffect, useState } from 'react';
import { createEventBus } from '@braidlabs/data';

interface Account {
  accountId: string;
  currency: string;
}

const accountChannel = createEventBus({ consumer: 'billing' }).channel<Account>('account');

export function App() {
  const [account, setAccount] = useState<Account>();
  const [invoices, setInvoices] = useState([
    { id: 'INV-101', amount: '$450.00', status: 'Pending' },
    { id: 'INV-102', amount: '$1,200.00', status: 'Pending' },
  ]);

  // Called with the current account once it is known, then on every change.
  // subscribe returns its own unsubscribe, which is the effect's cleanup.
  useEffect(() => accountChannel.subscribe(setAccount), []);

  const payInvoice = (id: string, amount: string) => {
    // 1. Update local React state
    setInvoices((prev) =>
      prev.map((inv) => (inv.id === id ? { ...inv, status: 'Paid' } : inv))
    );

    // 2. Tell the host. Braid delivers the fragment's window events to its shadow root;
    //    `composed` is what lets this one cross out of it, into the host's DOM.
    window.dispatchEvent(
      new CustomEvent('invoice-paid', {
        detail: { invoiceId: id, amount, timestamp: Date.now() },
        bubbles: true,
        composed: true,
      })
    );
  };

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Billing & Invoices (React Remote)</h2>
      <p>Account: {account?.accountId ?? '…'} ({account?.currency ?? '…'})</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr style={{ background: '#f4f4f5', textAlign: 'left' }}>
            <th style={{ padding: '8px' }}>Invoice ID</th>
            <th style={{ padding: '8px' }}>Amount</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} style={{ borderBottom: '1px solid #e4e4e7' }}>
              <td style={{ padding: '8px' }}>{inv.id}</td>
              <td style={{ padding: '8px' }}>{inv.amount}</td>
              <td style={{ padding: '8px' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: inv.status === 'Paid' ? '#dcfce7' : '#fef9c3',
                    color: inv.status === 'Paid' ? '#166534' : '#854d0e',
                  }}
                >
                  {inv.status}
                </span>
              </td>
              <td style={{ padding: '8px' }}>
                {inv.status === 'Pending' && (
                  <button
                    onClick={() => payInvoice(inv.id, inv.amount)}
                    style={{
                      background: '#2563eb',
                      color: 'white',
                      border: 'none',
                      padding: '4px 10px',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    Pay Now
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
```

Two details matter here:

- **`composed: true` is required.** Without it the event stops at the fragment's shadow root and the host never hears it.
- **The name has no colon.** Angular reads `(invoice:paid)` as "the `paid` event on a target called `invoice`" and refuses it. A host that listens with `addEventListener` can use any name.

---

## 4. Test Bidirectional Communication

1. Open `http://localhost:3000/billing`.
2. The billing table shows `Account: ACC-99201 (USD)`: it mounted after the shell published, and still received the value.
3. Click **Pay Now** on invoice `INV-101` in the React table.
4. Observe:
   - React state immediately updates `Pending` to `Paid`.
   - The React app dispatches `invoice-paid`.
   - The Angular host handles `(invoice-paid)` and renders the green confirmation banner.
5. Click **Switch Account** on the Angular header:
   - The account line inside the React fragment changes to `ACC-44012`.

### What you did not get

- **The event is not stored.** If the host has no listener when it fires, it is gone. For an event nobody may miss, see [durable events](../events-and-data.md#an-event-nobody-may-miss-durable-events).
- **The channel is page-wide.** Every app on the page that opens the `account` channel sees the value, and any of them may publish. That suits "the current account". It does not suit a value meant for one fragment only.
- **Delivery across apps is asynchronous.** `broadcast` returns before the fragment has heard it.

---

## Next Step

In **[Step 5: Versioned Data & Offline Storage](./05-versioned-data-skew.md)**, we will persist billing state in IndexedDB using `@braidlabs/data` and `@braidlabs/skew` with optimistic writes that work offline.
