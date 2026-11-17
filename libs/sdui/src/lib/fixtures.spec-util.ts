import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ClientManifest,
  type Screen,
  type SduiCatalog,
  parseCatalog,
  parseClientManifest,
  parseScreen,
} from '../index.js';

const dir = resolve(import.meta.dirname, '../../conformance');
export const readVector = (path: string): any =>
  JSON.parse(readFileSync(resolve(dir, path), 'utf8'));

export const catalog = (): SduiCatalog =>
  parseCatalog(readVector('catalog.json'));
export const manifest = (
  name: 'current' | 'one-behind' | 'legacy',
): ClientManifest => parseClientManifest(readVector(`manifests/${name}.json`));
export const screen = (name: 'home' | 'watch'): Screen =>
  parseScreen(readVector(`screens/${name}.json`));
