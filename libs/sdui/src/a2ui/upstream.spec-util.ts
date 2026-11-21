import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * The vendored A2UI v1.0 files (`conformance/a2ui/upstream/`), and validators compiled from its
 * schemas — the spec's own definition of a valid message, which everything this package emits is
 * held to.
 */

export const upstreamDir = join(
  import.meta.dirname,
  '../../conformance/a2ui/upstream',
);
const read = (path: string): any =>
  JSON.parse(readFileSync(join(upstreamDir, path), 'utf8'));

export interface UpstreamExample {
  readonly file: string;
  readonly name: string;
  readonly messages: readonly unknown[];
}

export function upstreamExamples(): UpstreamExample[] {
  return readdirSync(join(upstreamDir, 'examples'))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, ...read(`examples/${file}`) }));
}

export const basicCatalogDocument = (): any =>
  read('catalogs/basic/catalog.json');

const SPEC = 'https://a2ui.org/specification/v1_0/';

/**
 * Validators for the v1.0 schemas. `catalog` is the catalog definition `catalog.json` resolves to
 * — the basic catalog unless another is given — re-identified at the spec's own location, which
 * is where `agent_to_renderer.json` looks for it.
 */
export function upstreamValidators(catalog: any = basicCatalogDocument()) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const name of [
    'common_types',
    'catalog_definition',
    'renderer_capabilities',
  ])
    ajv.addSchema(read(`json/${name}.json`));
  ajv.addSchema({ ...catalog, $id: `${SPEC}catalog.json` });
  const agentToRenderer = ajv.compile(read('json/agent_to_renderer.json'));
  const rendererToAgent = ajv.compile(read('json/renderer_to_agent.json'));
  const catalogDefinition = ajv.getSchema(`${SPEC}catalog_definition.json`)!;
  const capabilities = ajv.getSchema(`${SPEC}renderer_capabilities.json`)!;
  const explain = (validate: { errors?: unknown }) =>
    JSON.stringify(validate.errors, null, 1)?.slice(0, 2_000);
  return {
    agentToRenderer,
    rendererToAgent,
    catalogDefinition,
    capabilities,
    explain,
  };
}
