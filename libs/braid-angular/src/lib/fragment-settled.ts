import {
  afterNextRender,
  ApplicationRef,
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  PLATFORM_ID,
  provideEnvironmentInitializer,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { braidFragmentReporter } from '@braidlabs/core';

/**
 * Tells the host slot when this app's first content has settled — for a compat fragment.
 *
 * ```ts
 * bootstrapApplication(App, { providers: [provideHttpClient(), provideRouter(routes), provideBraidFragment()] });
 * ```
 *
 * "Settled" is the application's first `ApplicationRef.whenStable()`: rendered, with no pending
 * tasks — which includes the `HttpClient` requests its first screen is waiting on. The host sees it
 * as the slot's `settled` attribute, so a skeleton can stay up until the app has something to show,
 * rather than until its realm happens to be running.
 *
 * A compat fragment is otherwise an unmodified app, and nothing outside it can see when it is done
 * loading, so this one provider is the price. Outside a Braid realm — the app served standalone —
 * there is no reporter and it does nothing. Contract fragments don't need it:
 * `defineAngularFragment` reports on its own.
 */
export function provideBraidFragment(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideEnvironmentInitializer(() => {
      if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
      const reporter = braidFragmentReporter();
      if (!reporter) return;
      void whenFirstStable(inject(ApplicationRef)).then(() => reporter.settled());
    }),
  ]);
}

/**
 * Resolves on the application's first stability *after its first render*.
 *
 * `whenStable()` alone resolves at once when asked before the root component exists — which is when
 * an initializer runs — because nothing is pending yet. After the first render, `ngOnInit` has run
 * and the requests the first screen waits on are pending tasks, so stability means they are done.
 */
export function whenFirstStable(app: ApplicationRef): Promise<void> {
  return new Promise((resolve) => {
    afterNextRender(() => void app.whenStable().then(resolve), { injector: app.injector });
  });
}
