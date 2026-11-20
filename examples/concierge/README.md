# Concierge — A2UI, Braided into a host app

A travel app with a design of its own, into which two kinds of server-driven UI are drawn as if
they were part of it — because they are:

- **A CMS-authored screen** (the trip): written once at the newest version of every component,
  prerendered for every web renderer the app serves, served as HTML that shows before any script
  runs, and taken over in the browser without being rebuilt.
- **An agent's surface** (the assistant): an A2UI v1.0 stream, projected on its way to each
  renderer so that a renderer built last spring receives what it can draw — the components it has,
  at the versions it has — and a renderer built today receives the agent's UI exactly.

Both are drawn by `<a2ui-surface>` from `@braidlabs/sdui/web` in **light DOM**: the app's own
stylesheet styles the agent's buttons and fields, its layout lays them out, its accessibility tree
reads them. And two of the agent's component types are not drawn by the renderer at all:

| A2UI component  | Drawn by                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ |
| `Card`          | the app's own `<concierge-card>` custom element, the panel every screen of the app uses    |
| `FlightCard`    | the flights team's **Braid fragment** — built and deployed apart, mounted in its own realm |
| `Fare`          | the app, as a view function that draws the same on the server and in the browser           |
| everything else | the basic catalog's components, as plain semantic HTML                                     |

Choosing a flight in the fragment is a Braid event; the renderer turns it into the A2UI action the
agent attached to the card, and the agent receives it like any other.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3919/>. From inside a Braid checkout, without installing:

```bash
BRAID_TSCONFIG=tsconfig.base.json node examples/concierge/server.mjs
```

- <http://localhost:3919/?renderer=legacy> is the page as build 1.9 of the web app sees it: no
  `FlightCard`, an older `Fare` — and in their place the catalog's stand-ins, never a guessed value.
- <http://localhost:3919/?sale=1> is the trip's prerendered variant with the `summer-sale` flag on.
- A real renderer says which it is with an `A2UI-Renderer-Capabilities` header naming the catalog
  ids it supports; the server picks the prerendered variant and the projection from that.

## What is where

| Path                           | What it is                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `content/catalog.json`         | The app's catalog: the basic catalog, plus `Fare` (three versions), `Rating` and `FlightCard` |
| `content/manifests/`           | Two builds of the web app: the current one, and 1.9                                           |
| `content/screens/trip.json`    | The CMS-authored trip screen                                                                  |
| `content/agent/rebook.jsonl`   | What the (stub) agent sends: A2UI v1.0, authored against the catalog's own id                 |
| `src/registry.js`              | Which components are the host's own — shared by server and browser                            |
| `src/server-lib.js`            | Prerendering, and a projector per renderer                                                    |
| `src/fragments/flight-card.js` | The flights team's fragment                                                                   |
| `build.mjs`                    | Bundles the app and the fragment, and prerenders every variant into `dist/prerendered/`       |
| `server.mjs`                   | Serves it: `/`, `/agent/stream`, `/agent/actions`, `/gallery.html`                            |

`/gallery.html` is an empty page in the app's styles; `e2e/concierge-example.e2e.ts` draws every
example of the A2UI basic catalog into it, and checks the app's own CSS is what they look like.
