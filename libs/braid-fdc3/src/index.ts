export { createBraidDesktopAgent } from './agent.js';
export type {
  BraidDesktopAgent,
  BraidDesktopAgentOptions,
  BraidDesktopApi,
  HostPreferences,
  IntentCandidate,
  IntentChoiceRequest,
  IntentResolverHook,
  SavedLayout,
  SavedSlot,
} from './agent.js';
export { localStorageStore, serverStore, memoryStore, isStoreKey, keySegment } from './store.js';
export type { PreferenceStore, LocalStorageStoreOptions, ServerStoreOptions } from './store.js';
export { dialogResolver } from './resolver.js';
