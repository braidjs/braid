import type { CanDeactivateFn } from '@angular/router';
import { dirtySlots, type ConfirmLeave } from '@braidlabs/core';

/**
 * A `canDeactivate` guard that asks before leaving a route while a fragment on the page holds
 * unsaved work (`env.setDirty`). With nothing unsaved it lets the navigation through at once.
 *
 * ```ts
 * { path: 'billing', component: BillingPage, canDeactivate: [braidLeaveGuard((slots) => confirm(`Leave ${slots.length} unsaved form(s)?`))] }
 * ```
 *
 * The router's guard is where an in-app navigation is held: it runs before the URL changes, so
 * declining leaves the router and the address bar where they were. Navigations to another document
 * are `initBraid({ confirmLeave })`'s.
 */
export function braidLeaveGuard(confirm: ConfirmLeave): CanDeactivateFn<unknown> {
  return () => {
    const slots = dirtySlots();
    return slots.length === 0 ? true : Promise.resolve(confirm(slots));
  };
}
