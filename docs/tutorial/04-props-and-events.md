# Step 4: Props, Events & The Context Bus

In this step, you will implement decoupled, bidirectional communication between the Angular host shell and the React billing remote without coupling their module bundles or relying on global state.

---

## 1. Passing Reactive Props from Host to Fragment

In `apps/shell/src/app/app.component.ts`, bind reactive props to the `<braid-fragment>`:

```ts
import { Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { BraidFragmentComponent } from '@braidlabs/angular';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, BraidFragmentComponent],
  template: `
    <header style="background: #18181b; color: white; padding: 1rem; display: flex; justify-content: space-between;">
      <h1 style="font-size: 1.25rem; margin: 0;">Acme Enterprise Portal</h1>
      <div>
        <span>Account: <strong>{{ currentAccount() }}</strong></span>
        <button (click)="switchAccount()" style="margin-left: 8px;">Switch Account</button>
      </div>
    </header>

    <main style="padding: 1.5rem;">
      <braid-fragment
        name="billing"
        [props]="{ accountId: currentAccount(), currency: 'USD' }"
        (fragmentEvent)="onFragmentEvent($event)"
      />

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

  switchAccount() {
    this.currentAccount.set(
      this.currentAccount() === 'ACC-99201' ? 'ACC-44012' : 'ACC-99201'
    );
  }

  onFragmentEvent(event: { type: string; detail: any }) {
    if (event.type === 'invoice:paid') {
      this.lastNotification.set(
        `Received payment confirmation for invoice ${event.detail.invoiceId} (${event.detail.amount})`
      );
    }
  }
}
```

---

## 2. Emitting Custom Events from the React Fragment

Update `apps/billing/src/app/app.tsx` to read props and emit custom DOM events back through the slot:

```tsx
import React, { useState } from 'react';

export function App() {
  const [invoices, setInvoices] = useState([
    { id: 'INV-101', amount: '$450.00', status: 'Pending' },
    { id: 'INV-102', amount: '$1,200.00', status: 'Pending' },
  ]);

  const payInvoice = (id: string, amount: string) => {
    // 1. Update local React state
    setInvoices((prev) =>
      prev.map((inv) => (inv.id === id ? { ...inv, status: 'Paid' } : inv))
    );

    // 2. Dispatch a CustomEvent through the DOM facade
    // The Braid runtime captures this and bubbles it as (fragmentEvent) on <braid-fragment>
    window.dispatchEvent(
      new CustomEvent('invoice:paid', {
        detail: { invoiceId: id, amount, timestamp: Date.now() },
        bubbles: true,
      })
    );
  };

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Billing & Invoices (React Remote)</h2>
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

---

## 3. Test Bidirectional Communication

1. Open `http://localhost:3000/billing`.
2. Click **Pay Now** on invoice `INV-101` in the React table.
3. Observe:
   - React state immediately updates `Pending` to `Paid`.
   - The React app dispatches `invoice:paid`.
   - The Angular host intercepts `(fragmentEvent)` and renders the green confirmation banner at the top of the shell.
4. Click **Switch Account** on the Angular header:
   - Notice the updated `[props]` pass seamlessly into the React fragment via structured clone.

---

## Next Step

In **[Step 5: Versioned Data & Offline Storage](./05-versioned-data-skew.md)**, we will persist billing state in IndexedDB using `@braidlabs/data` and `@braidlabs/skew` with optimistic writes that work offline.
