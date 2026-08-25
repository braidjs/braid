# Step 1: Blank Slate to Two Apps in an Nx Monorepo

In this step, you will initialize a clean workspace and generate two separate frontend applications in two different frameworks:
- **Host App:** Angular (Port `4200`)
- **Remote App:** React (Port `4201`)

---

## 1. Create the Nx Monorepo

Run the Nx generator to scaffold a multi-app repository:

```bash
npx create-nx-workspace@latest acme-portal --preset=apps --packageManager=npm
cd acme-portal
```

---

## 2. Generate the Applications

Add the Angular and React plugins:

```bash
npm install -D @nx/angular @nx/react
```

### Create the Angular Shell (Host)
```bash
npx nx g @nx/angular:app apps/shell \
  --standalone=true \
  --routing=true \
  --style=css \
  --ssr=true \
  --port=4200
```

### Create the React Billing App (Remote)
```bash
npx nx g @nx/react:app apps/billing \
  --style=css \
  --routing=true \
  --port=4201
```

---

## 3. Review Application Code

### The React Remote (`apps/billing/src/app/app.tsx`)

Add a simple invoice table to the billing application:

```tsx
import React, { useState } from 'react';

export function App() {
  const [invoices] = useState([
    { id: 'INV-101', amount: '$450.00', status: 'Pending' },
    { id: 'INV-102', amount: '$1,200.00', status: 'Paid' },
  ]);

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Billing & Invoices (React Remote)</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: '#f4f4f5', textAlign: 'left' }}>
            <th style={{ padding: '8px' }}>Invoice ID</th>
            <th style={{ padding: '8px' }}>Amount</th>
            <th style={{ padding: '8px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <tr key={inv.id} style={{ borderBottom: '1px solid #e4e4e7' }}>
              <td style={{ padding: '8px' }}>{inv.id}</td>
              <td style={{ padding: '8px' }}>{inv.amount}</td>
              <td style={{ padding: '8px' }}>{inv.status}</td>
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

## 4. Run Both Applications Standalone

Start the two development servers:

```bash
# Terminal 1: Angular Host
npx nx serve shell --port=4200

# Terminal 2: React Billing Remote
npx nx serve billing --port=4201
```

Verify in your browser:
- `http://localhost:4200` shows the standalone Angular shell.
- `http://localhost:4201` shows the standalone React billing app.

---

## The Challenge

At this point, you have two completely independent applications running on separate ports. If you navigate between them, you get a full-page redirect, losing shared context and re-downloading entire framework bundles.

In **[Step 2: The Gateway & Fragment Manifest](./02-gateway-and-manifest.md)**, we will add `@braidlabs/gateway` to compose them under a single unified origin on port `3000`.
