import {
  afterNextRender,
  Component,
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { FragmentSlotState } from '@braidlabs/core';

/** The `detail` of a `braid:error` event, surfaced through the `failed` output. */
export interface BraidFragmentError {
  fragmentId: string;
  stage: string;
  fixHint?: string;
  error: Error;
}

/** The `detail` of a fragment-to-host `braid:event`. */
export interface BraidFragmentEvent {
  type: string;
  detail: unknown;
}

/**
 * Renders a Braid fragment.
 *
 * ```html
 * <braid-fragment name="billing" (ready)="onReady()" />
 * ```
 *
 * A thin, typed shim over the `<fragment-slot>` custom element. What it buys over using the
 * element directly:
 *
 * - **No `CUSTOM_ELEMENTS_SCHEMA` in your components.** The schema is declared here, once, so
 *   your templates keep their strict element checking.
 * - **Typed inputs and outputs.** `props` is an object rather than a JSON-encoded attribute, and
 *   events arrive as typed outputs rather than `CustomEvent` listeners you wire by hand.
 * - **The slot still renders during SSR**, which is what lets the gateway pierce the fragment's
 *   server-rendered markup into it. Only the event wiring is browser-only.
 */
@Component({
  selector: 'braid-fragment',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  // projected, so `<div slot="loading">` and `<p slot="fallback">` children reach the slot's own slots
  template: `<fragment-slot #slot [attr.name]="name()" [attr.src]="src() ?? null" [attr.requires]="requires() ?? null"><ng-content /></fragment-slot>`,
  styles: `
    :host,
    fragment-slot {
      display: block;
    }
  `,
})
export class BraidFragment {
  /** The fragment id, as registered in the gateway. */
  readonly name = input.required<string>();

  /**
   * A fixed route for the fragment. Omit it and the fragment is *bound*: it follows the host's
   * location, and navigations it performs drive the host URL.
   */
  readonly src = input<string>();
  /** Mount prerequisites the fragment waits for, space-separated (see `initBraid({ prerequisites })`). */
  readonly requires = input<string>();

  /** Props handed to the fragment. Structured-cloned across the realm boundary. */
  readonly props = input<Record<string, unknown>>();

  /** The fragment booted and is running. */
  readonly ready = output<{ fragmentId: string }>();
  /** The fragment failed to boot; the detail names the stage and the likely fix. */
  readonly failed = output<BraidFragmentError>();
  /** The fragment emitted an event to the host. */
  readonly fragmentEvent = output<BraidFragmentEvent>();

  private readonly slotRef = viewChild.required<ElementRef<HTMLElement>>('slot');
  private readonly slotState = signal<FragmentSlotState>('idle');

  /** The fragment's lifecycle state, for templates that want to show their own placeholder. */
  readonly state = computed(() => this.slotState());

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Props are a property, not an attribute: they cross the realm boundary by structured
    // clone, so they are never serialized to a string.
    effect(() => {
      const props = this.props();
      const slot = this.slotRef().nativeElement as HTMLElement & { props?: Record<string, unknown> };
      if (props !== undefined) slot.props = props;
    });

    // Browser-only: on the server the element is rendered so the gateway has something to
    // pierce into, but there is nothing to listen to.
    afterNextRender(() => {
      const slot = this.slotRef().nativeElement as HTMLElement & { state?: FragmentSlotState };
      const controller = new AbortController();
      const listen = <T>(type: string, handle: (detail: T) => void) =>
        slot.addEventListener(
          type,
          (event) => {
            this.slotState.set(slot.state ?? 'idle');
            handle((event as CustomEvent<T>).detail);
          },
          { signal: controller.signal },
        );

      listen<{ fragmentId: string }>('braid:ready', (detail) => this.ready.emit(detail));
      listen<BraidFragmentError>('braid:error', (detail) => this.failed.emit(detail));
      listen<BraidFragmentEvent>('braid:event', (detail) => this.fragmentEvent.emit(detail));

      this.slotState.set(slot.state ?? 'loading');
      destroyRef.onDestroy(() => controller.abort());
    });
  }

  /** Tears the fragment down and boots it again from the network. */
  async reload(): Promise<void> {
    const slot = this.slotRef().nativeElement as HTMLElement & { reload?: () => Promise<void> };
    await slot.reload?.();
  }
}
