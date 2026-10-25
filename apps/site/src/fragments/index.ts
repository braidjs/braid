import braided from './braided/section.html';
import glossary from './glossary/section.html';
import parts from './parts/section.html';
import problem from './problem/section.html';
import promises from './promises/section.html';
import start from './start/section.html';

/**
 * The homepage's sections, in page order. Each `name` is a folder here and a fragment at
 * `f/<name>/main.js`; `id` is the in-page anchor the nav links to.
 */
export const sections = [
  { name: 'problem', id: 'problem', markup: problem },
  { name: 'glossary', id: 'how', markup: glossary },
  { name: 'braided', id: 'braided', markup: braided },
  { name: 'promises', id: 'promises', markup: promises },
  { name: 'start', id: 'start', markup: start },
  { name: 'parts', id: 'parts', markup: parts },
] as const;
