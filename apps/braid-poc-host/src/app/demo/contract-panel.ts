import { CUSTOM_ELEMENTS_SCHEMA, Component, ElementRef, afterNextRender, signal, viewChild } from '@angular/core';
import { braidContext } from '@braidlabs/core';
import { DemoPanel } from './panel';

/**
 * The contract-mode panel: a fragment composed with **no gateway route at all**.
 *
 * Every other fragment on this page reaches the browser through the gateway — realm stub, proxied
 * assets, optional SSR piercing. This one is mounted straight from its own origin:
 *
 * ```html
 * <fragment-slot name="contract-demo" adapter="contract" entry="http://localhost:4506/main.js">
 * ```
 *
 * The client writes a `blob:` realm itself and imports that module into it. Nothing on the host
 * origin serves the fragment, which is why the panel's proof is a *negative* one: the network tab
 * shows no `/__braid/` request for it, and `curl`ing the host returns none of its markup.
 *
 * `CUSTOM_ELEMENTS_SCHEMA` rather than the `<braid-fragment>` wrapper, because the wrapper models
 * the gateway-registered case (`name`, `src`, `props`) and this is deliberately the other one —
 * the host declares the entry in markup, since there is no registry to read it from.
 */
@Component({
  selector: 'demo-contract',
  standalone: true,
  imports: [DemoPanel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <h2>Contract mode</h2>

    <demo-panel
      [n]="10"
      claim="This fragment is composed without the gateway touching it."
      proves="Contract mode needs no host-origin middleware — a static host can compose fragments"
    >
      <p class="hint">
        The strip below is a separate deployment on <code>:4506</code>, mounted by
        <code>&lt;fragment-slot name="contract-demo" adapter="contract" entry="…"&gt;</code>. The
        name identifies it in errors and capability grants — there is no registry entry
        for it, no <code>/__braid/frag/</code> route, and no pierced markup — the client boots a
        <code>blob:</code> realm and imports its entry module directly.
      </p>

      <fragment-slot #slot name="contract-demo" adapter="contract" entry="http://localhost:4506/main.js">
        <p slot="fallback">The contract fragment is unavailable.</p>
      </fragment-slot>

      <div class="row">
        <button type="button" (click)="publish()">Publish page context</button>
        <span class="hint">
          Sets <code>demo:message</code> on the page bus. The fragment mirrors it across the
          boundary and renders it — no gateway in that path either.
        </span>
      </div>

      <dl class="proof">
        <dt>slot state</dt>
        <dd>{{ state() }}</dd>
        <dt>events received</dt>
        <dd>{{ events().length === 0 ? 'none yet' : events().join(', ') }}</dd>
        <dt>fragment reports unsaved work</dt>
        <dd>{{ dirty() ?? 'no' }}</dd>
      </dl>
    </demo-panel>
  `,
  styles: `
    :host { display: block; }
    .row { display: flex; gap: .6rem; align-items: center; margin-top: .8rem; }
    .proof { display: grid; grid-template-columns: auto 1fr; gap: .15rem .75rem; margin: .8rem 0 0;
      font-size: 13px; }
    .proof dt { color: #5a6472; }
    .hint { color: #5a6472; font-size: 13px; }
    code { background: #eef1f5; padding: 0 .25rem; border-radius: 3px; }
  `,
})
export class DemoContract {
  readonly state = signal('idle');
  readonly events = signal<string[]>([]);
  readonly dirty = signal<string | null>(null);

  private readonly slot = viewChild.required<ElementRef<HTMLElement>>('slot');

  /**
   * Listeners are attached with `addEventListener` rather than Angular's `(event)` binding.
   *
   * Not a preference: Angular's template parser reads `(braid:event)` as the *global target*
   * `braid` and rejects it, because `target:event` is its own syntax. Braid's events are
   * colon-namespaced — `braid:ready`, `braid:state`, `braid:event` — so every Angular host binding
   * them from a template hits this. Worth knowing, and worth the `<braid-fragment>` wrapper
   * existing to spare people from it in the gateway-registered case.
   */
  constructor() {
    afterNextRender(() => {
      const element = this.slot().nativeElement;
      element.addEventListener('braid:event', (event) => this.onFragmentEvent(event as CustomEvent));
      element.addEventListener('braid:state', (event) => this.onState(event as CustomEvent));
      element.addEventListener('braid:dirty', (event) => this.onDirty(event as CustomEvent));
    });
  }

  publish(): void {
    braidContext.set('demo:message', { text: `published at ${new Date().toLocaleTimeString()}` });
  }

  onFragmentEvent(event: CustomEvent<{ type: string }>): void {
    this.events.update((seen) => [...seen, event.detail.type]);
  }

  onState(event: CustomEvent<{ state: string }>): void {
    // `ready` → `healthy` is the liveness handshake completing: the fragment's own event loop
    // produced a beat, in its own realm, and the host saw it.
    this.state.set(event.detail.state);
  }

  onDirty(event: CustomEvent<{ reason: string | null }>): void {
    this.dirty.set(event.detail.reason);
  }
}
