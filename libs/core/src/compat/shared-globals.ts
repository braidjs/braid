import { getBraidConfig, isDevMode } from '../config.js';

/**
 * Lets a trusted fragment use globals the host has explicitly shared — its analytics data layer,
 * tag manager, feedback widget — instead of a realm-local copy nobody is listening to.
 *
 * Each name becomes an accessor on the fragment's **realm** window that reads and writes the host
 * window's property. Nothing is installed on the host: what is new is that a fragment may now
 * write host globals the host named itself, which is a trust decision the host makes in config.
 *
 * - The getter reads live, so a vendor script the host loads after the fragment boots is still
 *   seen.
 * - Bare identifiers reach the accessor too: a classic script's `var dataLayer = dataLayer || []`
 *   leaves an existing own property in place, so it reads and writes the host's array.
 * - Configurable, so a fragment that *declares* the name (`function dataLayer(){}`) shadows it in
 *   its own realm instead of failing to run.
 *
 * Any name the realm window already has is skipped: that one rule keeps `location`, `document`,
 * `top`, `eval`, every constructor and every name the compat layer has already patched out of
 * reach, without a denylist to maintain.
 */
export function installSharedGlobals(
  realmWindow: Window,
  mainWindow: Window,
  names: readonly string[],
  fragmentId: string,
): void {
  const host = mainWindow as unknown as Record<string, unknown>;

  for (const name of names) {
    if (name in realmWindow) {
      if (isDevMode()) {
        console.warn(
          `[braid:${fragmentId}] shared global "${name}" was not shared: the fragment's realm already ` +
            `defines it, and sharing it would replace part of the realm itself.`,
        );
      }
      continue;
    }

    Object.defineProperty(realmWindow, name, {
      configurable: true,
      enumerable: true,
      get: () => host[name],
      set: (value: unknown) => {
        host[name] = value;
      },
    });
  }
}

/**
 * The host's `realmGlobals` for one fragment, or nothing. A hook that throws or rejects must not
 * take the fragment down with it: the fragment boots without them, and dev mode says why.
 */
export async function resolveRealmGlobals(fragmentId: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const hook = getBraidConfig().realmGlobals;
  if (!hook) return undefined;
  try {
    const globals = await hook({ fragmentId, signal });
    return globals && typeof globals === 'object' ? globals : undefined;
  } catch (error) {
    if (isDevMode()) console.warn(`[braid:${fragmentId}] realmGlobals hook failed; the fragment boots without them.`, error);
    return undefined;
  }
}

/**
 * Defines each of `globals` on the fragment's realm window — plain values, writable and
 * configurable, so a fragment that declares the name shadows it rather than failing to run.
 * Names the realm window already has are skipped, by the same rule as {@link installSharedGlobals}.
 */
export function installRealmGlobals(realmWindow: Window, globals: Readonly<Record<string, unknown>>, fragmentId: string): void {
  for (const [name, value] of Object.entries(globals)) {
    if (name in realmWindow) {
      if (isDevMode()) {
        console.warn(`[braid:${fragmentId}] realm global "${name}" was not installed: the fragment's realm already defines it.`);
      }
      continue;
    }
    Object.defineProperty(realmWindow, name, { configurable: true, enumerable: true, writable: true, value });
  }
}
