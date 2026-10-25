import type { FragmentManifest } from '@braidlabs/gateway';
import { isSafeAssetUrl, isSafeTrackList, parseAreas, type ShellManifest, type ShellRoute } from './shell.js';
import type { RegistrySnapshot } from './snapshot.js';
import { claimsWholeSite, withinPrefixes } from './route-scope.js';

/**
 * Shells served from their definition: the gateway answers a page by rendering the shell the
 * registry holds for it, so publishing a shell in the console puts it live with no app and no
 * rebuild.
 *
 * ```ts
 * const registry = snapshotRegistry({ store });
 * createGateway({
 *   registry,
 *   registryRefreshMs: 5_000,
 *   documents: shellDocuments({ registry, runtimeSrc: '/assets/braid-runtime.js' }),
 * });
 * ```
 *
 * Only `vanilla` shells are served this way. A React or Angular shell is an application — its
 * routes, state and build belong to that framework — and the console generates its code instead.
 */

export interface RenderShellOptions {
  /**
   * A module the page loads to start Braid's client runtime — one that imports `initBraid` from
   * `@braidlabs/core` and calls it, built and served by you (or your CDN). Must be root-relative or
   * `https:`. Required: a served shell has no bundler to resolve a bare `@braidlabs/core` import.
   */
  runtimeSrc: string;
  /**
   * Origins a served shell may load scripts and stylesheets from, besides its own — e.g.
   * `['https://cdn.example.com']`. Default: none, so only root-relative assets load.
   *
   * A shell is published by whoever may publish it, and a script it names runs on this origin with
   * every pierced fragment, every cookie and the registry API next to it. Which third parties may do
   * that is the operator's decision, made here, not each publisher's. A cross-origin entry should
   * also carry `integrity`.
   */
  assetOrigins?: readonly string[];
}

/**
 * Renders one route of a shell as a complete HTML document: its head, its layout as a CSS grid,
 * and a `<fragment-slot>` for each slotted area, ready for the gateway to pierce.
 *
 * Everything from the snapshot is treated as untrusted at render time, not only at publish time —
 * a snapshot stored before a validation rule existed is still served:
 *
 * - text is escaped for the place it lands;
 * - script and stylesheet URLs must be `https:` or root-relative, or the tag is left out;
 * - layout values must be CSS track lists, or the declaration is left out;
 * - the grid is an inline `<style>` rule, so no `style=` attribute (and no `style-src-attr`) is
 *   needed.
 */
export function renderShellDocument(
  shell: ShellManifest,
  route: ShellRoute,
  manifests: readonly FragmentManifest[],
  options: RenderShellOptions,
): string {
  if (!isSafeAssetUrl(options.runtimeSrc)) {
    throw new Error(`braid-registry: runtimeSrc "${options.runtimeSrc}" must be an https: URL or a root-relative path`);
  }

  const head = shell.head ?? {};
  const allowedOrigins = new Set((options.assetOrigins ?? []).map((origin) => new URL(origin).origin));
  const assetAllowed = (url: string | undefined): url is string =>
    isSafeAssetUrl(url ?? '') && (url!.startsWith('/') || allowedOrigins.has(new URL(url!).origin));
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const parsed = parseAreas(route.layout.areas);
  const grid = parsed.errors.length === 0;

  const gridDeclarations = [
    'display:grid',
    'min-height:100vh',
    ...(grid ? [`grid-template-areas:${parsed.cells.map((row) => `"${row.join(' ')}"`).join(' ')}`] : []),
    ...trackDeclaration('grid-template-columns', route.layout.columns),
    ...trackDeclaration('grid-template-rows', route.layout.rows),
    ...trackDeclaration('gap', route.layout.gap),
  ];
  const areaRules = grid ? parsed.areas.map((area) => `[data-braid-area="${area.name}"]{grid-area:${area.name}}`) : [];

  const slots = Object.entries(route.slots ?? {})
    // area names were checked by parseAreas; an unknown area has nowhere to go
    .filter(([area]) => grid && parsed.areas.some((known) => known.name === area))
    .map(([area, fragmentId]) => {
      const manifest = byId.get(fragmentId);
      // a path on the fragment's own endpoint; anything else is not a src the client should resolve
      const src =
        manifest?.bound === false && typeof manifest.src === 'string' && manifest.src.startsWith('/') && isSafeAssetUrl(manifest.src)
          ? ` src="${escapeHtml(manifest.src)}"`
          : '';
      return `<fragment-slot name="${escapeHtml(fragmentId)}" data-braid-area="${escapeHtml(area)}"${src}></fragment-slot>`;
    });

  const ownViewport = (head.meta ?? []).some((meta) => meta.name === 'viewport');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    ...(ownViewport ? [] : ['<meta name="viewport" content="width=device-width, initial-scale=1">']),
    ...(head.title ? [`<title>${escapeHtml(head.title)}</title>`] : []),
    ...(head.meta ?? [])
      .filter((meta) => typeof meta?.content === 'string' && (meta.name ?? meta.property))
      .map((meta) =>
        meta.property
          ? `<meta property="${escapeHtml(meta.property)}" content="${escapeHtml(meta.content)}">`
          : `<meta name="${escapeHtml(meta.name ?? '')}" content="${escapeHtml(meta.content)}">`,
      ),
    ...(head.stylesheets ?? [])
      .filter((sheet) => assetAllowed(sheet?.href))
      .map(
        (sheet) =>
          `<link rel="stylesheet" href="${escapeHtml(sheet.href)}"${sheet.integrity ? ` integrity="${escapeHtml(sheet.integrity)}" crossorigin="anonymous"` : ''}>`,
      ),
    `<style>.braid-shell{${gridDeclarations.join(';')}}${areaRules.join('')}</style>`,
    ...(head.scripts ?? [])
      .filter((script) => assetAllowed(script?.src))
      .map((script) => {
        const attributes = [
          ...(script.type === 'module' ? ['type="module"'] : []),
          `src="${escapeHtml(script.src)}"`,
          ...(script.integrity ? [`integrity="${escapeHtml(script.integrity)}"`, 'crossorigin="anonymous"'] : []),
          ...(script.async ? ['async'] : []),
          ...(script.defer ? ['defer'] : []),
        ];
        return `<script ${attributes.join(' ')}></script>`;
      }),
    `<script type="module" src="${escapeHtml(options.runtimeSrc)}"></script>`,
    '</head>',
    '<body>',
    `<div class="braid-shell">${slots.join('')}</div>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export interface ShellDocumentsOptions extends RenderShellOptions {
  /**
   * Where shells come from: the same `snapshotRegistry()` the gateway serves fragments from, so
   * shells and fragments are always one snapshot — and a hot re-pin moves both together.
   */
  registry: {
    snapshot(): Promise<RegistrySnapshot>;
    snapshotFor?(manifests: readonly FragmentManifest[]): RegistrySnapshot | undefined;
  };
  /**
   * Path prefixes shells may be served at — e.g. `['/billing', '/promo']`. Routes outside them are
   * not served from their definition.
   *
   * A served shell answers ahead of the app behind the gateway, so a route is a claim on part of
   * the site. Without `paths`, only claims on the whole site (`/`, `/*`, a leading parameter) are
   * refused; list `'/'` to allow those too.
   */
  paths?: readonly string[];
}

/**
 * A gateway `documents` hook that serves `vanilla` shells from the registry.
 *
 * A request is matched against every vanilla shell's routes — shells in id order, routes in the
 * order declared, first match wins, with the same trailing-slash tolerance as `pierce` — and
 * answered with that route rendered by {@link renderShellDocument}. Anything no vanilla shell
 * claims returns null, and the gateway falls through to the app behind it.
 */
export function shellDocuments(
  options: ShellDocumentsOptions,
): (request: Request, context?: { manifests: readonly FragmentManifest[] }) => Promise<Response | null> {
  // Fail at startup, not on the first page view.
  if (!isSafeAssetUrl(options.runtimeSrc)) {
    throw new Error(`braid-registry: runtimeSrc "${options.runtimeSrc}" must be an https: URL or a root-relative path`);
  }

  /** Compiled routes for the snapshot last seen, recompiled only when a re-pin changes it. */
  let compiled: { snapshotId: string; routes: CompiledShellRoute[] } | undefined;
  const prefixes = options.paths?.map((path) => path.replace(/\/+$/, '') || '/');
  const warned = new Set<string>();

  const servable = (shell: ShellManifest, path: string): boolean => {
    const allowed = prefixes ? withinPrefixes(path, prefixes) : !claimsWholeSite(path);
    if (!allowed && !warned.has(`${shell.id} ${path}`)) {
      warned.add(`${shell.id} ${path}`);
      console.warn(
        `braid-registry: not serving shell "${shell.id}" at ${path} — ` +
          (prefixes ? `outside the paths shellDocuments allows (${prefixes.join(', ')})` : `it claims the whole site; allow it with paths: ['/']`),
      );
    }
    return allowed;
  };

  return async (request, context?: { manifests: readonly FragmentManifest[] }) => {
    // The snapshot the gateway is actually serving fragments from, when it says which; a load the
    // gateway refused never reaches the page as a shell ahead of its fragments.
    const snapshot =
      (context && options.registry.snapshotFor?.(context.manifests)) ?? (await options.registry.snapshot());
    if (compiled?.snapshotId !== snapshot.id) {
      compiled = { snapshotId: snapshot.id, routes: compileShellRoutes(snapshot.shells ?? []).filter((route) => servable(route.shell, route.route.path)) };
    }

    const { pathname } = new URL(request.url);
    const match = compiled.routes.find((candidate) => candidate.matches(pathname));
    if (!match) return null;

    return new Response(renderShellDocument(match.shell, match.route, snapshot.manifests, options), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  };
}

interface CompiledShellRoute {
  shell: ShellManifest;
  route: ShellRoute;
  matches(pathname: string): boolean;
}

function compileShellRoutes(shells: readonly ShellManifest[]): CompiledShellRoute[] {
  return [...shells]
    .filter((shell) => shell.framework === 'vanilla')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((shell) =>
      shell.routes.flatMap((route) => {
        let pattern: URLPattern;
        try {
          pattern = new URLPattern({ pathname: route.path });
        } catch {
          return []; // validation reports it; serving skips it
        }
        return [
          {
            shell,
            route,
            // `/billing/*` also answers `/billing`, as pierce patterns do
            // the same tolerance as the gateway's pierce matcher: never toggled into an empty path
            matches: (pathname: string) => {
              if (pattern.test({ pathname })) return true;
              const toggled = pathname.endsWith('/') ? pathname.slice(0, -1) : `${pathname}/`;
              return toggled !== '' && pattern.test({ pathname: toggled });
            },
          },
        ];
      }),
    );
}

function trackDeclaration(property: string, value: string | undefined): string[] {
  return value !== undefined && isSafeTrackList(value) ? [`${property}:${value}`] : [];
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
