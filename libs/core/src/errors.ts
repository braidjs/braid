/**
 * The Braid error standard: every thrown or reported runtime error names the fragment,
 * the failing stage, and — where we know it — the likely fix.
 */

/** The lifecycle stage in which an error occurred. */
export type BraidErrorStage =
  | 'slot-config' // the <fragment-slot> element is misconfigured
  | 'fragment-fetch' // fetching the fragment's HTML from the gateway namespace failed
  | 'realm-boot' // creating or verifying the fragment's realm failed
  | 'adapter-resolution' // the manifest-declared adapter is not available in this client
  | 'adapter-mount' // the adapter failed while mounting the fragment
  | 'context-version' // a context value's schema version could not be bridged
  | 'boundary' // a message across the fragment boundary failed, timed out, or arrived closed
  | 'handshake' // host and fragment could not agree on terms at connect time
  | 'teardown' // a fragment did not close cleanly within its deadline
  | 'contract'; // host and fragment declared terms that do not meet

export interface BraidErrorInit {
  fragmentId: string;
  stage: BraidErrorStage;
  cause?: unknown;
  /** The likely fix, phrased as an instruction to the developer. */
  fixHint?: string;
  docsUrl?: string;
}

export class BraidError extends Error {
  readonly fragmentId: string;
  readonly stage: BraidErrorStage;
  readonly fixHint?: string;
  readonly docsUrl?: string;

  constructor(message: string, init: BraidErrorInit) {
    const hint = init.fixHint ? `\nLikely fix: ${init.fixHint}` : '';
    const docs = init.docsUrl ? `\nDocs: ${init.docsUrl}` : '';
    super(`[braid:${init.fragmentId}] ${init.stage}: ${message}${hint}${docs}`, { cause: init.cause });
    this.name = 'BraidError';
    this.fragmentId = init.fragmentId;
    this.stage = init.stage;
    this.fixHint = init.fixHint;
    this.docsUrl = init.docsUrl;
  }
}
