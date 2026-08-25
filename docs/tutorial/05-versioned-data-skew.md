# Step 5: Versioned Data & Offline Storage

In this step, you will introduce `@braidlabs/data` and `@braidlabs/skew` into the React billing application to store invoice data locally in IndexedDB, support optimistic updates, and survive offline scenarios.

---

## 1. Install Data & Skew Libraries

```bash
npm install @braidlabs/data @braidlabs/skew
```

---

## 2. Create the Versioned Invoice Schema

Create `apps/billing/src/app/invoice.schema.ts`:

```ts
import { versioned } from '@braidlabs/skew';

// Schema Version 1
export interface InvoiceV1 {
  id: string;
  amount: string;
  status: 'Pending' | 'Paid';
  dueDate: string;
}

export const InvoiceSchema = versioned<InvoiceV1>('invoice');
```

---

## 3. Initialize the Record Store in React

Update `apps/billing/src/app/app.tsx` to read from and write to `@braidlabs/data`:

```tsx
import React, { useEffect, useState } from 'react';
import { createRecordStore, indexedDbRecordDriver } from '@braidlabs/data';
import { InvoiceSchema, InvoiceV1 } from './invoice.schema';

// Persistent record store in IndexedDB
const store = createRecordStore({
  driver: indexedDbRecordDriver({ name: 'acme-billing-db' }),
  partition: 'tenant_main',
});

export function App() {
  const [invoices, setInvoices] = useState<InvoiceV1[]>([]);
  const [loading, setLoading] = useState(true);

  // Load records from IndexedDB on boot
  useEffect(() => {
    async function initData() {
      let records = await store.list('invoices', InvoiceSchema);

      // Seed initial records if empty
      if (records.length === 0) {
        const seed: InvoiceV1[] = [
          { id: 'INV-101', amount: '$450.00', status: 'Pending', dueDate: '2026-09-01' },
          { id: 'INV-102', amount: '$1,200.00', status: 'Pending', dueDate: '2026-09-15' },
        ];
        for (const item of seed) {
          await store.put('invoices', item.id, InvoiceSchema, item);
        }
        records = seed;
      }

      setInvoices(records);
      setLoading(false);
    }

    initData();
  }, []);

  const payInvoice = async (invoice: InvoiceV1) => {
    const updated: InvoiceV1 = { ...invoice, status: 'Paid' };

    // 1. Optimistic UI update
    setInvoices((prev) => prev.map((inv) => (inv.id === invoice.id ? updated : inv)));

    // 2. Persist to versioned IndexedDB record store
    await store.put('invoices', invoice.id, InvoiceSchema, updated);

    // 3. Dispatch event to host
    window.dispatchEvent(
      new CustomEvent('invoice:paid', {
        detail: { invoiceId: invoice.id, amount: invoice.amount, timestamp: Date.now() },
        bubbles: true,
      })
    );
  };

  if (loading) return <div>Loading invoices from IndexedDB...</div>;

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Billing & Invoices (Persistent Local-First)</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr style={{ background: '#f4f4f5', textAlign: 'left' }}>
            <th style={{ padding: '8px' }}>Invoice ID</th>
            <th style={{ padding: '8px' }}>Amount</th>
            <th style={{ padding: '8px' }}>Due Date</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} style={{ borderBottom: '1px solid #e4e4e7' }}>
              <td style={{ padding: '8px' }}>{inv.id}</td>
              <td style={{ padding: '8px' }}>{inv.amount}</td>
              <td style={{ padding: '8px' }}>{inv.dueDate}</td>
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
                    onClick={() => payInvoice(inv)}
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

## 4. Test Persistence Across Reloads & Offline

1. Refresh `http://localhost:3000/billing`.
2. Click **Pay Now** on `INV-101`.
3. Hard refresh the page (`Cmd + Shift + R`).
4. Notice that `INV-101` remains **Paid**: the state was saved in IndexedDB wrapped in a `@braidlabs/skew` envelope.
5. In Chrome DevTools > Application > Storage > IndexedDB, inspect `acme-billing-db`. You will see the stored record and its envelope metadata:
   ```json
   {
     "__schema": "invoice",
     "__version": 1,
     "payload": { "id": "INV-101", "status": "Paid", ... }
   }
   ```

---

## Next Step

In **[Step 6: Surviving Schema Evolution](./06-schema-migrations.md)**, we will evolve the `invoice` schema to Version 2 and learn how `@braidlabs/skew` and `@braidlabs/contract` migrate stored records on the fly without breaking across independent deployments.
