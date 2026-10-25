import braided from './braided/section.html';
import glossary from './glossary/section.html';
import parts from './parts/section.html';
import problem from './problem/section.html';
import promises from './promises/section.html';
import start from './start/section.html';

/**
 * The homepage's sections, in page order. Each `name` is a folder here and a fragment at
 * `f/<name>/main.js`; `id` is the in-page anchor the nav links to; `label` names it in the fallback.
 */
export const sections = [
  { name: 'problem', id: 'problem', label: 'Why this is hard', markup: problem },
  { name: 'glossary', id: 'how', label: 'Words you’ll hear a lot', markup: glossary },
  { name: 'braided', id: 'braided', label: 'This page is braided', markup: braided },
  { name: 'promises', id: 'promises', label: 'What we promise', markup: promises },
  { name: 'start', id: 'start', label: 'Start in ten minutes', markup: start },
  { name: 'parts', id: 'parts', label: 'The parts bin', markup: parts },
] as const;
