import { ApplicationRef, Component, inject, OnInit, PendingTasks, provideZonelessChangeDetection } from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { BRAID_FRAGMENT_REPORTER } from '@braidlabs/core';
import { provideBraidFragment } from './fragment-settled';

/**
 * Bootstrapped for real, not through TestBed: the order that matters — initializers, then the root
 * component, then its first render — is the application's own. The reporter is what a compat realm
 * installs on its global; standing one up here puts the app "inside" a realm. A pending task added
 * in `ngOnInit` stands in for the first screen's HTTP request, which `HttpClient` registers the same way.
 */

let finishLoading: () => void;

@Component({ selector: 'braid-test-app', standalone: true, template: '<p>app</p>' })
class AppComponent implements OnInit {
  readonly #tasks = inject(PendingTasks);
  ngOnInit(): void {
    finishLoading = this.#tasks.add();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function bootstrap(): Promise<ApplicationRef> {
  document.body.replaceChildren(document.createElement('braid-test-app'));
  const app = await createApplication({ providers: [provideZonelessChangeDetection(), provideBraidFragment()] });
  app.bootstrap(AppComponent);
  return app;
}

describe('provideBraidFragment()', () => {
  let reports: number;

  beforeEach(() => {
    reports = 0;
    Object.defineProperty(globalThis, BRAID_FRAGMENT_REPORTER, { value: { settled: () => reports++ }, configurable: true });
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[BRAID_FRAGMENT_REPORTER];
  });

  it('reports settled once the first screen has loaded, not before', async () => {
    const app = await bootstrap();

    await settle();
    expect(document.querySelector('braid-test-app p')?.textContent).toBe('app');
    expect(reports).toBe(0);

    finishLoading();
    await settle();
    expect(reports).toBe(1);
    app.destroy();
  });

  it('does nothing outside a Braid realm', async () => {
    delete (globalThis as Record<symbol, unknown>)[BRAID_FRAGMENT_REPORTER];
    const app = await bootstrap();
    finishLoading();
    await expect(app.whenStable()).resolves.toBeUndefined();
    app.destroy();
  });
});
