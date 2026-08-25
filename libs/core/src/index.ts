/**
 * @braidlabs/core — the Braid client runtime.
 *
 * This build ships the compat adapter as the only — and default — adapter: legacy apps
 * compose as fragments with zero app-code changes, config only.
 *
 * ```ts
 * import { initBraid } from '@braidlabs/core';
 * initBraid();
 * ```
 * ```html
 * <fragment-slot name="checkout"></fragment-slot>
 * ```
 */

import { BraidOptions, setBraidConfig } from './config.js';
import { installAdapter } from './adapters/adapter.js';
import { compatAdapter } from './adapters/compat-adapter.js';
import { customElementAdapter } from './adapters/custom-element-adapter.js';
import { contractAdapter } from './adapters/contract-adapter.js';
import { FragmentSlot } from './elements/fragment-slot.js';

export { BraidError } from './errors.js';
export type { BraidErrorStage } from './errors.js';
export type { BraidOptions } from './config.js';
export type { FragmentEnv, EnvDocument, EnvLocation, EnvHistory, EnvContext } from './env/fragment-env.js';
export type { BraidAdapter } from './adapters/adapter.js';
export { DEFAULT_ADAPTER } from './adapters/adapter.js';
export { customElementAdapter } from './adapters/custom-element-adapter.js';
export { contractAdapter } from './adapters/contract-adapter.js';
export { defineFragment } from './env/define-fragment.js';
export type { FragmentDefinition } from './env/define-fragment.js';
export { FragmentSlot } from './elements/fragment-slot.js';
export type { FragmentSlotState } from './elements/fragment-slot.js';
export { braidContext, createContextBus } from './context/context-bus.js';
export type { ContextBus } from './context/context-bus.js';
export type { ContextBusLike } from './context/context-bus.js';
export type { FragmentCapabilities, ContextGrants } from './weave/capabilities.js';
export type {
  FragmentContract,
  HostContract,
  ContractRequirements,
  ContractProvisions,
  ContextBridge,
  Negotiation,
} from './weave/contract.js';
export type { CloseReason, CloseSummary, CloseResult } from './weave/closing.js';
export type { LivenessState } from './weave/liveness.js';
export { registerBraidServiceWorker } from './compat/register-worker.js';
export type { RegisterBraidServiceWorkerOptions } from './compat/register-worker.js';
export type { ContextSubscribeOptions, ContextReadOptions } from './context/context-bus.js';
export { createRealm } from './realm/realm-manager.js';
export { createSandboxRealm, assertCrossOrigin, resolveSandboxTokens, DEFAULT_SANDBOX_TOKENS } from './realm/sandbox-realm.js';
export type { SandboxRealm, SandboxRealmInit } from './realm/sandbox-realm.js';
export { connectToBraidHost } from './weave/guest.js';
export type { GuestSession, ConnectOptions } from './weave/guest.js';
export type { RealmKind, RealmHandle, RealmInit, RealmImportMap } from './realm/realm-manager.js';
export {
  BRAID_FRAGMENT_PREFIX,
  BRAID_REALM_PREFIX,
  BRAID_DOCUMENT_PREFIX,
  BRAID_PROTOCOL_VERSION,
} from './protocol.js';

/**
 * Initializes the Braid client: applies configuration, installs the default compat adapter,
 * and registers the `<fragment-slot>` element. Call once, before any slot connects.
 */
export function initBraid(options: BraidOptions = {}): void {
  setBraidConfig(options);
  installAdapter(compatAdapter);
  installAdapter(customElementAdapter);
  installAdapter(contractAdapter);

  if (!customElements.get('fragment-slot')) {
    customElements.define('fragment-slot', FragmentSlot);
  }
}
