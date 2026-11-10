import type { FragmentManifest } from '@braidlabs/gateway';
import { formatAreas, isSafeTrackList, MAX_WORKSPACE_APPS, parseAreas, type ShellFramework, type ShellManifest, type ShellRoute } from '@braidlabs/registry';

/**
 * The host code a shell describes, for each framework a shell can be.
 *
 * In this release a shell's `framework` decides which code you get, not which runtime renders it:
 * the gateway still serves whatever HTML its downstream app returns. The output is therefore the
 * complete, paste-ready integration — layout CSS, one slot per area, the document head, and for
 * Angular SSR the gateway in front of the server — so the definition and the running app cannot
 * disagree about where a fragment sits.
 *
 * **Every value is escaped for where it lands**: HTML text, an HTML attribute, a JS string, or an
 * Angular template inside a template literal. Shell fields are operator input published to a
 * registry, and generated code that a reviewer pastes is exactly where an injection would hide.
 */
export interface GeneratedFile {
  name: string;
  language: 'tsx' | 'typescript' | 'html' | 'css';
  code: string;
}

export const SHELL_TARGETS: { id: ShellFramework; label: string }[] = [
  { id: 'react', label: 'React' },
  { id: 'angular', label: 'Angular' },
  { id: 'angular-ssr', label: 'Angular SSR' },
  { id: 'vanilla', label: 'Plain JS' },
];

export function shellCode(shell: ShellManifest, fragments: readonly FragmentManifest[], target: ShellFramework): GeneratedFile[] {
  const byId = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const used = new Set<string>();
  const routes = shell.routes.map((route, index) => describeRoute(shell, route, uniqueStem(shell, route, index, used), byId));

  // one module for the page's workspace, when any route has one: the framework files import it
  const workspace = routes.some((route) => route.workspace) ? [workspaceModule(shell)] : [];

  switch (target) {
    case 'react':
      return [reactRoutes(shell, routes), ...workspace, layoutCss(routes), indexHtml(shell, '<div id="root"></div>')];
    case 'angular':
      return [...angularFiles(shell, routes), ...workspace, indexHtml(shell, '<app-root></app-root>')];
    case 'angular-ssr':
      return [...angularFiles(shell, routes), ...workspace, angularServer(shell), indexHtml(shell, '<app-root></app-root>')];
    case 'vanilla':
      return routes.map((route) => vanillaPage(shell, route));
  }
}

interface RouteView {
  path: string;
  /** A CSS class / component name stem, unique within the shell. */
  stem: string;
  componentName: string;
  areaRows: string[];
  columns?: string;
  rows?: string;
  gap?: string;
  slots: { area: string; fragment: string; src?: string }[];
  /** The area where apps are launched, with the ones open at first. */
  workspace?: { area: string; apps: { fragment: string; src?: string }[] };
  /** Areas the layout has but nothing fills. */
  empty: string[];
}

/** `/orders/*` → `<shell>-orders`, `/` → `<shell>-root`; a collision gets its route index appended. */
function uniqueStem(shell: ShellManifest, route: ShellRoute, index: number, used: Set<string>): string {
  const base = `${ident(shell.id)}-${ident(route.path) || 'root'}`;
  let stem = base;
  for (let n = index; used.has(stem); n += 1) stem = `${base}-${n}`;
  used.add(stem);
  return stem;
}

function describeRoute(shell: ShellManifest, route: ShellRoute, stem: string, byId: Map<string, FragmentManifest>): RouteView {
  const parsed = parseAreas(route.layout.areas);
  const names = parsed.areas.map((area) => area.name);
  // Only widgets (bound: false) take a src; a screen follows the host's own location.
  const placed = (fragment: string) => {
    const manifest = byId.get(fragment);
    const src = manifest?.bound === false ? manifest.src : undefined;
    return { fragment, ...(src ? { src } : {}) };
  };
  // one area, one occupant: the workspace wins, as it does in a served shell
  const workspaceArea = route.workspace && names.includes(route.workspace.area) ? route.workspace.area : undefined;
  const slots = Object.entries(route.slots ?? {})
    .filter(([area]) => names.includes(area) && area !== workspaceArea)
    .map(([area, fragment]) => ({ area, ...placed(fragment) }));
  const workspace =
    workspaceArea === undefined
      ? undefined
      : { area: workspaceArea, apps: (route.workspace?.apps ?? []).filter((app) => typeof app === 'string' && app !== '').slice(0, MAX_WORKSPACE_APPS).map(placed) };
  return {
    path: route.path,
    stem,
    componentName: `${pascal(stem)}Layout`,
    areaRows: parsed.errors.length > 0 ? [] : formatAreas(parsed.cells),
    ...trackProps(route.layout),
    slots,
    ...(workspace ? { workspace } : {}),
    empty: names.filter((name) => name !== workspaceArea && !slots.some((slot) => slot.area === name)),
  };
}

function trackProps(layout: ShellRoute['layout']): Pick<RouteView, 'columns' | 'rows' | 'gap'> {
  const safe = (value?: string) => (value !== undefined && isSafeTrackList(value) ? value.trim() : undefined);
  const columns = safe(layout.columns);
  const rows = safe(layout.rows);
  const gap = safe(layout.gap);
  return { ...(columns ? { columns } : {}), ...(rows ? { rows } : {}), ...(gap ? { gap } : {}) };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function cssRule(route: RouteView, selector: string): string[] {
  return [
    `${selector} {`,
    `  display: grid;`,
    ...(route.gap ? [`  gap: ${route.gap};`] : []),
    ...(route.columns ? [`  grid-template-columns: ${route.columns};`] : []),
    ...(route.rows ? [`  grid-template-rows: ${route.rows};`] : []),
    `  grid-template-areas:`,
    ...route.areaRows.map((row, index) => `    ${row}${index === route.areaRows.length - 1 ? ';' : ''}`),
    `}`,
    // apps the user opens sit side by side and share the area
    ...(route.workspace
      ? [
          `${selector} > [data-braid-workspace] {`,
          `  display: flex;`,
          `  min-width: 0;`,
          ...(route.gap ? [`  gap: ${route.gap};`] : []),
          `}`,
          `${selector} > [data-braid-workspace] > * {`,
          `  flex: 1 1 0;`,
          `  min-width: 0;`,
          `}`,
        ]
      : []),
  ];
}

/**
 * The page's workspace, as a module of its own: the framework files import it, and so can a
 * launcher, a "save layout" button or an FDC3 agent.
 */
function workspaceModule(shell: ShellManifest): GeneratedFile {
  return {
    name: 'workspace.ts',
    language: 'typescript',
    code: [
      ...header(shell, js),
      js(`The workspace area is the layout's [data-braid-workspace] element. Apps opened there, each`),
      js(`app's settings (window.braidDesktop) and named layouts are kept per browser; pass`),
      js(`{ store: serverStore() } to keep them per signed-in user on the gateway instead.`),
      `import { createWorkspace } from '@braidlabs/console/workspace';`,
      ``,
      `export const workspace = createWorkspace();`,
      ``,
      js(`The hook for Braid's realmGlobals option. With @braidlabs/fdc3, wrap the agent's hook:`),
      js(`workspace.realmGlobals(agent.realmGlobals).`),
      `export const realmGlobals = workspace.realmGlobals();`,
      ``,
      js(`workspace.open('fragment-id') launches an app; workspace.layouts.save('name') and`),
      js(`workspace.layouts.restore('name') keep and bring back what is open.`),
      ``,
      js(`Opens a route's starting apps once its layout has rendered the area, unless apps are already`),
      js(`open there. The workspace owns the area's children — it removes and adds them when a layout`),
      js(`is restored — so the framework renders the area empty and never its apps.`),
      `export function openStartingApps(apps: readonly { id: string; src?: string }[]): void {`,
      `  const area = workspace.container;`,
      `  if (!area || area.querySelector(':scope > fragment-slot')) return;`,
      `  for (const app of apps) workspace.open(app.id, app.src ? { src: app.src } : {});`,
      `}`,
    ].join('\n'),
  };
}

function layoutCss(routes: RouteView[]): GeneratedFile {
  return {
    name: 'shell-layout.css',
    language: 'css',
    code: routes.flatMap((route) => [`/* ${commentSafe(route.path)} */`, ...cssRule(route, `.${route.stem}`), '']).join('\n').trimEnd(),
  };
}

function headLines(shell: ShellManifest): string[] {
  const head = shell.head ?? {};
  const ownViewport = (head.meta ?? []).some((meta) => meta.name === 'viewport');
  return [
    `<meta charset="utf-8">`,
    ...(ownViewport ? [] : [`<meta name="viewport" content="width=device-width, initial-scale=1">`]),
    ...(head.title ? [`<title>${escapeHtml(head.title)}</title>`] : []),
    ...(head.meta ?? [])
      .filter((meta) => meta.name ?? meta.property)
      .map((meta) =>
        meta.property
          ? `<meta property="${escapeHtml(meta.property)}" content="${escapeHtml(meta.content)}">`
          : `<meta name="${escapeHtml(meta.name ?? '')}" content="${escapeHtml(meta.content)}">`,
      ),
    ...(head.stylesheets ?? []).map(
      (sheet) => `<link rel="stylesheet" href="${escapeHtml(sheet.href)}"${sheet.integrity ? ` integrity="${escapeHtml(sheet.integrity)}" crossorigin="anonymous"` : ''}>`,
    ),
    ...(head.scripts ?? []).map((script) => {
      const attrs = [
        ...(script.type === 'module' ? [`type="module"`] : []),
        `src="${escapeHtml(script.src)}"`,
        ...(script.integrity ? [`integrity="${escapeHtml(script.integrity)}"`, `crossorigin="anonymous"`] : []),
        ...(script.async ? ['async'] : []),
        ...(script.defer ? ['defer'] : []),
      ];
      return `<script ${attrs.join(' ')}></script>`;
    }),
  ];
}

function indexHtml(shell: ShellManifest, body: string): GeneratedFile {
  return {
    name: 'index.html',
    language: 'html',
    code: [
      `<!doctype html>`,
      `<html lang="en">`,
      `<head>`,
      ...headLines(shell).map((line) => `  ${line}`),
      `</head>`,
      `<body>`,
      `  ${body}`,
      `</body>`,
      `</html>`,
    ].join('\n'),
  };
}

function header(shell: ShellManifest, comment: (text: string) => string): string[] {
  return [comment(`Generated by Braid Console from shell ${jsString(shell.id)}. Regenerate rather than edit by hand.`)];
}

const js = (text: string) => `// ${commentSafe(text)}`;

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

function reactRoutes(shell: ShellManifest, routes: RouteView[]): GeneratedFile {
  const components = routes.flatMap((route) => [
    js(`Route ${route.path}`),
    `export function ${route.componentName}() {`,
    ...(route.workspace ? [`  useEffect(() => openStartingApps(${startingApps(route)}), []);`] : []),
    `  return (`,
    // Braces, not quotes: a JSX string attribute has no escapes, so a value is only safe as a JS
    // expression.
    `    <div className={${jsString(route.stem)}}>`,
    ...route.slots.map(
      (slot) =>
        `      <BraidFragment name={${jsString(slot.fragment)}}${slot.src ? ` src={${jsString(slot.src)}}` : ''} style={{ gridArea: ${jsString(slot.area)} }} />`,
    ),
    ...(route.workspace
      ? [
          `      {/* empty on purpose: the workspace adds and removes the apps here */}`,
          `      <div data-braid-workspace="" style={{ gridArea: ${jsString(route.workspace.area)} }} />`,
        ]
      : []),
    ...(route.empty.length ? [`      {/* empty areas: ${commentSafe(route.empty.join(', '))} */}`] : []),
    `    </div>`,
    `  );`,
    `}`,
    ``,
  ]);

  return {
    name: `${ident(shell.id)}.tsx`,
    language: 'tsx',
    code: [
      ...header(shell, js),
      ...(routes.some((route) => route.workspace)
        ? [
            js(`Call initBraidReact({ realmGlobals }) once before rendering, with realmGlobals from`),
            js(`./workspace, and route each path below to its layout.`),
          ]
        : [js(`Call initBraidReact() once before rendering, and route each path below to its layout.`)]),
      ...(routes.some((route) => route.workspace) ? [`import { useEffect } from 'react';`] : []),
      `import { BraidFragment } from '@braidlabs/react';`,
      ...(routes.some((route) => route.workspace) ? [`import { openStartingApps } from './workspace';`] : []),
      `import './shell-layout.css';`,
      ``,
      ...components,
      `export const routes = [`,
      ...routes.map((route) => `  { path: ${jsString(route.path)}, element: <${route.componentName} /> },`),
      `];`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Angular
// ---------------------------------------------------------------------------

function angularFiles(shell: ShellManifest, routes: RouteView[]): GeneratedFile[] {
  const components = routes.flatMap((route) => {
    const template = [
      `<div class="${escapeAngular(route.stem)}">`,
      ...route.slots.map(
        (slot) =>
          `  <braid-fragment name="${escapeAngular(slot.fragment)}"${slot.src ? ` src="${escapeAngular(slot.src)}"` : ''} style="grid-area: ${escapeAngular(slot.area)}" />`,
      ),
      ...(route.workspace
        ? [
            `  <!-- empty on purpose: the workspace adds and removes the apps here -->`,
            `  <div data-braid-workspace style="grid-area: ${escapeAngular(route.workspace.area)}"></div>`,
          ]
        : []),
      `</div>`,
    ];
    return [
      js(`Route ${route.path}`),
      `@Component({`,
      `  selector: ${jsString(`app-${route.stem}`)},`,
      `  imports: [BraidFragment],`,
      `  template: \``,
      ...template.map((line) => `    ${templateLiteral(line)}`),
      `  \`,`,
      `  styles: \``,
      ...cssRule(route, `.${route.stem}`).map((line) => `    ${templateLiteral(line)}`),
      `  \`,`,
      `})`,
      ...(route.workspace
        ? [
            `export class ${route.componentName} {`,
            `  constructor() {`,
            `    afterNextRender(() => openStartingApps(${startingApps(route)}));`,
            `  }`,
            `}`,
          ]
        : [`export class ${route.componentName} {}`]),
      ``,
    ];
  });

  return [
    {
      name: `${ident(shell.id)}.routes.ts`,
      language: 'typescript',
      code: [
        ...header(shell, js),
        ...(routes.some((route) => route.workspace)
          ? [js(`Add provideBraid({ realmGlobals }) to the application's providers once, with realmGlobals`), js(`from ./workspace.`)]
          : [js(`Add provideBraid() to the application's providers once.`)]),
        `import { ${routes.some((route) => route.workspace) ? 'afterNextRender, ' : ''}Component } from '@angular/core';`,
        `import type { Routes } from '@angular/router';`,
        `import { BraidFragment } from '@braidlabs/angular';`,
        ...(routes.some((route) => route.workspace) ? [`import { openStartingApps } from './workspace';`] : []),
        ``,
        ...components,
        `export const routes: Routes = [`,
        ...routes.map((route) => `  { path: ${jsString(angularPath(route.path))}, component: ${route.componentName} },`),
        `];`,
      ].join('\n'),
    },
  ];
}

/** A route's starting apps as a JS array literal, for `openStartingApps`. */
function startingApps(route: RouteView): string {
  const apps = (route.workspace?.apps ?? []).map((app) => `{ id: ${jsString(app.fragment)}${app.src ? `, src: ${jsString(app.src)}` : ''} }`);
  return `[${apps.join(', ')}]`;
}

/** URLPattern pathname → Angular route path: no leading slash, and a trailing `*` becomes `**`. */
export function angularPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/(^|\/)\*$/, '$1**');
}

function angularServer(shell: ShellManifest): GeneratedFile {
  return {
    name: 'server.ts',
    language: 'typescript',
    code: [
      ...header(shell, js),
      js(`The gateway sits in front of the Angular SSR handler: it asks Angular for the shell`),
      js(`document, then server-side renders each fragment into its <fragment-slot>.`),
      `import { createGateway } from '@braidlabs/gateway';`,
      `import { toNodeMiddleware } from '@braidlabs/gateway/node';`,
      `import { snapshotRegistry } from '@braidlabs/registry';`,
      `import { fileSnapshotStore } from '@braidlabs/registry/node';`,
      ``,
      `const gateway = createGateway({`,
      `  ${js('Production unless NODE_ENV says development, which skips every access rule.')}`,
      `  mode: process.env['NODE_ENV'] === 'development' ? 'development' : 'production',`,
      `  registry: snapshotRegistry({`,
      `    store: fileSnapshotStore({ directory: process.env['BRAID_REGISTRY_DIR'] ?? '.braid/registry' }),`,
      `    pinned: process.env['BRAID_REGISTRY_SNAPSHOT'],`,
      `  }),`,
      `});`,
      ``,
      js(`Before the Angular request handler, so it can wrap the documents Angular renders:`),
      `app.use(toNodeMiddleware(gateway));`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Plain JS
// ---------------------------------------------------------------------------

function vanillaPage(shell: ShellManifest, route: RouteView): GeneratedFile {
  return {
    name: `${route.stem}.html`,
    language: 'html',
    code: [
      `<!doctype html>`,
      `<!-- ${commentSafe(`Generated by Braid Console from shell "${shell.id}", route ${route.path}.`)} -->`,
      `<html lang="en">`,
      `<head>`,
      ...headLines(shell).map((line) => `  ${line}`),
      `  <style>`,
      ...cssRule(route, `.${route.stem}`).map((line) => `    ${line}`),
      `  </style>`,
      `  <script type="module">`,
      `    // A bare specifier: serve this page through your bundler, or map it with an import map.`,
      `    import { initBraid } from '@braidlabs/core';`,
      ...(route.workspace
        ? [
            `    import { createWorkspace } from '@braidlabs/console/workspace';`,
            `    // The workspace area is the [data-braid-workspace] element below. window.workspace is for`,
            `    // the page's own launcher and layout buttons: workspace.open(id), workspace.layouts.save(name).`,
            `    const workspace = (window.workspace = createWorkspace());`,
            `    initBraid({ realmGlobals: workspace.realmGlobals() });`,
          ]
        : [`    initBraid();`]),
      `  </script>`,
      `</head>`,
      `<body>`,
      `  <div class="${escapeHtml(route.stem)}">`,
      ...route.slots.map(
        (slot) =>
          `    <fragment-slot name="${escapeHtml(slot.fragment)}"${slot.src ? ` src="${escapeHtml(slot.src)}"` : ''} style="grid-area: ${escapeHtml(slot.area)}"></fragment-slot>`,
      ),
      ...(route.workspace
        ? [
            `    <div data-braid-workspace style="grid-area: ${escapeHtml(route.workspace.area)}">`,
            ...route.workspace.apps.map(
              (app) => `      <fragment-slot name="${escapeHtml(app.fragment)}"${app.src ? ` src="${escapeHtml(app.src)}"` : ''}></fragment-slot>`,
            ),
            `    </div>`,
          ]
        : []),
      `  </div>`,
      `</body>`,
      `</html>`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A JS string literal. JSON.stringify leaves U+2028 and U+2029 raw: legal in a string since ES2019,
 * but invisible to a reviewer and a line break to older tooling.
 */
function jsString(value: string): string {
  return JSON.stringify(String(value)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** HTML escaping plus braces, so a value cannot become an Angular `{{ }}` interpolation. */
function escapeAngular(value: string): string {
  return escapeHtml(value).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

/** Text placed inside a JS template literal: no backtick, no `${`, no stray escape. */
function templateLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Text placed inside a comment of any of the three languages, unable to close it early: `*\/`
 * for CSS and block comments, `-->`, `--!>` and `<!--` for HTML, and every line terminator JS
 * recognizes — U+2028 and U+2029 end a `//` comment too, and most editors draw them invisibly.
 */
function commentSafe(value: string): string {
  return String(value)
    .replace(/\*\//g, '* /')
    .replace(/--!?>/g, '-- >')
    .replace(/<!--/g, '< !--')
    .replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** A CSS-identifier- and filename-safe stem. */
function ident(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 'x$1')
    .toLowerCase();
}

function pascal(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
