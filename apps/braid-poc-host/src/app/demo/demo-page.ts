import { Component, inject, signal, viewChild } from '@angular/core';
import { DATA_OPTIONS, OUTBOX_COLLECTION, OutboxService } from '@braidlabs/angular-data';
import { DemoComposition } from './composition-panels';
import { DemoContract } from './contract-panel';
import { DemoData } from './data-panels';
import { DemoDurability } from './durability-panels';

/**
 * The demo page.
 *
 * Every panel makes **one claim, offers one control, and shows its own proof**. The proof is
 * rendered in the panel on purpose: "open devtools and look at the network tab" is homework, not a
 * demonstration.
 *
 * Two acts are here because two acts work today. The shared-cache, invalidation, and skew panels
 * need the data layer's read path, and half-stubbed panels would undermine the ones that are real.
 */
@Component({
  selector: 'demo-page',
  standalone: true,
  imports: [DemoComposition, DemoContract, DemoData, DemoDurability],
  template: `
    <div class="intro">
      <h1>What this actually does</h1>
      <p>
        Each panel below states one claim and shows you the evidence for it. Nothing here needs
        devtools.
      </p>
      <div class="row">
        <button type="button" (click)="reset()">Reset the demo</button>
        <span class="hint">
          The demo persists to disk, so it accumulates state between visits — this clears it.
        </span>
      </div>
      @if (justReset()) {
        <p class="ok">Cleared. Queued work, edits, and the offline switch are all back to default.</p>
      }
    </div>

    <demo-composition />
    <demo-contract />
    <demo-data />
    <demo-durability />

    <div class="later">
      <h2>A limitation this page used to run into</h2>
      <p>
        A compat fragment that has <em>its own router</em> performs an initial navigation when its
        realm boots — and a compat realm is a real same-origin iframe, so that navigation lands in
        the joint session history and could undo the host's own. Mounting the Angular
        <strong>billing</strong> remote here used to bounce you to <code>/billing/invoices</code>.
      </p>
      <p>
        Fixed by gating the privilege on the user rather than on the clock: a bound fragment may
        move the host URL only once someone has acted inside it, so a router settling into its
        route changes its own <code>location</code> and nothing else. The first version of this fix
        gated on <em>boot finishing</em> and did not hold — Angular resolves its initial route
        about 170ms later, well after the last script returned. See
        <code>docs/braid-failure-modes.md</code>.
      </p>
    </div>
  `,
  styles: `
    :host { display: block; }
    .intro h1 { font-size: 1.25rem; margin: 0 0 0.35rem; }
    .intro p { margin: 0 0 0.6rem; color: #475569; font-size: 0.9rem; }
    .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    button { font: inherit; padding: 0.3rem 0.7rem; border: 1px solid #cbd5e1; border-radius: 5px; background: #f8fafc; cursor: pointer; }
    .hint { font-size: 0.8rem; color: #64748b; }
    .ok { color: #16a34a; font-size: 0.85rem; margin: 0.4rem 0 0; }
    .later { margin-top: 1.6rem; padding: 0.85rem; border: 1px dashed #cbd5e1; border-radius: 8px; background: #f8fafc; }
    .later h2 { font-size: 0.95rem; margin: 0 0 0.35rem; }
    .later p { margin: 0; font-size: 0.83rem; color: #64748b; line-height: 1.5; }
    code { font-size: 0.8rem; }
  `,
})
export class DemoPage {
  private readonly durability = viewChild(DemoDurability);

  private readonly outbox = inject(OutboxService);
  private readonly options = inject(DATA_OPTIONS);
  readonly justReset = signal(false);

  /**
   * Clears both halves of the demo's state.
   *
   * Persistence-first means state survives visits, so without this the second visitor sees the
   * first visitor's queue — and it survives `rm -rf`, because it is in the browser rather than on
   * the server.
   *
   * Deliberately **not** `outbox.clear()`, which discards only this app's work and leaves other
   * apps' entries alone. That is right for an application and wrong for a reset button: wiping the
   * partition is the demo speaking for the whole page, and is a preview of the sign-out purge the
   * tenancy work will make a first-class operation.
   */
  async reset(): Promise<void> {
    await this.options.driver.clearPartition(OUTBOX_COLLECTION, 'session');
    // panel 9's side-by-side lives in its own partition
    await this.options.driver.clearPartition(OUTBOX_COLLECTION, 'compare');
    await this.outbox.load();
    await this.outbox.flush();
    // Panel 9 owns its own reset: one of its two queues is in memory, which no driver here can
    // reach, and its counts have to be re-read or the panel keeps showing numbers that are stale.
    await this.durability()?.resetComparison();
    await fetch('/api/demo/reset', { method: 'POST' });
    this.justReset.set(true);
    setTimeout(() => this.justReset.set(false), 2500);
  }
}
