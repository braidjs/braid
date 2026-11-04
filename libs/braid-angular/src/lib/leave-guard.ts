import type { CanDeactivateFn } from '@angular/router';
import { dirtySlots, type ConfirmLeave } from '@braidlabs/core';

export interface BraidLeaveGuardOptions<T> {
  /**
   * Where to look for unsaved work: the view being left. Defaults to the whole document, which also
   * counts a dirty fragment in a layout that outlives the route (a sidebar), so it asks on every
   * route change while that fragment is dirty. Return the routed component's element to ask only
   * about its own fragments.
   */
  within?: (component: T) => ParentNode | null | undefined;
}

/**
 * A `canDeactivate` guard that asks before leaving a route while a fragment holds unsaved work
 * (`env.setDirty`), in open shadow roots too. With nothing unsaved it lets the navigation through
 * at once; a `confirm` that throws or rejects keeps the user where they are.
 *
 * ```ts
 * {
 *   path: 'billing',
 *   component: BillingPage,
 *   canDeactivate: [braidLeaveGuard((slots) => confirm(`Leave ${slots.length} unsaved form(s)?`), { within: (page) => page.host.nativeElement })],
 * }
 * ```
 *
 * The router's guard is where an in-app navigation is held: it runs before the URL changes, so
 * declining leaves the router and the address bar where they were. Navigations to another document
 * are `initBraid({ confirmLeave })`'s.
 */
export function braidLeaveGuard<T = unknown>(confirm: ConfirmLeave, options: BraidLeaveGuardOptions<T> = {}): CanDeactivateFn<T> {
  return async (component) => {
    const slots = dirtySlots(options.within?.(component) ?? document);
    if (slots.length === 0) return true;
    try {
      return await confirm(slots);
    } catch (error) {
      console.error('[braid] the leave guard confirm failed; staying on the page', error);
      return false;
    }
  };
}
