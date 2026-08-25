import { ApplicationRef, createComponent, type EnvironmentProviders, type Type } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { defineFragment, type FragmentEnv, type FragmentContract } from '@braidlabs/core';

/**
 * The Angular guest binding: a contract-mode fragment.
 *
 * ```ts
 * // main.ts — the fragment's entry module
 * import { defineAngularFragment } from '@braidlabs/angular';
 * import { App } from './app';
 *
 * defineAngularFragment({
 *   component: App,
 *   contract: { version: '1.0.0' },
 *   providers: (env) => [provideRouter(routes), { provide: BASE_PATH, useValue: env.location.basePath }],
 * });
 * ```
 *
 * `createApplication()` rather than `bootstrapApplication()`, because the fragment does not own a
 * document element to bootstrap into — it owns `env.root`, inside the host's shadow tree. The
 * component is created explicitly and attached to the application's view tree, which is the same
 * thing bootstrap does with one fewer assumption about where the page came from.
 *
 * **What this is not doing, and why that matters.** No `DOCUMENT` token override, no zone patching
 * concerns, no router history virtualisation. In compat mode Angular believes it owns the browser
 * and Braid spends considerable machinery keeping that belief true — the document facade, the
 * history interception, the singleton renaming, the whole catalogue in `braid-failure-modes.md`. A
 * contract fragment is told the truth instead, and none of that code runs.
 */

export interface AngularFragmentOptions<T> {
  component: Type<T>;
  contract?: FragmentContract;
  /** Application-level providers. Receives the env so routing can be bound to `env.location`. */
  providers?(env: FragmentEnv): Array<EnvironmentProviders | unknown>;
}

export function defineAngularFragment<T>(options: AngularFragmentOptions<T>): void {
  defineFragment({
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    async mount(env: FragmentEnv) {
      const app: ApplicationRef = await createApplication({
        providers: (options.providers?.(env) ?? []) as never,
      });

      const component = createComponent(options.component, {
        environmentInjector: app.injector,
        hostElement: env.root,
      });
      app.attachView(component.hostView);

      /**
       * Destroyed on `signal`, which fires only after every `onClosing` handler has settled — so a
       * service flushing an outbox in `onClosing` still has its injector when it runs.
       */
      env.signal.addEventListener(
        'abort',
        () => {
          component.destroy();
          app.destroy();
        },
        { once: true },
      );
    },
  });
}
