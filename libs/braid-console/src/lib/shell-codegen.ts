import type { FragmentManifest } from '@braidlabs/gateway';
import { formatAreas, parseAreas, type ShellFramework, type ShellManifest, type ShellRoute } from '@braidlabs/registry';

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

  switch (target) {
    case 'react':
      return [reactRoutes(shell, routes), layoutCss(routes), indexHtml(shell, '<div id="root"></div>')];
    case 'angular':
      return [...angularFiles(shell, routes), indexHtml(shell, '<app-root></app-root>')];
    case 'angular-ssr':
      return [...angularFiles(shell, routes), angularServer(shell), indexHtml(shell, '<app-root></app-root>')];
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
  /** Areas the layout has but nothing fills. */
  empty: string[];
}

const CSS_TRACKS = /^[a-zA-Z0-9\s().,%+*/-]+$/;

/** `/orders/*` → `<shell>-orders`, `/` → `<shell>-root`; a collision gets its route index appended. */
function uniqueStem(shell: ShellManifest, route: ShellRoute, index: number, used: Set<string>): string {
  const base = `${ident(shell.id)}-${ident(route.path) || 'root'}`;
  const stem = used.has(base) ? `${base}-${index}` : base;
  used.add(stem);
  return stem;
}

function describeRoute(shell: ShellManifest, route: ShellRoute, stem: string, byId: Map<string, FragmentManifest>): RouteView {
  const parsed = parseAreas(route.layout.areas);
  const names = parsed.areas.map((area) => area.name);
  const slots = Object.entries(route.slots ?? {})
    .filter(([area]) => names.includes(area))
    .map(([area, fragment]) => {
      const manifest = byId.get(fragment);
      // Only widgets (bound: false) take a src; a screen follows the host's own location.
      const src = manifest?.bound === false ? manifest.src : undefined;
      return { area, fragment, ...(src ? { src } : {}) };
    });
  return {
    path: route.path,
    stem,
    componentName: `${pascal(stem)}Layout`,
    areaRows: parsed.errors.length > 0 ? [] : formatAreas(parsed.cells),
    ...trackProps(route.layout),
    slots,
    empty: names.filter((name) => !slots.some((slot) => slot.area === name)),
  };
}

function trackProps(layout: ShellRoute['layout']): Pick<RouteView, 'columns' | 'rows' | 'gap'> {
  const safe = (value?: string) => (value !== undefined && CSS_TRACKS.test(value) ? value.trim() : undefined);
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
  ];
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
  return [comment(`Generated by Braid Console from shell ${JSON.stringify(shell.id)}. Regenerate rather than edit by hand.`)];
}

const js = (text: string) => `// ${commentSafe(text)}`;

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

function reactRoutes(shell: ShellManifest, routes: RouteView[]): GeneratedFile {
  const components = routes.flatMap((route) => [
    js(`Route ${route.path}`),
    `export function ${route.componentName}() {`,
    `  return (`,
    // Braces, not quotes: a JSX string attribute has no escapes, so a value is only safe as a JS
    // expression.
    `    <div className={${JSON.stringify(route.stem)}}>`,
    ...route.slots.map(
      (slot) =>
        `      <BraidFragment name={${JSON.stringify(slot.fragment)}}${slot.src ? ` src={${JSON.stringify(slot.src)}}` : ''} style={{ gridArea: ${JSON.stringify(slot.area)} }} />`,
    ),
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
      js(`Call initBraidReact() once before rendering, and route each path below to its layout.`),
      `import { BraidFragment } from '@braidlabs/react';`,
      `import './shell-layout.css';`,
      ``,
      ...components,
      `export const routes = [`,
      ...routes.map((route) => `  { path: ${JSON.stringify(route.path)}, element: <${route.componentName} /> },`),
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
      `<div class="${escapeHtml(route.stem)}">`,
      ...route.slots.map(
        (slot) =>
          `  <braid-fragment name="${escapeHtml(slot.fragment)}"${slot.src ? ` src="${escapeHtml(slot.src)}"` : ''} style="grid-area: ${escapeHtml(slot.area)}" />`,
      ),
      `</div>`,
    ];
    return [
      js(`Route ${route.path}`),
      `@Component({`,
      `  selector: ${JSON.stringify(`app-${route.stem}`)},`,
      `  imports: [BraidFragment],`,
      `  template: \``,
      ...template.map((line) => `    ${templateLiteral(line)}`),
      `  \`,`,
      `  styles: \``,
      ...cssRule(route, `.${route.stem}`).map((line) => `    ${templateLiteral(line)}`),
      `  \`,`,
      `})`,
      `export class ${route.componentName} {}`,
      ``,
    ];
  });

  return [
    {
      name: `${ident(shell.id)}.routes.ts`,
      language: 'typescript',
      code: [
        ...header(shell, js),
        js(`Add provideBraid() to the application's providers once.`),
        `import { Component } from '@angular/core';`,
        `import type { Routes } from '@angular/router';`,
        `import { BraidFragment } from '@braidlabs/angular';`,
        ``,
        ...components,
        `export const routes: Routes = [`,
        ...routes.map((route) => `  { path: ${JSON.stringify(angularPath(route.path))}, component: ${route.componentName} },`),
        `];`,
      ].join('\n'),
    },
  ];
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
      `  mode: 'production',`,
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
      `    import { initBraid } from '@braidlabs/core';`,
      `    initBraid();`,
      `  </script>`,
      `</head>`,
      `<body>`,
      `  <div class="${escapeHtml(route.stem)}">`,
      ...route.slots.map(
        (slot) =>
          `    <fragment-slot name="${escapeHtml(slot.fragment)}"${slot.src ? ` src="${escapeHtml(slot.src)}"` : ''} style="grid-area: ${escapeHtml(slot.area)}"></fragment-slot>`,
      ),
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
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Text placed inside a JS template literal: no backtick, no `${`, no stray escape. */
function templateLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** Text placed inside a comment of any of the three languages, unable to close it early. */
function commentSafe(value: string): string {
  return value.replace(/\*\//g, '* /').replace(/-->/g, '-- >').replace(/[\r\n]+/g, ' ');
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
