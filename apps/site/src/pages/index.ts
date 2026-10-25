import { home } from './home';
import type { Page } from './layout';
import { cheatsheet, howItsBuilt } from './reference';

/** Every page the build writes. Run in Node by `build.mjs`. */
export const pages: Page[] = [home(), cheatsheet(), howItsBuilt()];
