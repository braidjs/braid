/**
 * @braidlabs/console — a console for a Braid gateway's registry: fragments, shells, and history.
 *
 * Two ways to use it, from one package:
 *
 * ```tsx
 * // as a library, inside an admin app you already run
 * import { RegistryConsole } from '@braidlabs/console';
 * <RegistryConsole api={{ baseUrl: '/api/gateway' }} />
 * ```
 *
 * ```sh
 * # as a deployable app — a static bundle pointed at a gateway by config
 * nx build-app braid-console
 * ```
 *
 * It reads the discovery endpoint the gateway already serves, so it needs no snapshot store and
 * no write API — it works against a gateway whose manifests are defined in code.
 */

export { RegistryConsole, filterEntries } from './lib/registry-console.js';
export { TopologyGraph, layoutTopology } from './lib/topology-graph.js';
export { IntegrationPanel } from './lib/integration-panel.js';
export type { IntegrationPanelProps } from './lib/integration-panel.js';
export { integrationSnippet, allIntegrationSnippets, integrationWarnings, INTEGRATION_TARGETS } from './lib/integration.js';
export type { IntegrationTarget, IntegrationSnippet } from './lib/integration.js';
export type { TopologyGraphProps } from './lib/topology-graph.js';
export { buildTopology, neighborhood, coTenants, edgeKey } from './lib/topology.js';
export type { Topology, TopologyNode, TopologyEdge, TopologyNodeKind } from './lib/topology.js';
export type { RegistryConsoleProps } from './lib/registry-console.js';
export { RegistryEditor } from './lib/registry-editor.js';
export type { RegistryEditorProps } from './lib/registry-editor.js';
export { AccessPanel } from './lib/access-panel.js';
export type { AccessPanelProps } from './lib/access-panel.js';
export {
  createDraft,
  draftStatus,
  addFragment,
  removeFragment,
  updateFragment,
  resetDraft,
  parseList,
  formatList,
} from './lib/draft.js';
export type { Draft, DraftStatus } from './lib/draft.js';
export {
  fetchRegistry,
  fetchHead,
  listSnapshots,
  publishSnapshot,
  pinSnapshot,
  fetchPermissions,
  RegistryFetchError,
  RegistryApiError,
  DEFAULT_DISCOVERY_PATH,
  DEFAULT_API_PATH,
} from './lib/client.js';
export type { ConsoleApi, RegistryListing, HeadState, PublishOutcome } from './lib/client.js';
export { CONSOLE_STYLES, ensureStyles } from './lib/styles.js';
export { ShellsPanel, newShell } from './lib/shells-panel.js';
export type { ShellsPanelProps } from './lib/shells-panel.js';
export { HistoryPanel } from './lib/history-panel.js';
export type { HistoryPanelProps } from './lib/history-panel.js';
export { EmptyState, emptyKindOf } from './lib/empty-state.js';
export type { EmptyKind } from './lib/empty-state.js';
export { shellCode, SHELL_TARGETS, angularPath } from './lib/shell-codegen.js';
export type { GeneratedFile } from './lib/shell-codegen.js';
export { parseQuery, matchQuery, filterBy, fragmentItem, shellItem, QUERY_KEYS } from './lib/query.js';
export type { ParsedQuery, QueryTerm, QueryKey, SearchItem } from './lib/query.js';
export { tagColor, tagClass, TAG_COLOR_COUNT } from './lib/tags.js';
export { TagChip } from './lib/tag-chip.js';
export { tagQuery } from './lib/registry-console.js';
