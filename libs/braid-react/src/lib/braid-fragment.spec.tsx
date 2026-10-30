import { describe, expect, it, vi } from 'vitest';
import { createRef, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BraidFragment, type BraidFragmentHandle } from './braid-fragment.js';

/**
 * The component is a shim, so these assert the shim's contract: the element it renders (which is
 * what the gateway pierces into) and the translation between DOM events and React props.
 */

type SlotElement = HTMLElement & { props?: Record<string, unknown>; state?: string; reload?: () => Promise<void> };

function render(ui: React.ReactNode): { container: HTMLElement; slot: SlotElement; root: Root } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  act(() => root.render(ui));

  return { container, slot: container.querySelector('fragment-slot') as SlotElement, root };
}

describe('BraidFragment', () => {
  it('renders the fragment-slot element the gateway pierces into', () => {
    const { slot } = render(<BraidFragment name="billing" />);

    expect(slot).not.toBeNull();
    expect(slot.getAttribute('name')).toBe('billing');
  });

  it('passes loading and fallback children through to the slot, and renders none when given none', () => {
    const { slot } = render(
      <BraidFragment name="billing">
        <div slot="loading" className="skeleton" />
        <p slot="fallback">Billing is unavailable.</p>
      </BraidFragment>,
    );
    expect(slot.querySelector(':scope > [slot="loading"].skeleton')).not.toBeNull();
    expect(slot.querySelector(':scope > [slot="fallback"]')?.textContent).toBe('Billing is unavailable.');

    expect(render(<BraidFragment name="billing" />).slot.childElementCount).toBe(0);
  });

  it('omits src entirely when unset, so the fragment is bound to the host location', () => {
    const { slot } = render(<BraidFragment name="billing" />);

    expect(slot.hasAttribute('src')).toBe(false);
  });

  it('passes src through when given, making the fragment standalone', () => {
    const { slot } = render(<BraidFragment name="billing" src="/panel" />);

    expect(slot.getAttribute('src')).toBe('/panel');
  });

  it('sets props as a property, never as a serialized attribute', () => {
    const { slot } = render(<BraidFragment name="billing" props={{ cartId: 'abc', count: 2 }} />);

    expect(slot.props).toEqual({ cartId: 'abc', count: 2 });
    expect(slot.hasAttribute('props')).toBe(false);
  });

  it('updates props on re-render', () => {
    const { slot, root } = render(<BraidFragment name="billing" props={{ count: 1 }} />);
    act(() => root.render(<BraidFragment name="billing" props={{ count: 2 }} />));

    expect(slot.props).toEqual({ count: 2 });
  });

  it('translates slot events into React props', () => {
    const onReady = vi.fn();
    const onFragmentEvent = vi.fn();
    const { slot } = render(
      <BraidFragment name="billing" onReady={onReady} onFragmentEvent={onFragmentEvent} />,
    );

    act(() => {
      slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));
      slot.dispatchEvent(
        new CustomEvent('braid:event', { detail: { type: 'checkout:done', detail: { orderId: 7 } } }),
      );
    });

    expect(onReady).toHaveBeenCalledWith({ fragmentId: 'billing' });
    expect(onFragmentEvent).toHaveBeenCalledWith({ type: 'checkout:done', detail: { orderId: 7 } });
  });

  it('does not resubscribe listeners when handlers change identity', () => {
    // an inline arrow prop changes every render; the listener must not be torn down and re-added
    const calls: string[] = [];
    const { slot, root } = render(<BraidFragment name="billing" onReady={() => calls.push('first')} />);
    act(() => root.render(<BraidFragment name="billing" onReady={() => calls.push('second')} />));

    act(() => slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } })));

    expect(calls).toEqual(['second']);
  });

  it('reports state changes', () => {
    const onStateChange = vi.fn();
    const { slot } = render(<BraidFragment name="billing" onStateChange={onStateChange} />);
    slot.state = 'ready';

    act(() => slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } })));

    expect(onStateChange).toHaveBeenCalledWith('ready');
  });

  it('stops listening once unmounted', () => {
    const onReady = vi.fn();
    const { slot, root } = render(<BraidFragment name="billing" onReady={onReady} />);

    act(() => root.unmount());
    slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));

    expect(onReady).not.toHaveBeenCalled();
  });

  it('exposes reload through a ref', async () => {
    const ref = createRef<BraidFragmentHandle>();
    const { slot } = render(<BraidFragment name="billing" ref={ref} />);
    const reload = vi.fn(async () => undefined);
    slot.reload = reload;

    await ref.current!.reload();

    expect(reload).toHaveBeenCalled();
  });
});
