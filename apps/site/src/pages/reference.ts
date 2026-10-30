import { layout, subnav, type Page } from './layout';
import cheatsheetBody from './partials/cheatsheet.html';
import howItsBuiltBody from './partials/how-its-built.html';

/** The two reference pages: plain static HTML, no fragments. The homepage makes that point once. */

export function cheatsheet(): Page {
  const path = 'cheatsheet/index.html';
  return {
    path,
    html: layout({
      path,
      title: 'The Braid cheatsheet',
      description: 'Setup and the gateway, compat vs contract, talking between apps, skew protection, and data, offline and the outbox — in short snippets.',
      base: '../',
      body: `${subnav('../')}\n${cheatsheetBody}`,
    }),
  };
}

export function howItsBuilt(): Page {
  const path = 'how-its-built/index.html';
  return {
    path,
    html: layout({
      path,
      title: 'How this site is braided',
      description: 'One page of plain files, six contract fragments booted from blob realms, and no server anywhere.',
      base: '../',
      body: `${subnav('../')}\n${howItsBuiltBody}`,
    }),
  };
}
