# Starport — a Braid workspace

Five small apps on one desk: a flight board, a star map, a radar, a cargo manifest and a comms
panel. Each is a plain static app that knows nothing about the others. The desk is a
[console workspace](../../docs/packages/console.md#the-workspace) around an
[FDC3 agent](../../docs/packages/fdc3.md).

![The Starport desk with all five apps open](./screenshot.png)

## What it shows

- **A pick followed everywhere.** Choose a ship in Flights. Star Map and Cargo show it, because
  every app joins the same channel before its code runs.
- **An intent two apps can take.** *Plot route* doesn't name an app. Star Map and Radar both take
  `PlotRoute`, so the desk asks. Tick *Remember my choice* and it stops asking; *Forget* undoes that.
- **An app launched for a raise.** *Hail* raises `HailShip`. Only Comms takes it, so Comms is
  opened if it isn't already, and gets the ship.
- **Layouts that keep each app's state.** Zoom the map, open Radar, save a layout. Close things,
  restore it: the apps come back, and the map is zoomed as it was. Layouts survive a reload.
- **Per-user app settings.** Cargo's column choice is a setting, kept for the app rather than for
  one tile of it. It is the same after a reload.

![Choosing which app takes an intent](./screenshot-chooser.png)

## Files

- `server.mjs` — a Braid gateway in front of static files. Its `registry` is all the desk knows
  about the apps: where each one is, and which intents it raises and takes.
- `src/main.js` — the desk's runtime: the workspace, the agent, the dock, layouts and the chooser.
- `public/shell` — the desk's page and its theme. The palette is CSS custom properties, which
  cross into each app's shadow root.
- `public/apps/*` — the five apps. Each uses `fdc3` and `braidDesktop`, which exist before its
  first script runs, and nothing from Braid.

## Running it

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000/`.

From a Braid checkout, run it against the sources instead:

```bash
BRAID_TSCONFIG=../../tsconfig.base.json node server.mjs
```

The repository's e2e (`e2e/starport-example.e2e.ts`) runs this example in Chromium.

## Limits

- Everything the user keeps is in `localStorage`, so it is per browser. A gateway with
  `preferences` and a `serverStore` keeps it per signed-in user instead.
- The gateway runs in development mode, for apps on loopback over http. Don't ship that.
- The tiles are a grid. The workspace orders apps; it is not a window manager.
