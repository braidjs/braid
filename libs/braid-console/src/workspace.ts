/**
 * @braidlabs/console/workspace — the runtime half of the console's workspace: an area of a page
 * where apps are launched, with per-user preferences, app settings and saved layouts.
 *
 * Framework-free: nothing here imports React, so a vanilla or Angular host can use it. The
 * console's shell designer marks which area of a shell is the workspace; this is what runs there.
 */
export { createWorkspace } from './workspace/workspace.js';
export type {
  Workspace,
  WorkspaceOptions,
  WorkspaceFragment,
  WorkspaceIntentCandidate,
  WorkspaceIntentResolver,
  RealmGlobals,
  HostPreferences,
  SavedLayout,
  SavedSlot,
  BraidDesktopApi,
} from './workspace/workspace.js';
export { localStorageStore, serverStore, memoryStore, isStoreKey, keySegment } from './workspace/store.js';
export type { PreferenceStore, LocalStorageStoreOptions, ServerStoreOptions } from './workspace/store.js';
