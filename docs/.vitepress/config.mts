import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

/**
 * The published docs site.
 *
 * VitePress rather than plain Jekyll for two concrete reasons, both measured against these docs:
 * the 43 relative `.md` cross-links resolve correctly because VitePress rewrites them to `.html`
 * at build time (Jekyll serves them as raw downloads), and the mermaid diagrams in four files
 * render (GitHub's repo view draws them natively, GitHub Pages does not).
 *
 * The source keeps its `.md` links either way, so the docs stay readable on github.com.
 *
 * Named `.mts` deliberately: the workspace root is not `"type": "module"`, so a `.ts` config is
 * bundled as CJS and fails to require these ESM-only packages. The extension forces ESM here
 * without making the whole Nx workspace ESM.
 */
export default withMermaid(
  defineConfig({
    title: 'Braid',
    description: 'Many apps. One page. One accessibility tree.',

    // Project pages live under /<repo>/, so every asset and link URL needs that prefix — get it
    // wrong and the site renders as unstyled HTML because the CSS 404s. Overridable so a fork,
    // a rename, or a custom domain (where base is '/') does not need a code change.
    base: process.env.DOCS_BASE ?? '/braid/',

    // Planning documents are internal roadmap, not reference material. Excluded deliberately
    // rather than by oversight — publishing them is a decision, not a side effect.
    srcExclude: ['plans/**', '**/node_modules/**'],

    // The tutorials directory index is README.md so github.com renders it when browsing the
    // folder; VitePress serves a directory from index.md. Mapping it here keeps both working
    // instead of forcing a choice between them.
    rewrites: {
      'tutorials/README.md': 'tutorials/index.md',
    },

    // The deck is a standalone self-contained page; VitePress must copy it, not parse it.
    ignoreDeadLinks: true,

    themeConfig: {
      nav: [
        { text: 'Getting started', link: '/getting-started' },
        { text: 'Explained', link: '/braid-explained' },
        { text: 'End-to-End Tutorial', link: '/tutorial/' },
        { text: 'Packages', link: '/packages/' },
        { text: 'Feature Deep Dives', link: '/tutorials/' },
        { text: 'Talk deck', link: '/braid-deck.html', target: '_blank' },
      ],

      sidebar: [
        {
          text: 'Start here',
          items: [
            { text: 'Getting started', link: '/getting-started' },
            { text: 'Braid, explained', link: '/braid-explained' },
          ],
        },
        {
          text: 'Progressive Tutorial',
          items: [
            { text: 'Overview & Roadmap', link: '/tutorial/' },
            { text: '1 · Monorepo & Two Apps', link: '/tutorial/01-monorepo-setup' },
            { text: '2 · Gateway & Manifest', link: '/tutorial/02-gateway-and-manifest' },
            { text: '3 · Mounting & Isolation', link: '/tutorial/03-mounting-and-isolation' },
            { text: '4 · Props, Events & Context', link: '/tutorial/04-props-and-events' },
            { text: '5 · Versioned Local Data', link: '/tutorial/05-versioned-data-skew' },
            { text: '6 · Schema Migrations', link: '/tutorial/06-schema-migrations' },
            { text: '7 · Production Hardening', link: '/tutorial/07-production-hardening' },
          ],
        },
        {
          text: 'Packages & API Reference',
          items: [
            { text: 'Packages Overview', link: '/packages/' },
            {
              text: 'Core & Gateway',
              items: [
                { text: '@braidlabs/core', link: '/packages/core' },
                { text: '@braidlabs/gateway', link: '/packages/gateway' },
                { text: '@braidlabs/cli', link: '/packages/cli' },
                { text: '@braidlabs/registry', link: '/packages/registry' },
                { text: '@braidlabs/sw', link: '/packages/sw' },
                { text: '@braidlabs/console', link: '/packages/console' },
              ],
            },
            {
              text: 'Framework Bindings',
              items: [
                { text: '@braidlabs/react', link: '/packages/react' },
                { text: '@braidlabs/angular', link: '/packages/angular' },
              ],
            },
            {
              text: 'Data, Contract & Skew',
              items: [
                { text: '@braidlabs/skew', link: '/packages/skew' },
                { text: '@braidlabs/data', link: '/packages/data' },
                { text: '@braidlabs/contract', link: '/packages/contract' },
                { text: '@braidlabs/build', link: '/packages/build' },
                { text: '@braidlabs/studio', link: '/packages/studio' },
              ],
            },
            {
              text: 'Angular Skew Suite',
              items: [
                { text: '@braidlabs/angular-core', link: '/packages/angular-core' },
                { text: '@braidlabs/angular-data', link: '/packages/angular-data' },
                { text: '@braidlabs/angular-router', link: '/packages/angular-router' },
                { text: '@braidlabs/angular-workflow', link: '/packages/angular-workflow' },
              ],
            },
          ],
        },
        {
          text: 'Composition & Architecture',
          items: [
            { text: 'Architecture', link: '/braid-architecture' },
            { text: 'Trust tiers', link: '/braid-boundary' },
            { text: 'From Module Federation', link: '/braid-from-module-federation' },
            { text: 'Without the gateway', link: '/braid-without-gateway' },
            { text: 'The POC', link: '/braid-poc' },
            { text: 'Architecture Diagrams', link: '/architecture' },
          ],
        },
        {
          text: 'Running in Production',
          items: [
            { text: 'CDN and deployment', link: '/braid-cdn' },
            { text: 'Failure modes', link: '/braid-failure-modes' },
            { text: 'Tooling', link: '/braid-tooling' },
          ],
        },
        {
          text: 'Feature Deep Dives',
          items: [
            { text: 'Deep Dives Overview', link: '/tutorials/' },
            { text: '1 · Compose without colliding', link: '/tutorials/01-braid' },
            { text: '2 · Version the data', link: '/tutorials/02-skew' },
            { text: '3 · Name your build', link: '/tutorials/03-build' },
            { text: '4 · Client storage', link: '/tutorials/04-data-storage' },
            { text: '5 · Angular stores', link: '/tutorials/05-angular-core' },
            { text: '6 · Angular data', link: '/tutorials/06-angular-data' },
            { text: '7 · Storefront, end to end', link: '/tutorials/07-storefront' },
          ],
        },
      ],

      socialLinks: [{ icon: 'github', link: 'https://github.com/braidjs/braid' }],
      search: { provider: 'local' },
      outline: [2, 3],
    },
  }),
);
