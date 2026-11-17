import { catalogId, checkCatalog, parseCatalog } from './catalog.js';
import {
  createClientManifest,
  manifestFingerprint,
  parseClientManifest,
} from './manifest.js';

/**
 * The `sdui` command, as a function of its arguments and the files it may touch.
 *
 * File access is passed in, so this stays as platform-neutral as the rest of the package and the
 * tests can run it without a process or a disk. `bin/sdui.ts` is the three lines that hand it the
 * real ones.
 */
export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const SDUI_USAGE = `sdui — catalogs and client manifests for server-driven UI

  sdui catalog check --published <catalog.json> --next <catalog.json>
      Fails (exit 1) when <next> edits, reorders or removes anything <published> shipped.
      Published steps and schemas are frozen: new shape is a new step, appended.

  sdui catalog id --in <catalog.json>
      Prints the catalog's content address.

  sdui manifest gen --catalog <catalog.json> --app <id> --platform <ios|android|…>
                    --app-version <5.8.0> --out <client-manifest.json>
                    [--build <n>] [--pin <type>=<version>]… [--assets jpeg,png,webp]
      Writes the manifest for a binary that implements the catalog, at its newest versions
      unless pinned lower (--pin hero-banner=2). --pin <type>=0 leaves a type out.

  sdui manifest fingerprint --in <client-manifest.json>
      Prints the manifest's fingerprint: what a device sends at handshake.

  --help
`;

type Flags = Record<string, string[]>;

function parseArgs(argv: readonly string[]): {
  positional: string[];
  flags: Flags;
} {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    const values = (flags[key] ??= []);
    if (next !== undefined && !next.startsWith('--')) {
      values.push(next);
      i++;
    }
  }
  return { positional, flags };
}

/** Runs one command. Returns the process exit code: 0 success, 1 a failed check, 2 bad usage or input. */
export function runSdui(argv: readonly string[], io: CliIo): number {
  const { positional, flags } = parseArgs(argv);
  const command = positional.slice(0, 2).join(' ');
  if ('help' in flags || positional.length === 0 || positional[0] === 'help') {
    io.stdout(SDUI_USAGE);
    return 0;
  }

  const usage = (message: string): number => {
    io.stderr(`sdui ${command}: ${message}\n\n${SDUI_USAGE}`);
    return 2;
  };
  const one = (name: string): string | undefined =>
    flags[name]?.[flags[name].length - 1];
  const readJson = (path: string): unknown => {
    let text: string;
    try {
      text = io.readFile(path);
    } catch (cause) {
      throw new Error(
        `cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
  };

  try {
    switch (command) {
      case 'catalog check': {
        const published = one('published');
        const next = one('next');
        if (!published || !next)
          return usage('--published and --next are both required');
        const violations = checkCatalog(
          parseCatalog(readJson(published)),
          parseCatalog(readJson(next)),
        );
        if (violations.length === 0) {
          io.stdout(`sdui: ${next} only adds to ${published}\n`);
          return 0;
        }
        io.stderr(
          `sdui: ${next} changes what ${published} already shipped:\n${violations.map((violation) => `  - ${violation.message}\n`).join('')}`,
        );
        return 1;
      }

      case 'catalog id': {
        const input = one('in');
        if (!input) return usage('--in is required');
        io.stdout(`${catalogId(parseCatalog(readJson(input)))}\n`);
        return 0;
      }

      case 'manifest gen': {
        const required = [
          'catalog',
          'app',
          'platform',
          'app-version',
          'out',
        ] as const;
        const missing = required.filter((name) => !one(name));
        if (missing.length > 0)
          return usage(
            `missing ${missing.map((name) => `--${name}`).join(', ')}`,
          );
        const pin: Record<string, number> = {};
        for (const entry of flags['pin'] ?? []) {
          const match = /^([^=]+)=(\d+)$/.exec(entry);
          if (!match)
            return usage(`--pin takes <type>=<version>, got "${entry}"`);
          pin[match[1] as string] = Number(match[2]);
        }
        const build = one('build');
        if (build !== undefined && !/^\d+$/.test(build))
          return usage(`--build must be a whole number, got "${build}"`);
        const manifest = createClientManifest(
          parseCatalog(readJson(one('catalog') as string)),
          {
            app: one('app') as string,
            platform: one('platform') as string,
            version: one('app-version') as string,
            ...(build !== undefined ? { build: Number(build) } : {}),
            ...(Object.keys(pin).length > 0 ? { pin } : {}),
            ...(one('assets')
              ? { assets: (one('assets') as string).split(',').filter(Boolean) }
              : {}),
          },
        );
        const out = one('out') as string;
        io.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
        io.stdout(`sdui: ${manifestFingerprint(manifest)} → ${out}\n`);
        return 0;
      }

      case 'manifest fingerprint': {
        const input = one('in');
        if (!input) return usage('--in is required');
        io.stdout(
          `${manifestFingerprint(parseClientManifest(readJson(input)))}\n`,
        );
        return 0;
      }

      default:
        return usage(`unknown command`);
    }
  } catch (cause) {
    io.stderr(
      `sdui ${command}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 2;
  }
}
