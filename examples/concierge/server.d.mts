/** Types for the e2e that runs this example (`e2e/concierge-example.e2e.ts`). */
export function start(options: { dir: string; port?: number }): Promise<{
  url: string;
  /** Everything POSTed to /agent/actions: `{ message, metadata }`. */
  received: {
    message: Record<string, any>;
    metadata?: Record<string, unknown>;
  }[];
  close(): Promise<void>;
}>;
