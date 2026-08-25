# @braidlabs/angular-workflow

Durable, multi-step wizards and form workflows for Angular. Features router integration, guard-checked deep links, step resumption across reloads, and versioned drafts that survive schema changes across deployments.

---

## Installation

```bash
npm install @braidlabs/angular-workflow @braidlabs/skew
```

---

## Key Features

1. **Router & Guard Integration:** Step-to-route synchronization; deep linking to incomplete steps safely redirects to the furthest valid step.
2. **Versioned Drafts:** Draft state is wrapped in a `@braidlabs/skew` schema and persisted to local storage, surviving app updates and schema changes.
3. **Idempotency by Design:** A unique `runId` is generated when the workflow starts and passed to the terminal `submit()`, preventing duplicate submissions.
4. **Pure Headless Testing:** Transitions and validation rules can be tested without `TestBed` or DOM rendering.

---

## Usage

### 1. Define the Workflow

```ts
import { defineWorkflow } from '@braidlabs/angular-workflow';
import { versioned } from '@braidlabs/skew';

interface CheckoutData {
  shippingAddress: string;
  paymentMethod: string;
  couponCode?: string;
}

export const checkoutWorkflow = defineWorkflow({
  id: 'checkout-flow',
  initial: { shippingAddress: '', paymentMethod: '' },
  steps: {
    shipping: {
      route: 'shipping',
      validate: (d) => d.shippingAddress.length > 5,
      next: 'payment',
    },
    payment: {
      route: 'payment',
      validate: (d) => d.paymentMethod.length > 0,
      next: 'review',
    },
    review: {
      route: 'review',
      terminal: true,
      submit: async (data, ctx) => {
        await fetch('/api/orders', {
          method: 'POST',
          headers: { 'X-Idempotency-Key': ctx.runId },
          body: JSON.stringify(data),
        });
      },
    },
  },
});
```

### 2. Connect to Angular Components

```ts
import { Component } from '@angular/core';
import { injectWorkflow } from '@braidlabs/angular-workflow';
import { checkoutWorkflow } from './checkout.workflow';

@Component({
  standalone: true,
  template: `
    <div class="step-wizard">
      <p>Current Step: {{ flow.current() }}</p>
      <p>Progress: {{ flow.progress().percent }}%</p>

      <button [disabled]="!flow.canAdvance()" (click)="next()">Continue</button>
    </div>
  `,
})
export class CheckoutWizardComponent {
  readonly flow = injectWorkflow(checkoutWorkflow);

  async next() {
    await this.flow.advance({ shippingAddress: '123 Market St' });
  }
}
```

### 3. Generate Guarded Routes

```ts
import { Routes } from '@angular/router';
import { workflowRoutes } from '@braidlabs/angular-workflow';
import { checkoutWorkflow } from './checkout.workflow';

export const routes: Routes = [
  {
    path: 'checkout',
    children: workflowRoutes(checkoutWorkflow, {
      shipping: () => import('./steps/shipping').then((m) => m.ShippingStepComponent),
      payment: () => import('./steps/payment').then((m) => m.PaymentStepComponent),
      review: () => import('./steps/review').then((m) => m.ReviewStepComponent),
    }),
  },
];
```
