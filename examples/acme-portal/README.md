# Acme Enterprise Portal — Braid Interactive Demo

An interactive, zero-infrastructure demo showing how Braid composes independently deployed web applications into a single unified origin with isolated iframe execution realms and Declarative Shadow DOM.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/braidjs/braid/tree/main/examples/acme-portal)

---

## What This Demo Demonstrates

1. **Origin Gateway Middleware (`@braidlabs/gateway`):** Routes traffic under `/__braid/frag/billing/` and server-pierces HTML markup.
2. **Client Runtime (`@braidlabs/core`):** Boots the billing remote in an isolated execution realm, mounts DOM into a Shadow Root, and bridges props/events.
3. **Decoupled Bidirectional Communication:** Clicking "Pay Now" in the React remote dispatches an `invoice:paid` custom event that bubbles up to the Angular Host Shell.

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start the gateway server
npm start
```

Open `http://localhost:3000/billing` in your browser.
