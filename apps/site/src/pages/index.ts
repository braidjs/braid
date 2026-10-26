import { contact, contactThanks } from './contact';
import { crawlFiles } from './crawl';
import { home } from './home';
import type { Page } from './layout';
import { cheatsheet, howItsBuilt } from './reference';

const site = [home(), cheatsheet(), howItsBuilt(), contact(), contactThanks()];

/** Every file the build writes: the pages, then what crawlers read about them. Run in Node by `build.mjs`. */
export const pages: Page[] = [...site, ...crawlFiles(site)];
