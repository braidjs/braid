/** Types for the e2e that runs this example (`e2e/starport-example.e2e.ts`). */
export interface GatewayLibrary {
  createGateway: (options: Record<string, unknown>) => unknown;
  toNodeMiddleware: (gateway: never) => unknown;
}
export function registry(origin: string): Record<string, unknown>[];
export function bundle(options?: { tsconfig?: string }): Promise<Record<string, string>>;
export function loadGateway(options?: { tsconfig?: string }): Promise<GatewayLibrary>;
export function start(options?: {
  port?: number;
  bundles?: Record<string, string>;
  gateway?: GatewayLibrary;
}): Promise<{ url: string; close(): Promise<void> }>;
