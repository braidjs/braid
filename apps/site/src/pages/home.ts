import { sections } from '../fragments';
import { frame } from '../shared/frame';
import { DOCS, layout, ORIGIN, type Page } from './layout';
import masthead from './partials/masthead.html';

/**
 * One homepage section: the live contract fragment, then a prerendered copy of the same markup.
 *
 * The copy is what a reader sees before JavaScript runs, without it, or if the fragment fails; the
 * stylesheet swaps to the live fragment once its slot reports `state="ready"`. The anchor `id` sits
 * on the wrapper, because ids inside shadow roots are not reachable from a URL.
 */
function section({ name, id, markup }: (typeof sections)[number]): string {
  return `<div class="section" id="${id}">
<fragment-slot name="${name}" adapter="contract" entry="./f/${name}/main.js"></fragment-slot>
<div class="ssr"><template shadowrootmode="open">${frame(markup)}</template></div>
</div>`;
}

export const HOME_DESCRIPTION =
  'Braid puts apps from different teams on one page. It untangles the libraries they would share and catches contract skew before your users do.';

/** What search engines read about the project. Only facts the page itself states. */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Braid', url: `${ORIGIN}/`, description: HOME_DESCRIPTION },
    {
      '@type': 'SoftwareSourceCode',
      name: 'Braid',
      description: HOME_DESCRIPTION,
      url: `${ORIGIN}/`,
      codeRepository: 'https://github.com/braidjs/braid',
      programmingLanguage: 'TypeScript',
      license: 'https://opensource.org/licenses/MIT',
      sameAs: [`${DOCS}/`, 'https://www.npmjs.com/package/@braidlabs/core'],
    },
  ],
};

export function home(): Page {
  const path = 'index.html';
  return {
    path,
    html: layout({
      path,
      title: 'Braid — the safe microfrontend orchestrator',
      description: HOME_DESCRIPTION,
      base: './',
      braid: true,
      // `<` escaped so no string in the data can close the script element.
      head: `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>`,
      bodyAttributes: 'data-seams',
      body: `${masthead}\n<main>\n${sections.map(section).join('\n')}\n</main>`,
    }),
  };
}
