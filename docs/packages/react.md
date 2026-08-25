# @braidlabs/react

React bindings for Braid. Provides a typed `<BraidFragment>` component over `<fragment-slot>`, property bridge wiring, and navigation synchronization hooks for any React router.

---

## Installation

```bash
npm install @braidlabs/react @braidlabs/core
```

---

## Initialization

Initialize the custom element definitions in your React entry point (client-side):

```tsx
import { initBraidReact } from '@braidlabs/react';

// Initialize Braid for React
initBraidReact();
```

---

## Component Usage

```tsx
import React, { useState } from 'react';
import { BraidFragment } from '@braidlabs/react';

export function BillingSection({ cartId }: { cartId: string }) {
  const [ready, setReady] = useState(false);

  return (
    <div className="billing-wrapper">
      <BraidFragment
        name="billing"
        props={{ cartId }}
        onReady={({ fragmentId }) => {
          console.log(`Fragment ${fragmentId} ready!`);
          setReady(true);
        }}
        onError={({ stage, fixHint }) => {
          console.error(`Braid error at ${stage}:`, fixHint);
        }}
        onFragmentEvent={({ type, detail }) => {
          if (type === 'invoice:paid') {
            console.log('Invoice payment received:', detail);
          }
        }}
      />
    </div>
  );
}
```

---

## Host Navigation Synchronization

Braid preserves host purity and never monkey-patches `window.history`. Use `useBraidHostNavigation` to notify bound fragments when your React router performs a client-side transition:

```tsx
import { useLocation } from 'react-router-dom';
import { useBraidHostNavigation } from '@braidlabs/react';

export function AppRouterSync() {
  const location = useLocation();

  // Signals fragments after router commit
  useBraidHostNavigation(location.key);

  return null;
}
```

Works seamlessly with TanStack Router, React Router, Next.js, and Remix.

---

## Component Props Reference

| Prop | Type | Description |
| :--- | :--- | :--- |
| `name` | `string` (Required) | The fragment ID registered in Braid Gateway. |
| `src` | `string` | Fixed sub-route to render. If omitted, fragment follows host URL. |
| `props` | `Record<string, unknown>` | Structured-cloned properties passed across the realm boundary. |
| `onReady` | `({ fragmentId }) => void` | Triggered when fragment completes mounting and hydration. |
| `onError` | `(error: BraidFragmentError) => void` | Triggered on load/mount error with failure stage & fix hint. |
| `onFragmentEvent` | `({ type, detail }) => void` | Handles custom events dispatched by the fragment. |
| `onStateChange` | `(state: FragmentSlotState) => void` | Observes slot lifecycle (`idle`, `loading`, `ready`, `error`). |
| `ref` | `Ref<BraidFragmentHandle>` | Access to `.reload()` and `.state`. |
