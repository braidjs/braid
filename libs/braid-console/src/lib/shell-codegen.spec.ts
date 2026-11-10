import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { FragmentManifest } from '@braidlabs/gateway';
import type { ShellFramework, ShellManifest } from '@braidlabs/registry';
import { angularPath, shellCode, SHELL_TARGETS } from './shell-codegen.js';

const fragments: FragmentManifest[] = [
  { id: 'notifications', endpoint: 'https://n.internal', bound: false, src: '/inbox' },
  { id: 'billing', endpoint: 'https://b.internal', pierce: ['/orders/*'] },
  { id: 'reviews', endpoint: 'https://r.internal', pierce: ['/orders/*'] },
];

const shell: ShellManifest = {
  id: 'partner-portal',
  framework: 'react',
  routes: [
    {
      path: '/orders/*',
      layout: { areas: 'header header\nnav main\nfooter footer', columns: '220px 1fr', rows: '56px 1fr 44px', gap: '12px' },
      slots: { header: 'notifications', main: 'billing', nav: 'reviews' },
    },
    { path: '/', layout: { areas: 'main' }, slots: { main: 'billing' } },
  ],
  head: {
    title: 'Partner portal',
    meta: [{ name: 'description', content: '"><script>x</script>' }],
    scripts: [{ src: 'https://cdn.example.com/a.js', type: 'module', defer: true }],
    stylesheets: [{ href: '/assets/theme.css' }],
  },
};

const all = (target: ShellFramework, input = shell) =>
  shellCode(input, fragments, target)
    .map((file) => file.code)
    .join('\n');

describe('shellCode', () => {
  it.each(SHELL_TARGETS.map((t) => t.id))('%s: places every slotted fragment and the exact grid rows', (target) => {
    const code = all(target);

    for (const id of ['notifications', 'billing', 'reviews']) expect(code).toContain(id);
    expect(code).toContain('"header header"');
    expect(code).toContain('"nav    main"');
    expect(code).toContain('"footer footer"');
    expect(code).toContain('grid-template-columns: 220px 1fr;');
    expect(code).toMatch(/grid-area: main|gridArea: "main"/);
  });

  it.each(SHELL_TARGETS.map((t) => t.id))('%s: escapes hostile head content', (target) => {
    const code = all(target);

    expect(code).not.toContain('<script>x</script>');
    expect(code).toContain('content="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });

  it.each(SHELL_TARGETS.map((t) => t.id))('%s: gives a widget its src, and a screen none', (target) => {
    const code = all(target);

    expect(code).toMatch(/notifications.{0,4} src=.{0,2}\/inbox/);
    expect(code).not.toMatch(/billing.{0,4} src=/);
  });

  it('emits a server with the gateway in front for Angular SSR only', () => {
    expect(shellCode(shell, fragments, 'angular-ssr').map((f) => f.name)).toContain('server.ts');
    expect(shellCode(shell, fragments, 'angular').map((f) => f.name)).not.toContain('server.ts');
    expect(all('angular-ssr')).toContain('app.use(toNodeMiddleware(gateway));');
  });

  it('emits a production gateway unless NODE_ENV says development', () => {
    // Development skips every access rule, so it is never what a deployment gets by default.
    expect(all('angular-ssr')).toContain(
      "mode: process.env['NODE_ENV'] === 'development' ? 'development' : 'production',",
    );
    const server = shellCode(shell, fragments, 'angular-ssr').find((file) => file.name === 'server.ts')!;
    const output = ts.transpileModule(server.code, { reportDiagnostics: true, fileName: 'server.ts' });
    expect(output.diagnostics).toEqual([]);
  });

  it('emits one page per route for plain JS', () => {
    expect(shellCode(shell, fragments, 'vanilla').map((f) => f.name)).toEqual(['partner-portal-orders.html', 'partner-portal-root.html']);
  });

  it('drops track lists that could escape their declaration', () => {
    const hostile: ShellManifest = { ...shell, routes: [{ path: '/', layout: { areas: 'main', columns: '1fr; } body { display:none' } }] };

    expect(all('vanilla', hostile)).not.toContain('display:none');
  });

  it('produces React and Angular code that parses, even for hostile ids', () => {
    const hostile: ShellManifest = {
      ...shell,
      routes: [{ path: '/x', layout: { areas: 'main' }, slots: { main: 'a"b`${c}' } }],
    };
    const ids: FragmentManifest[] = [...fragments, { id: 'a"b`${c}', endpoint: 'https://x.internal' }];

    for (const target of ['react', 'angular'] as const) {
      for (const input of [shell, hostile]) {
        for (const file of shellCode(input, ids, target).filter((f) => f.language === 'tsx' || f.language === 'typescript')) {
          const output = ts.transpileModule(file.code, {
            reportDiagnostics: true,
            fileName: file.name,
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
          });
          expect(output.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? []).toEqual([]);
        }
      }
    }

    expect(all('react', hostile)).toContain('name={"a\\"b`${c}"}');
    // Braces are entities in an Angular template, so `{{ }}` can never become an interpolation.
    expect(all('angular', hostile)).toContain('name="a&quot;b\\`$&#123;c&#125;"');
  });

  it('notes empty areas instead of inventing content for them', () => {
    const sparse: ShellManifest = { ...shell, routes: [{ path: '/', layout: { areas: 'header\nmain' }, slots: { main: 'billing' } }] };

    expect(all('react', sparse)).toContain('empty areas: header');
  });
});

describe('angularPath', () => {
  it.each([
    ['/', ''],
    ['/orders/*', 'orders/**'],
    ['/orders/:id', 'orders/:id'],
    ['/*', '**'],
  ])('%s → %s', (path, expected) => {
    expect(angularPath(path)).toBe(expected);
  });
});

describe('comment and template breakouts', () => {
  const sneaky = (path: string): ShellManifest => ({ ...shell, routes: [{ path, layout: { areas: 'main' }, slots: { main: 'billing' } }] });

  it.each(['/a--!><img src=x onerror=alert(1)>', '/a--><img src=x>', '/a<!--x'])('keeps %s inside the HTML comment', (path) => {
    const html = all('vanilla', sneaky(path));
    const header = html.split('\n')[1] ?? '';

    expect(header.startsWith('<!-- ')).toBe(true);
    expect(header.indexOf('-->')).toBe(header.length - 3);
    expect(header).not.toMatch(/--!?>.*--!?>/);
  });

  it('keeps a U+2028 in a route path from ending a // comment', () => {
    const code = all('react', sneaky('/a\u2028alert(1)//'));

    expect(code).not.toContain('\u2028');
    expect(code).toContain('// Route /a alert(1)//');
  });

  it('turns braces into entities in Angular templates', () => {
    const code = all('angular', { ...shell, routes: [{ path: '/', layout: { areas: 'main' }, slots: { main: '{{constructor}}' } }] });

    expect(code).not.toContain('{{constructor}}');
    expect(code).toContain('name="&#123;&#123;constructor&#125;&#125;"');
  });

  it('gives every route a distinct stem even when suffixes collide', () => {
    const colliding: ShellManifest = {
      ...shell,
      routes: ['/a-2', '/a', '/a/*', '/a'].map((path) => ({ path, layout: { areas: 'main' } })),
    };
    const names = shellCode(colliding, fragments, 'vanilla').map((file) => file.name);

    expect(new Set(names).size).toBe(names.length);
  });

  describe('with a workspace area', () => {
    const desk: ShellManifest = {
      ...shell,
      routes: [
        {
          path: '/desk',
          layout: { areas: 'nav desk', columns: '220px 1fr', gap: '8px' },
          slots: { nav: 'reviews', desk: 'billing' },
          workspace: { area: 'desk', apps: ['billing', 'notifications', '"}<x>{{y}}`${z}'] },
        },
      ],
    };

    it.each(SHELL_TARGETS.map((t) => t.id))('%s: renders the area as [data-braid-workspace] with its starting apps, and wires the workspace', (target) => {
      const code = all(target, desk);

      expect(code).toMatch(/data-braid-workspace(="")? style=(\{\{ gridArea: "desk" \}\}|"grid-area: desk")/);
      // starting apps carry no grid area: they share the workspace's
      expect(code).toMatch(/<(BraidFragment|braid-fragment|fragment-slot) name=\{?"billing"\}?( \/)?>/);
      expect(code).toMatch(/notifications.{0,4} src=.{0,2}\/inbox/);
      // the workspace took the area a slot also named
      expect(code).not.toMatch(/billing.{0,6}(grid-area: desk|gridArea: "desk")/);
      expect(code).toContain("from '@braidlabs/console/workspace'");
      expect(code).toContain('createWorkspace()');
      expect(code).toMatch(/realmGlobals/);
      expect(code).toContain('[data-braid-workspace] {');
      // a hostile app id stays inside its attribute or string
      if (target === 'react') {
        // a JS expression, which is the only safe place for it in JSX
        expect(code).toContain(`name={${JSON.stringify('"}<x>{{y}}`${z}')}}`);
      } else {
        expect(code).not.toContain('<x>');
        expect(code).toContain('&lt;x&gt;');
      }
    });

    it('produces code that parses, with a hostile app id', () => {
      for (const target of ['react', 'angular', 'angular-ssr'] as const) {
        for (const file of shellCode(desk, fragments, target).filter((f) => f.language === 'tsx' || f.language === 'typescript')) {
          const output = ts.transpileModule(file.code, {
            reportDiagnostics: true,
            fileName: file.name,
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
          });
          expect(output.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? [], file.name).toEqual([]);
        }
      }
    });

    it('emits no workspace module or wiring for a shell without one', () => {
      for (const target of SHELL_TARGETS.map((t) => t.id)) {
        expect(shellCode(shell, fragments, target).map((file) => file.name)).not.toContain('workspace.ts');
        expect(all(target)).not.toContain('workspace');
      }
    });

    it('does not count the workspace area as empty', () => {
      const code = all('react', { ...desk, routes: [{ ...desk.routes[0], slots: { nav: 'reviews' } }] });
      expect(code).not.toContain('empty areas');
    });
  });
});
