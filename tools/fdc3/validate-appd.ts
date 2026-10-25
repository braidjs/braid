import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Validates a value against one schema of the FDC3 2.2 App Directory OpenAPI document, e.g.
 * `'Application'` or `'AllApplicationsResponse'`. Returns the errors, so a failing test shows them.
 */
const document = JSON.parse(readFileSync(new URL('./appd.schema.json', import.meta.url), 'utf8')) as {
  components: Record<string, unknown>;
};

// OpenAPI keywords (`example`, `x-*`, `deprecated` on refs) are not JSON Schema; strict mode refuses them
const ajv = new Ajv({ strict: false, allErrors: true });
(addFormats as unknown as (ajv: Ajv) => void)(ajv);
ajv.addSchema({ $id: 'appd', components: document.components });

export function appdErrors(schema: string, value: unknown): ErrorObject[] {
  const validate = ajv.getSchema(`appd#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema "${schema}" in the AppD document`);
  return validate(value) ? [] : [...(validate.errors ?? [])];
}
