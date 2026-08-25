import { bootstrapApplication } from '@angular/platform-browser';
import { provideBraid } from '@braidlabs/angular';
import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, {
  providers: [
    ...appConfig.providers,

    /**
     * The entire host-side integration.
     *
     * `provideBraid()` initializes the runtime and subscribes to the router's *after*-navigation
     * events, so bound fragments follow host navigation. Braid never patches the host's History
     * API — host purity is an invariant — which is why that callback exists at all.
     */
    provideBraid({
      dev: true,
      /**
       * The host's own contract, which fragments can require a range of.
       *
       * The contract fragment on the demo page declares `requires: { host: '>=1.0.0' }`; raise that
       * to `>=2.0.0` in its source and the slot refuses at mount with both versions named, before
       * the fragment renders anything.
       */
      contract: { version: '1.0.0' },
    }),
  ],
}).catch((error) => console.error(error));
