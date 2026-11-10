/**
 * The runtime module a served shell loads (`shellDocuments({ runtimeSrc })`), as a host would
 * write it for a shell with a workspace area: Braid, plus the console workspace on the page's
 * `[data-braid-workspace]` element.
 */
import { initBraid } from '@braidlabs/core';
import { createWorkspace } from '@braidlabs/console/workspace';

const workspace = createWorkspace();
(window as unknown as { workspace: typeof workspace }).workspace = workspace;
initBraid({ realmGlobals: workspace.realmGlobals() });
