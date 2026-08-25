import { afterEach, describe, expect, it, vi } from 'vitest';
import { BraidError } from '../errors.js';
import { contractAdapter } from './contract-adapter.js';
import { defineFragment, readFragmentDefinition } from '../env/define-fragment.js';
import type { AdapterBootContext } from './adapter.js';
import type { FragmentEnv } from '../env/fragment-env.js';

/** A realm stand-in: `evaluate()` runs the "entry module", which registers on the realm global. */
function realmWith(entry: string | undefined, onEvaluate?: (realmGlobal: Record<string, unknown>) => void) {
  const realmGlobal: Record<string, unknown> = {};
  return {
    kind: 'contract-blob' as const,
    fragmentId: 'checkout',
    window: realmGlobal as unknown as Window & typeof globalThis,
    document: document.implementation.createHTMLDocument(),
    manifestAdapter: 'contract',
    adapterOptions: entry === undefined ? {} : { entry },
    evaluate: async () => void onEvaluate?.(realmGlobal),
    evaluateModule: async () => true,
    dispose: () => undefined,
  };
}

function bootContext(realm: ReturnType<typeof realmWith>, env: Partial<FragmentEnv> = {}): AdapterBootContext {
  return {
    fragmentId: 'checkout',
    shadowRoot: document.createElement('div').attachShadow({ mode: 'open' }),
    contentRoot: document.createElement('braid-document'),
    realm: realm as unknown as AdapterBootContext['realm'],
    html: null,
    pierced: false,
    routeUrl: '/checkout',
    bound: true,
    env: env as FragmentEnv,
    signal: new AbortController().signal,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__braidFragment'];
});

describe('contract adapter', () => {
  it('boots a blob realm — the reason contract mode needs no gateway', () => {
    // No realm stub to serve, no namespace to route, no host-origin middleware to install.
    expect(contractAdapter.realmKind).toBe('contract-blob');
    expect(contractAdapter.needsDocument).toBe(false);
  });

  it('mounts the fragment its entry module registered', async () => {
    const mount = vi.fn();
    const realm = realmWith('/main.js', (realmGlobal) => {
      realmGlobal['__braidFragment'] = { mount };
    });
    const env = { root: document.createElement('div') } as FragmentEnv;

    await contractAdapter.boot(bootContext(realm, env));

    expect(mount).toHaveBeenCalledWith(env);
  });

  it('awaits an async mount', async () => {
    let settled = false;
    const realm = realmWith('/main.js', (realmGlobal) => {
      realmGlobal['__braidFragment'] = {
        mount: async () => {
          await Promise.resolve();
          settled = true;
        },
      };
    });

    await contractAdapter.boot(bootContext(realm));

    expect(settled).toBe(true);
  });

  it('names the fix when the entry module registered nothing', async () => {
    const realm = realmWith('/main.js');

    const error = await contractAdapter.boot(bootContext(realm)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('adapter-mount');
    expect((error as BraidError).fixHint).toContain('defineFragment');
  });

  it('refuses a fragment with no entry module', async () => {
    const error = await contractAdapter.boot(bootContext(realmWith(undefined))).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BraidError);
    expect((error as BraidError).stage).toBe('adapter-resolution');
  });
});

describe('defineFragment()', () => {
  it('registers on the realm global, where the host reads it', () => {
    // A registration rather than a module export: reaching a dynamically imported module's
    // namespace back across a realm works differently per bundler output shape.
    const definition = { mount: () => undefined };
    defineFragment(definition);

    expect(readFragmentDefinition(globalThis)).toBe(definition);
  });

  it('refuses a definition with no mount', () => {
    expect(() => defineFragment({} as never)).toThrow(TypeError);
  });

  it('warns when a realm gets two fragments, rather than silently losing one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    defineFragment({ mount: () => undefined });
    defineFragment({ mount: () => undefined });

    // The symptom otherwise is that the first fragment simply never mounts, which is a build
    // mistake with a very confusing shape.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('own realm');
    warn.mockRestore();
  });

  it('yields undefined for a realm nobody registered in', () => {
    expect(readFragmentDefinition({})).toBeUndefined();
    expect(readFragmentDefinition(undefined)).toBeUndefined();
  });
});
