import { canonicalJson } from '@braidlabs/skew';
import type { SduiCatalog } from '../lib/catalog.js';
import type { ConditionContext } from '../lib/conditions.js';
import type { ClientManifest } from '../lib/manifest.js';
import {
  type HiddenNode,
  type ProjectionOptions,
  type ProjectionResult,
  applyVisibility,
  projectScreen,
} from '../lib/projection.js';
import { a2uiAuthoringId, a2uiCatalogId } from './capabilities.js';
import { surfaceToScreen, treeToComponents } from './codec.js';
import {
  A2uiError,
  type A2uiComponent,
  type A2uiMessage,
  type A2uiRendererMessage,
  errorMessage,
  messageKind,
  parseA2uiMessage,
} from './messages.js';
import { A2uiSurfaces } from './surfaces.js';

/**
 * Version skew, for A2UI.
 *
 * An agent writes a surface against a catalog's own id — the newest version of every component.
 * The projector stands between it and one renderer, whose manifest says what it was built to draw,
 * and turns each message into what that renderer should receive: every component projected to the
 * renderer's version, down the fallback ladder where it cannot be, never with a guessed value.
 *
 * It keeps both sides' state: the agent's surfaces, and what the renderer has been sent. So an
 * update the agent makes to one component reaches the renderer as an update to the components
 * whose projection changed, and nothing else. When a surface cannot be shown honestly — a required
 * component no fallback can stand in for — the renderer is not sent half of it; the agent is told,
 * with a renderer-style `error` (`INCOMPATIBLE`), and can choose something else.
 *
 * Pure: no I/O, no clock beyond the projection's own. Run one per renderer connection.
 */

export interface A2uiProjectorOptions {
  /** The catalog the agent authors against. Must have `a2ui.catalogId`. */
  readonly catalog: SduiCatalog;
  /** What the renderer was built to draw. */
  readonly manifest: ClientManifest;
  /** The catalog id surfaces carry to the renderer. Defaults to the manifest's own. */
  readonly catalogId?: string;
  /** What conditions in the catalog's nodes are evaluated against — flags, platform, locale. */
  readonly context?: ConditionContext;
  readonly projection?: ProjectionOptions;
}

export interface SurfaceProjection {
  readonly surfaceId: string;
  readonly outcome: ProjectionResult['outcome'];
  readonly report: ProjectionResult['report'];
  readonly hidden: readonly HiddenNode[];
  /** Component ids referenced and not yet sent by the agent. */
  readonly dangling: readonly string[];
}

export interface ProjectorOutput {
  /** Messages for the renderer, in order. */
  readonly toRenderer: readonly A2uiMessage[];
  /** Messages for the agent, as if from the renderer: errors, and answers given on its behalf. */
  readonly toAgent: readonly A2uiRendererMessage[];
  /** How each surface this message touched was projected. */
  readonly projections: readonly SurfaceProjection[];
}

interface RendererSide {
  created: boolean;
  /** What the renderer holds, by id: the canonical JSON of each component sent. */
  readonly sent: Map<string, string>;
}

export interface A2uiProjector {
  /** One agent-to-renderer message, parsed or as `JSON.parse` gave it. */
  push(message: unknown): ProjectorOutput;
  /**
   * One renderer-to-agent message, on its way back: catalog ids are put back into the agent's
   * terms. Anything else passes through.
   */
  fromRenderer(
    message: A2uiRendererMessage | Record<string, unknown>,
  ): Record<string, unknown>;
  /** The agent's surfaces, as received. */
  readonly surfaces: A2uiSurfaces;
}

export const INCOMPATIBLE = 'INCOMPATIBLE';

export function createA2uiProjector(
  options: A2uiProjectorOptions,
): A2uiProjector {
  const { catalog, manifest } = options;
  const authoringId = a2uiAuthoringId(catalog);
  const targetId = options.catalogId ?? a2uiCatalogId(catalog, manifest);
  const surfaces = new A2uiSurfaces();
  const renderer = new Map<string, RendererSide>();
  const supportedFunctions =
    manifest.functions === undefined ? null : new Set(manifest.functions);

  const sideOf = (surfaceId: string): RendererSide => {
    let side = renderer.get(surfaceId);
    if (!side)
      renderer.set(surfaceId, (side = { created: false, sent: new Map() }));
    return side;
  };

  /** Re-projects one surface and says what the renderer needs to catch up. */
  function sync(
    surfaceId: string,
    toRenderer: A2uiMessage[],
    toAgent: A2uiRendererMessage[],
    projections: SurfaceProjection[],
  ): void {
    const state = surfaces.get(surfaceId);
    if (!state) return;
    const side = sideOf(surfaceId);
    const { screen, dangling } = surfaceToScreen(state, { catalog });
    const create = (components?: readonly A2uiComponent[]): A2uiMessage => ({
      version: '1.0',
      createSurface: {
        surfaceId,
        catalogId: targetId,
        ...(state.sendDataModel ? { sendDataModel: true } : {}),
        ...(components && components.length > 0 ? { components } : {}),
        ...(Object.keys(state.dataModel).length > 0
          ? { dataModel: state.dataModel }
          : {}),
        ...(state.metadata ? { metadata: state.metadata } : {}),
      },
    });
    if (screen === null) {
      // Nothing to draw yet. The renderer can still have the surface, and its data.
      if (!side.created) {
        toRenderer.push(create());
        side.created = true;
      }
      return;
    }
    const result = projectScreen(screen, catalog, manifest, options.projection);
    const visible = applyVisibility(result, options.context ?? {});
    projections.push({
      surfaceId,
      outcome: result.outcome,
      report: result.report,
      hidden: visible.hidden,
      dangling,
    });
    if (result.outcome === 'blocked' || visible.root === null) {
      const why = result.report
        .filter((entry) => entry.blocking || entry.nodeId === screen.root.id)
        .map((entry) => `"${entry.nodeId}": ${entry.reason ?? entry.outcome}`)
        .slice(0, 5)
        .join('; ');
      toAgent.push({
        version: '1.0',
        error: {
          code: INCOMPATIBLE,
          message: `this renderer cannot show the surface as written${why ? ` — ${why}` : ''}`,
          surfaceId,
        },
      });
      if (side.created) {
        toRenderer.push({ version: '1.0', deleteSurface: { surfaceId } });
        side.created = false;
        side.sent.clear();
      }
      return;
    }
    const components = treeToComponents(visible.root, { catalog });
    if (!side.created) {
      toRenderer.push(create(components));
      side.created = true;
      for (const component of components)
        side.sent.set(component.id, canonicalJson(component));
      return;
    }
    const changed = components.filter(
      (component) => side.sent.get(component.id) !== canonicalJson(component),
    );
    if (changed.length === 0) return;
    toRenderer.push({
      version: '1.0',
      updateComponents: { surfaceId, components: changed },
    });
    for (const component of changed)
      side.sent.set(component.id, canonicalJson(component));
  }

  function push(raw: unknown): ProjectorOutput {
    const toRenderer: A2uiMessage[] = [];
    const toAgent: A2uiRendererMessage[] = [];
    const projections: SurfaceProjection[] = [];
    try {
      const message = parseA2uiMessage(raw);
      const kind = messageKind(message);
      if (kind === 'createSurface') {
        const body = (
          message as Extract<A2uiMessage, { createSurface: unknown }>
        ).createSurface;
        if (body.catalogId !== undefined && body.catalogId !== authoringId)
          throw new A2uiError(
            'VALIDATION_FAILED',
            `this agent authors against "${authoringId}"; "${body.catalogId}" is a renderer's catalog id, or another catalog`,
            '/catalogId',
            body.surfaceId,
          );
      }
      const applied = surfaces.apply(message);
      const surfaceId = applied.surfaceId;
      switch (kind) {
        case 'createSurface':
        case 'updateComponents':
          sync(surfaceId as string, toRenderer, toAgent, projections);
          break;
        case 'updateDataModel':
          // Data is the surface's, not a component's: nothing to project. It goes to the renderer
          // as soon as the renderer has the surface, and is in the createSurface until then.
          if (sideOf(surfaceId as string).created) toRenderer.push(message);
          break;
        case 'deleteSurface':
          if (sideOf(surfaceId as string).created) toRenderer.push(message);
          renderer.delete(surfaceId as string);
          break;
        case 'callRendererFunction': {
          const body = (
            message as Extract<A2uiMessage, { callRendererFunction: unknown }>
          ).callRendererFunction;
          const name = body.callFunction['@call'];
          if (
            supportedFunctions !== null &&
            !name.startsWith('@') &&
            !supportedFunctions.has(name)
          ) {
            // Answered here: the renderer does not have it, and must not be asked.
            toAgent.push({
              version: '1.0',
              rendererFunctionResponse: {
                functionCallId: body.functionCallId,
                error: {
                  code: 'UNKNOWN_FUNCTION',
                  message: `this renderer has no "${name}" function`,
                },
              },
            });
            break;
          }
          toRenderer.push({
            version: '1.0',
            callRendererFunction: {
              ...body,
              callFunction: {
                ...body.callFunction,
                catalogId:
                  body.callFunction.catalogId === authoringId
                    ? targetId
                    : (body.callFunction.catalogId as string),
              },
            },
          });
          break;
        }
        case 'agentFunctionResponse':
          toRenderer.push(message);
          break;
      }
    } catch (error) {
      if (!(error instanceof A2uiError)) throw error;
      toAgent.push(errorMessage(error));
    }
    return { toRenderer, toAgent, projections };
  }

  function fromRenderer(
    message: A2uiRendererMessage | Record<string, unknown>,
  ): Record<string, unknown> {
    const call = (message as Record<string, unknown>)['callAgentFunction'] as
      | Record<string, unknown>
      | undefined;
    const fn = call?.['callFunction'] as Record<string, unknown> | undefined;
    if (fn && fn['catalogId'] === targetId)
      return {
        ...message,
        callAgentFunction: {
          ...call,
          callFunction: { ...fn, catalogId: authoringId },
        },
      };
    return message as Record<string, unknown>;
  }

  return { push, fromRenderer, surfaces };
}
