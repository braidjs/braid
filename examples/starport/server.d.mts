/** Types for the e2e that runs this example (`e2e/starport-example.e2e.ts`). */
export function start(options: {
  dir: string;
  port?: number;
  base?: string;
  onRequest?: (pathname: string) => void;
  headers?: Record<string, string>;
}): Promise<{ url: string; close(): Promise<void> }>;
