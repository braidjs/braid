import { defineFragment, type FragmentEnv } from '@braidlabs/core';

/**
 * A contract-mode fragment, deployed on its own origin, composed with **no gateway route**.
 *
 * Everything else in this demo goes through the gateway: its realm stub is served from
 * `/__braid/realm/:id`, its assets are proxied through `/__braid/frag/:id/*`, and its markup can be
 * pierced into the host's first response. This one does none of that. The host mounts it as
 *
 * ```html
 * <fragment-slot adapter="contract" entry="http://localhost:4506/main.js">
 * ```
 *
 * and the client boots a `blob:` realm it writes itself, imports this module into it, and calls
 * `mount`. No middleware on the host origin, no namespace routing, no HTML rewriting, no document
 * fetch. That is the whole claim, and this file is the thing that tests it.
 *
 * What it gives up in exchange is the illusion: there is no `document` facade here, no patched
 * `window`, no virtualised history. It gets a mount point, its props, the page's context, and a
 * teardown signal — and it is written against exactly those.
 */
defineFragment({
  contract: {
    version: '1.0.0',
    // The host declares `{ version: '1.0.0' }`, so this passes. Raise it to see the other half of
    // Phase 4 work: the slot refuses at mount with both versions named, before anything renders.
    requires: { host: '>=1.0.0' },
  },

  mount(env: FragmentEnv) {
    const root = env.root;
    root.innerHTML = `
      <section class="contract-fragment">
        <style>
          .contract-fragment { font: 14px/1.5 system-ui, sans-serif; padding: 1rem;
            border: 1px solid #c7d2fe; border-radius: 8px; background: #eef2ff; color: #1e1b4b; }
          .contract-fragment h3 { margin: 0 0 .25rem; font-size: 15px; }
          .contract-fragment dl { display: grid; grid-template-columns: auto 1fr; gap: .15rem .75rem; margin: .75rem 0 0; }
          .contract-fragment dt { color: #4338ca; }
          .contract-fragment code { background: #e0e7ff; padding: 0 .25rem; border-radius: 3px; }
          .contract-fragment button { margin-top: .75rem; font: inherit; padding: .3rem .6rem;
            border: 1px solid #6366f1; border-radius: 5px; background: #fff; cursor: pointer; }
        </style>
        <h3>Contract fragment — no gateway</h3>
        <p>Booted from a <code>blob:</code> realm. Nothing on the host origin serves this app.</p>
        <dl>
          <dt>base path</dt><dd data-base></dd>
          <dt>context <code>demo:message</code></dt><dd data-context>—</dd>
          <dt>props</dt><dd data-props>—</dd>
          <dt>unsaved work</dt><dd data-dirty>no</dd>
        </dl>
        <button type="button" data-emit>Emit an event to the host</button>
        <button type="button" data-dirty-toggle>Declare unsaved work</button>
      </section>
    `;

    const base = root.querySelector('[data-base]')!;
    const contextCell = root.querySelector('[data-context]')!;
    const propsCell = root.querySelector('[data-props]')!;
    const dirtyCell = root.querySelector('[data-dirty]')!;

    base.textContent = env.location.basePath;
    propsCell.textContent = JSON.stringify(env.props);

    // The page context, mirrored across the boundary. Reads are synchronous — the fragment holds a
    // local mirror the host seeds at OPEN and keeps current.
    const renderContext = (value: unknown) => {
      contextCell.textContent = value === undefined ? '—' : JSON.stringify(value);
    };
    renderContext(env.context.get('demo:message'));
    env.context.subscribe('demo:message', renderContext);

    env.onPropsChanged((props) => void (propsCell.textContent = JSON.stringify(props)));

    root.querySelector('[data-emit]')!.addEventListener('click', () => {
      env.emit('contract:hello', { at: new Date().toISOString() });
    });

    let dirty = false;
    root.querySelector('[data-dirty-toggle]')!.addEventListener('click', () => {
      dirty = !dirty;
      env.setDirty(dirty ? 'an unsaved draft in the contract fragment' : null);
      dirtyCell.textContent = dirty ? 'yes — the host knows' : 'no';
    });

    /**
     * Flush work before teardown. The host waits for this — bounded — before aborting `env.signal`,
     * so the `await` below genuinely runs against live resources rather than a disposed instance.
     */
    env.onClosing(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { flushed: dirty ? 1 : 0, dropped: 0 };
    });

    env.signal.addEventListener('abort', () => root.replaceChildren(), { once: true });
  },
});
