import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BraidFragment, type BraidFragmentEvent } from './braid-fragment';

/**
 * The component is a shim, so these assert the shim's contract: the element it renders (which is
 * what the gateway pierces into), and the translation between DOM events and typed outputs.
 */

@Component({
  standalone: true,
  imports: [BraidFragment],
  template: `
    <braid-fragment
      [name]="name()"
      [src]="src()"
      [props]="props()"
      (ready)="readyCount = readyCount + 1"
      (fragmentEvent)="lastEvent = $event"
    />
  `,
})
class HostComponent {
  readonly name = signal('billing');
  readonly src = signal<string | undefined>(undefined);
  readonly props = signal<Record<string, unknown> | undefined>(undefined);
  readyCount = 0;
  lastEvent: BraidFragmentEvent | undefined;
}

function render() {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const slot = fixture.nativeElement.querySelector('fragment-slot') as HTMLElement & {
    props?: Record<string, unknown>;
  };
  return { fixture, slot };
}

@Component({
  standalone: true,
  imports: [BraidFragment],
  template: `
    <braid-fragment name="billing">
      <div slot="loading" class="skeleton"></div>
      <p slot="fallback">Billing is unavailable.</p>
    </braid-fragment>
  `,
})
class ProjectingHostComponent {}

describe('BraidFragment', () => {
  it('projects loading and fallback children into the slot', () => {
    const fixture = TestBed.createComponent(ProjectingHostComponent);
    fixture.detectChanges();
    const slot = fixture.nativeElement.querySelector('fragment-slot') as HTMLElement;
    expect(slot.querySelector(':scope > [slot="loading"].skeleton')).not.toBeNull();
    expect(slot.querySelector(':scope > [slot="fallback"]')?.textContent).toBe('Billing is unavailable.');
  });

  it('renders the fragment-slot element the gateway pierces into', () => {
    const { slot } = render();

    expect(slot).not.toBeNull();
    expect(slot.getAttribute('name')).toBe('billing');
  });

  it('omits src entirely when unset, so the fragment is bound to the host location', () => {
    const { slot } = render();

    expect(slot.hasAttribute('src')).toBe(false);
  });

  it('passes src through when given, making the fragment standalone', () => {
    const { fixture, slot } = render();
    fixture.componentInstance.src.set('/panel');
    fixture.detectChanges();

    expect(slot.getAttribute('src')).toBe('/panel');
  });

  it('sets props as a property, never as a serialized attribute', () => {
    const { fixture, slot } = render();
    fixture.componentInstance.props.set({ cartId: 'abc', count: 2 });
    fixture.detectChanges();

    expect(slot.props).toEqual({ cartId: 'abc', count: 2 });
    expect(slot.hasAttribute('props')).toBe(false);
  });

  it('translates slot events into typed outputs', () => {
    const { fixture, slot } = render();

    slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));
    slot.dispatchEvent(
      new CustomEvent('braid:event', { detail: { type: 'checkout:done', detail: { orderId: 7 } } }),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.readyCount).toBe(1);
    expect(fixture.componentInstance.lastEvent).toEqual({ type: 'checkout:done', detail: { orderId: 7 } });
  });

  it('stops listening once the host is destroyed', () => {
    const { fixture, slot } = render();
    fixture.destroy();

    slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));

    expect(fixture.componentInstance.readyCount).toBe(0);
  });

  it('exposes the slot state', () => {
    const { fixture, slot } = render();
    (slot as HTMLElement & { state?: string }).state = 'ready';
    slot.dispatchEvent(new CustomEvent('braid:ready', { detail: { fragmentId: 'billing' } }));
    fixture.detectChanges();

    const fragment = fixture.debugElement.children[0].componentInstance as BraidFragment;
    expect(fragment.state()).toBe('ready');
  });
});
