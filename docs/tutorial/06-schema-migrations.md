# Step 6: Surviving Schema Evolution Across Deploys

In this step, you will evolve the billing data schema to **Version 2** (splitting the scalar amount into structured currency and decimal values). You will see how `@braidlabs/skew` allows new code to seamlessly read existing V1 records from IndexedDB and how `@braidlabs/contract` provides bidirectional migration bridges.

---

## 1. Evolve the Schema to Version 2

Suppose the product team requires multi-currency support. In `apps/billing/src/app/invoice.schema.ts`, define `InvoiceV2` and chain a forward migration:

```ts
import { versioned } from '@braidlabs/skew';

// Schema Version 1 (Frozen historical snapshot)
export interface InvoiceV1 {
  id: string;
  amount: string; // e.g. "$450.00"
  status: 'Pending' | 'Paid';
  dueDate: string;
}

// Schema Version 2 (Current application model)
export interface InvoiceV2 {
  id: string;
  amount: number; // e.g. 450.00
  currency: 'USD' | 'EUR' | 'GBP';
  status: 'Pending' | 'Paid';
  dueDate: string;
  paidAt?: number;
}

// Versioned schema with pure forward migration function
export const InvoiceSchema = versioned<InvoiceV1>('invoice')
  .next<InvoiceV2>('promote string amount to numeric amount and currency', (v1) => {
    const rawNumber = parseFloat(v1.amount.replace(/[^0-9.-]+/g, '')) || 0;
    const currency = v1.amount.includes('€')
      ? 'EUR'
      : v1.amount.includes('£')
      ? 'GBP'
      : 'USD';

    return {
      id: v1.id,
      amount: rawNumber,
      currency,
      status: v1.status,
      dueDate: v1.dueDate,
      paidAt: v1.status === 'Paid' ? Date.now() : undefined,
    };
  });
```

---

## 2. Update React Component to Use Schema V2

Update `apps/billing/src/app/app.tsx` to handle the new `InvoiceV2` type:

```tsx
import React, { useEffect, useState } from 'react';
import { createRecordStore, indexedDbRecordDriver } from '@braidlabs/data';
import { InvoiceSchema, InvoiceV2 } from './invoice.schema';

const store = createRecordStore({
  driver: indexedDbRecordDriver({ name: 'acme-billing-db' }),
  partition: 'tenant_main',
});

export function App() {
  const [invoices, setInvoices] = useState<InvoiceV2[]>([]);

  useEffect(() => {
    async function loadData() {
      // Automatic migration: Any V1 record in IndexedDB is upgraded to V2 during read!
      const records = await store.list('invoices', InvoiceSchema);
      setInvoices(records);
    }
    loadData();
  }, []);

  const payInvoice = async (inv: InvoiceV2) => {
    const updated: InvoiceV2 = { ...inv, status: 'Paid', paidAt: Date.now() };

    setInvoices((prev) => prev.map((item) => (item.id === inv.id ? updated : item)));
    await store.put('invoices', inv.id, InvoiceSchema, updated);
  };

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Billing & Invoices (Schema V2 Active)</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr style={{ background: '#f4f4f5', textAlign: 'left' }}>
            <th style={{ padding: '8px' }}>Invoice ID</th>
            <th style={{ padding: '8px' }}>Amount</th>
            <th style={{ padding: '8px' }}>Currency</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Paid Timestamp</th>
            <th style={{ padding: '8px' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} style={{ borderBottom: '1px solid #e4e4e7' }}>
              <td style={{ padding: '8px' }}>{inv.id}</td>
              <td style={{ padding: '8px' }}>{inv.amount.toFixed(2)}</td>
              <td style={{ padding: '8px' }}>{inv.currency}</td>
              <td style={{ padding: '8px' }}>{inv.status}</td>
              <td style={{ padding: '8px' }}>
                {inv.paidAt ? new Date(inv.paidAt).toLocaleTimeString() : '—'}
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
                    Pay
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

## 3. Verify Live Auto-Migration

1. Refresh `http://localhost:3000/billing`.
2. Inspect the table:
   - Notice that records authored in Step 5 as V1 strings (`"$450.00"`) were automatically parsed and projected into V2 numbers (`450.00`) and currency tags (`USD`) with zero data loss and no manual database migration script.
3. Click **Pay** on an invoice to write a new V2 record.
4. Check IndexedDB in DevTools: The newly saved record envelope is stamped `__version: 2`.

---

## Next Step

In **[Step 7: Production Hardening & Service Worker](./07-production-hardening.md)**, we will add `@braidlabs/sw` for chunk isolation during zero-downtime rolling deployments, configure fallback states, and use `@braidlabs/console` to monitor gateway routing.
