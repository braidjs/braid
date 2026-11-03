/** Types for `server.mjs`, so the repository's e2e can drive the example as it is. */
export function bundle(options?: {
  tsconfig?: string;
}): Promise<Record<string, string>>;
export function start(options?: {
  port?: number;
  bundles?: Record<string, string>;
  onRequest?: (pathname: string) => void;
  compress?: 'zstd' | 'gzip';
}): Promise<{ url: string; close(): Promise<void> }>;
