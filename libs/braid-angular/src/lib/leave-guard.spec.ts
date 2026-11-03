import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
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
