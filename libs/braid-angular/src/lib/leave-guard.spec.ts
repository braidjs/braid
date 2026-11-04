import { Component, ElementRef, inject, provideZonelessChangeDetection, Type, ViewEncapsulation } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CanDeactivateFn, provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { braidLeaveGuard } from './leave-guard';

/**
 * The guard on a real router: it runs before the URL changes, so declining leaves both the router
 * and the address where they were. A slot is stood in for by an element carrying `dirty`, which is
 * all the guard reads.
 */

@Component({ standalone: true, template: '<p>start</p>' })
class StartPage {}

@Component({ standalone: true, template: '<p>next</p>' })
class NextPage {}

function slotWith(dirty: string | null): HTMLElement {
  const slot = document.createElement('fragment-slot');
  Object.defineProperty(slot, 'dirty', { value: dirty });
  document.body.append(slot);
  return slot;
}

async function start(confirm: (slots: readonly HTMLElement[]) => boolean | Promise<boolean>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: '', component: StartPage, canDeactivate: [braidLeaveGuard(confirm)] },
        { path: 'next', component: NextPage },
      ]),
    ],
  });
  await RouterTestingHarness.create('/');
  return TestBed.inject(Router);
}

afterEach(() => {
  document.querySelectorAll('fragment-slot').forEach((slot) => slot.remove());
});

describe('braidLeaveGuard', () => {
  it('lets the navigation through, without asking, when nothing is unsaved', async () => {
    slotWith(null);
    const confirm = vi.fn(() => false);
    const router = await start(confirm);

    expect(await router.navigateByUrl('/next')).toBe(true);
    expect(router.url).toBe('/next');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks with the slots that hold unsaved work, and stays when the answer is no', async () => {
    const editing = slotWith('editing invoice');
    slotWith(null);
    const confirm = vi.fn(async () => false);
    const router = await start(confirm);

    expect(await router.navigateByUrl('/next')).toBe(false);
    expect(router.url).toBe('/');
    expect(confirm).toHaveBeenCalledWith([editing]);
  });

  it('leaves when the answer is yes', async () => {
    slotWith('editing invoice');
    const router = await start(() => true);

    expect(await router.navigateByUrl('/next')).toBe(true);
    expect(router.url).toBe('/next');
  });
});

@Component({ standalone: true, template: '<p>shadow</p>', encapsulation: ViewEncapsulation.ShadowDom })
class ShadowPage {
  readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
}

async function startOn(page: Type<unknown>, guard: CanDeactivateFn<unknown>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: '', component: page, canDeactivate: [guard] },
        { path: 'next', component: NextPage },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create('/');
  return { router: TestBed.inject(Router), page: harness.routeDebugElement!.componentInstance as ShadowPage };
}

describe('braidLeaveGuard, in shadow DOM and scoped', () => {
  it('finds unsaved work inside a routed component that renders with shadow DOM', async () => {
    const confirm = vi.fn(() => false);
    const { router, page } = await startOn(ShadowPage, braidLeaveGuard(confirm));
    const slot = slotWith('editing');
    page.host.nativeElement.shadowRoot!.append(slot);

    expect(await router.navigateByUrl('/next')).toBe(false);
    expect(confirm).toHaveBeenCalledWith([slot]);
  });

  it('asks only about the view being left, given its host element as the docs show', async () => {
    slotWith('in a sidebar that outlives the route');
    const confirm = vi.fn(() => false);
    const guard = braidLeaveGuard<ShadowPage>(confirm, { within: (page) => page.host.nativeElement });
    const { router } = await startOn(ShadowPage, guard as CanDeactivateFn<unknown>);

    expect(await router.navigateByUrl('/next')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks about a slot in the view’s own shadow DOM, given its host element', async () => {
    const confirm = vi.fn(() => false);
    const guard = braidLeaveGuard<ShadowPage>(confirm, { within: (page) => page.host.nativeElement });
    const { router, page } = await startOn(ShadowPage, guard as CanDeactivateFn<unknown>);
    const inView = slotWith('in the view');
    page.host.nativeElement.shadowRoot!.append(inView);

    expect(await router.navigateByUrl('/next')).toBe(false);
    expect(confirm).toHaveBeenCalledWith([inView]);
  });

  it('stays when confirm fails', async () => {
    slotWith('editing');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = await start(() => Promise.reject(new Error('dialog broke')));

    expect(await router.navigateByUrl('/next')).toBe(false);
    expect(router.url).toBe('/');
    error.mockRestore();
  });
});
