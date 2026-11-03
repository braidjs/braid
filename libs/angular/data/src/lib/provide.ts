import {
  DOCUMENT,
  type EnvironmentProviders,
  PLATFORM_ID,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { DATA_OPTIONS, type DataOptionsInput, resolveDataOptions } from './config';
import { OutboxService } from './outbox';

/**
 * Enables the data layer.
 *
 * ```ts
 * provideSkewData({
 *   owner: 'bulletin',
 *   persistOutbox: true,
 *   buildId: BUILD_ID,
 *   onOutboxError: (message, detail) => telemetry.error(message, detail),
 * });
 * ```
 */
export function provideSkewData(input: DataOptionsInput = {}): EnvironmentProviders {
  const options = resolveDataOptions(input);

  return makeEnvironmentProviders([
    { provide: DATA_OPTIONS, useValue: options },
    provideEnvironmentInitializer(() => {
      const outbox = inject(OutboxService);
      const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
      if (!isBrowser) return;

      // Rehydrate immediately: work queued before the last reload should reach
      // the server as soon as this build is running, not on the next mutation.
      // A partitioned queue refuses to be read while nobody is signed in; that is reported, not left
      // as an unhandled rejection, and the app's flush after sign-in picks the queue up.
      const report = (error: unknown) =>
        options.onOutboxError?.(`[skew/data] the outbox could not be read: ${String(error)}`, error);
      void outbox.load().then(() => outbox.flush()).catch(report);

      if (options.flushOnReconnect) {
        const view = inject(DOCUMENT).defaultView;
        view?.addEventListener('online', () => void outbox.flush().catch(report));
      }
    }),
  ]);
}
