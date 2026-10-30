import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { FragmentSlotState } from '@braidlabs/core';

/** The `detail` of a `braid:error` event. */
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

/** Imperative handle, for hosts that need to force a fragment to boot again. */
export interface BraidFragmentHandle {
  reload(): Promise<void>;
  readonly state: FragmentSlotState;
}

export interface BraidFragmentProps {
  /** The fragment id, as registered in the gateway. */
  name: string;
  /**
   * A fixed route for the fragment. Omit it and the fragment is *bound*: it follows the host's
   * location, and navigations it performs drive the host URL.
   */
  src?: string;
  /** Props handed to the fragment. Structured-cloned across the realm boundary. */
  props?: Record<string, unknown>;
  /** Mount prerequisites the fragment waits for, space-separated (see `initBraid({ prerequisites })`). */
  requires?: string;
  onReady?: (detail: { fragmentId: string }) => void;
  onError?: (detail: BraidFragmentError) => void;
  onFragmentEvent?: (detail: BraidFragmentEvent) => void;
  /** Called whenever the fragment's lifecycle state changes. */
  onStateChange?: (state: FragmentSlotState) => void;
  className?: string;
  style?: React.CSSProperties;
  ref?: Ref<BraidFragmentHandle>;
}

type SlotElement = HTMLElement & {
  props?: Record<string, unknown>;
  state?: FragmentSlotState;
  reload?: () => Promise<void>;
};

/**
 * Renders a Braid fragment.
 *
 * ```tsx
 * <BraidFragment name="billing" onReady={() => …} />
 * ```
 *
 * A typed shim over the `<fragment-slot>` custom element. It renders the element during SSR too,
 * which is what lets the gateway pierce the fragment's server-rendered markup into the page —
 * only the event wiring is browser-only.
 *
 * `props` is assigned as a DOM *property* rather than an attribute: it crosses the realm boundary
 * by structured clone, so serializing it to a string would be wrong.
 */
export function BraidFragment({
  name,
  src,
  props,
  requires,
  onReady,
  onError,
  onFragmentEvent,
  onStateChange,
  className,
  style,
  ref,
}: BraidFragmentProps) {
  const slotRef = useRef<SlotElement>(null);
  const [, setState] = useState<FragmentSlotState>('idle');

  // handlers live in a ref so re-renders never re-subscribe the listeners
  const handlers = useRef({ onReady, onError, onFragmentEvent, onStateChange });
  handlers.current = { onReady, onError, onFragmentEvent, onStateChange };

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const controller = new AbortController();
    const listen = <T,>(type: string, handle: (detail: T) => void) =>
      slot.addEventListener(
        type,
        (event) => {
          const next = slot.state ?? 'idle';
          setState(next);
          handlers.current.onStateChange?.(next);
          handle((event as CustomEvent<T>).detail);
        },
        { signal: controller.signal },
      );

    listen<{ fragmentId: string }>('braid:ready', (detail) => handlers.current.onReady?.(detail));
    listen<BraidFragmentError>('braid:error', (detail) => handlers.current.onError?.(detail));
    listen<BraidFragmentEvent>('braid:event', (detail) => handlers.current.onFragmentEvent?.(detail));

    return () => controller.abort();
  }, []);

  // a property, never a serialized attribute
  useEffect(() => {
    const slot = slotRef.current;
    if (slot && props !== undefined) slot.props = props;
  }, [props]);

  const reload = useCallback(async () => {
    await slotRef.current?.reload?.();
  }, []);

  useImperativeHandle(ref, () => ({ reload, get state() { return slotRef.current?.state ?? 'idle'; } }), [reload]);

  return (
    <fragment-slot
      ref={slotRef}
      name={name}
      {...(src === undefined ? {} : { src })}
      {...(requires === undefined ? {} : { requires })}
      class={className}
      style={style}
    />
  );
}

/**
 * `<fragment-slot>` is a custom element, so React needs to be told it exists — declared here,
 * once, rather than by every host that renders a fragment.
 */
declare module 'react' {
  /* eslint-disable-next-line @typescript-eslint/no-namespace -- React 19 moved
     JSX.IntrinsicElements into a namespace inside the `react` module; augmenting it has no
     module-syntax equivalent. */
  namespace JSX {
    interface IntrinsicElements {
      'fragment-slot': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        name?: string;
        src?: string;
        class?: string;
        ref?: React.Ref<SlotElement | null>;
      };
    }
  }
}
