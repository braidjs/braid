import { sections } from '../fragments';
import { frame } from '../shared/frame';
import { layout, type Page } from './layout';
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

export function home(): Page {
  return {
    path: 'index.html',
    html: layout({
      title: 'Braid — the safe microfrontend orchestrator',
      description:
        'Braid puts apps from different teams on one page. It untangles the libraries they would share and catches contract skew before your users do.',
      base: './',
      braid: true,
      bodyAttributes: 'data-seams',
      body: `${masthead}\n<main>\n${sections.map(section).join('\n')}\n</main>`,
    }),
  };
}
