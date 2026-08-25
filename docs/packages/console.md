# @braidlabs/console

A read-only dashboard and visual inspection console for Braid fragment registries. Ships in two formats: a mountable React component for internal developer portals, and a standalone deployable web app.

---

## Installation

```bash
npm install @braidlabs/console
```

---

## Key Features

1. **Zero Backend Required:** Reads directly from the `/__braid/registry` discovery endpoint exposed by Braid Gateway.
2. **Mountable React Component:** Embed directly into existing admin panels or developer consoles without leaking global CSS or colliding with the host router.
3. **Standalone Deployment:** Single static artifact that reads runtime configuration from DOM `<script id="braid-console-config">` blocks.
4. **CSS Scoping Invariant:** All styles are strictly scoped under `.braid-console`; never applies global resets or `:root` overrides.

---

## Usage as a React Library

```tsx
import React from 'react';
import { RegistryConsole } from '@braidlabs/console';
import '@braidlabs/console/styles.css';

export function AdminPortal() {
  return (
    <div className="admin-container">
      <h2>Braid Gateway Status</h2>
      <RegistryConsole
        api={{
          baseUrl: 'https://gateway.example.com',
          headers: () => ({ Authorization: `Bearer ${getAuthToken()}` }),
        }}
        theme="dark"
      />
    </div>
  );
}
```

---

## Standalone App Deployment

Build the standalone bundle:

```bash
nx build-app braid-console
```

Configure runtime endpoint in `index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <script type="application/json" id="braid-console-config">
    { "baseUrl": "https://gateway.example.com" }
  </script>
</head>
<body>
  <div id="root"></div>
  <script src="/main.js"></script>
</body>
</html>
```
