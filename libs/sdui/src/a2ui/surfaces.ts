import { isRecord, outgrows } from '../lib/internal.js';
import {
  A2UI_LIMITS,
  A2uiError,
  type A2uiComponent,
  type A2uiMessage,
  type A2uiMessageKind,
  messageKind,
  parsePointer,
} from './messages.js';

/**
 * The state A2UI messages build: surfaces, each a flat map of components by id and a data model.
 *
 * This is the part of a renderer that is not about pixels, kept pure so that a server (to project
 * what an agent sends) and a browser (to draw it) apply messages by the same rules. It enforces
 * the spec's state rules — a surface is created once, updated only after it exists, and its id
 * and catalog are fixed — and refuses an update that would take a surface past the limits,
 * leaving it as it was.
 */

export interface A2uiSurfaceState {
  readonly id: string;
  readonly catalogId?: string;
  readonly sendDataModel: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Every component received, by id, whether or not anything references it yet. */
  readonly components: ReadonlyMap<string, A2uiComponent>;
  readonly dataModel: Readonly<Record<string, unknown>>;
  /** Bumped on every change, so a renderer can tell a surface it has drawn from one it has not. */
  readonly revision: number;
}

export interface AppliedMessage {
  readonly kind: A2uiMessageKind;
  readonly surfaceId?: string;
  /** What changed: `components` and `dataModel` say which halves of a surface to redraw. */
  readonly changed?: {
    readonly components?: readonly string[];
    readonly dataModel?: boolean;
  };
}

/** How large a data model may grow, through any number of updates. */
export const DATA_MODEL_LIMITS = Object.freeze({ depth: 40, values: 400_000 });

interface MutableSurface {
  id: string;
  catalogId?: string;
  sendDataModel: boolean;
  metadata?: Record<string, unknown>;
  components: Map<string, A2uiComponent>;
  dataModel: Record<string, unknown>;
  revision: number;
}

export class A2uiSurfaces {
  readonly #surfaces = new Map<string, MutableSurface>();

  get(id: string): A2uiSurfaceState | undefined {
    return this.#surfaces.get(id);
  }

  ids(): string[] {
    return [...this.#surfaces.keys()];
  }

  /**
   * Applies one parsed message. Throws {@link A2uiError} — `INTEGRITY_ERROR` for a surface that
   * exists or does not, `VALIDATION_FAILED` for one the message would overgrow — and leaves the
   * state untouched when it does. RPC messages change no surface and are returned as applied.
   */
  apply(message: A2uiMessage): AppliedMessage {
    const kind = messageKind(message);
    switch (kind) {
      case 'createSurface': {
        const body = (
          message as Extract<A2uiMessage, { createSurface: unknown }>
        ).createSurface;
        if (this.#surfaces.has(body.surfaceId))
          throw new A2uiError(
            'INTEGRITY_ERROR',
            `the surface "${body.surfaceId}" already exists; delete it before creating it again`,
            '/surfaceId',
            body.surfaceId,
          );
        const surface: MutableSurface = {
          id: body.surfaceId,
          ...(body.catalogId !== undefined
            ? { catalogId: body.catalogId }
            : {}),
          sendDataModel: body.sendDataModel === true,
          ...(body.metadata
            ? {
                metadata: structuredClone(body.metadata) as Record<
                  string,
                  unknown
                >,
              }
            : {}),
          components: new Map(),
          dataModel: body.dataModel
            ? (structuredClone(body.dataModel) as Record<string, unknown>)
            : {},
          revision: 1,
        };
        const ids = body.components
          ? mergeComponents(surface, body.components)
          : [];
        this.#surfaces.set(surface.id, surface);
        return {
          kind,
          surfaceId: surface.id,
          changed: { components: ids, dataModel: true },
        };
      }
      case 'updateComponents': {
        const body = (
          message as Extract<A2uiMessage, { updateComponents: unknown }>
        ).updateComponents;
        const surface = this.#existing(body.surfaceId, kind);
        const ids = mergeComponents(surface, body.components);
        surface.revision++;
        return { kind, surfaceId: surface.id, changed: { components: ids } };
      }
      case 'updateDataModel': {
        const body = (
          message as Extract<A2uiMessage, { updateDataModel: unknown }>
        ).updateDataModel;
        const surface = this.#existing(body.surfaceId, kind);
        surface.dataModel = withValueAt(
          surface.dataModel,
          parsePointer(body.path ?? '/'),
          body.value,
          surface.id,
        );
        surface.revision++;
        return { kind, surfaceId: surface.id, changed: { dataModel: true } };
      }
      case 'deleteSurface': {
        const body = (
          message as Extract<A2uiMessage, { deleteSurface: unknown }>
        ).deleteSurface;
        this.#existing(body.surfaceId, kind);
        this.#surfaces.delete(body.surfaceId);
        return { kind, surfaceId: body.surfaceId };
      }
      default:
        return { kind };
    }
  }

  /**
   * Writes one value into a surface's data model — what an input does when someone types into it.
   * The same rules as `updateDataModel`: `null` deletes.
   */
  write(surfaceId: string, path: string, value: unknown): void {
    const surface = this.#existing(surfaceId, 'updateDataModel');
    surface.dataModel = withValueAt(
      surface.dataModel,
      parsePointer(path),
      value,
      surfaceId,
    );
    surface.revision++;
  }

  #existing(id: string, kind: A2uiMessageKind): MutableSurface {
    const surface = this.#surfaces.get(id);
    if (!surface)
      throw new A2uiError(
        'INTEGRITY_ERROR',
        `${kind} for the surface "${id}", which does not exist — createSurface must come first`,
        '/surfaceId',
        id,
      );
    return surface;
  }
}

function mergeComponents(
  surface: MutableSurface,
  components: readonly A2uiComponent[],
): string[] {
  const added = components.filter(
    (component) => !surface.components.has(component.id),
  ).length;
  if (surface.components.size + added > A2UI_LIMITS.components)
    throw new A2uiError(
      'VALIDATION_FAILED',
      `the surface would hold more than ${A2UI_LIMITS.components} components`,
      '/components',
      surface.id,
    );
  for (const component of components)
    surface.components.set(component.id, component);
  return components.map((component) => component.id);
}

/**
 * The data model with `value` at `segments`, as a new object; the old one is not touched, so a
 * refused write leaves it as it was. Missing containers on the way are created as objects; a
 * numeric segment into an array addresses an index, and `-` appends.
 */
function withValueAt(
  model: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
  surfaceId: string,
): Record<string, unknown> {
  let next: Record<string, unknown>;
  if (segments.length === 0) {
    if (value !== null && !isRecord(value))
      throw new A2uiError(
        'VALIDATION_FAILED',
        'the data model as a whole must be an object',
        '/value',
        surfaceId,
      );
    next =
      value === null ? {} : (structuredClone(value) as Record<string, unknown>);
  } else {
    next = structuredClone(model);
    let container: unknown = next;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index] as string;
      const child = read(container, segment);
      if (typeof child !== 'object' || child === null) {
        if (value === null) return model; // deleting below something absent changes nothing
        const created = {};
        assign(container, segment, created, surfaceId);
        container = created;
      } else container = child;
    }
    const last = segments[segments.length - 1] as string;
    if (value === null) remove(container, last);
    else assign(container, last, structuredClone(value), surfaceId);
  }
  const outgrown = outgrows(next, DATA_MODEL_LIMITS);
  if (outgrown !== null)
    throw new A2uiError(
      'VALIDATION_FAILED',
      outgrown === 'depth'
        ? `the data model would nest more than ${DATA_MODEL_LIMITS.depth} levels deep`
        : `the data model would hold more than ${DATA_MODEL_LIMITS.values} values`,
      '/value',
      surfaceId,
    );
  return next;
}

function read(container: unknown, segment: string): unknown {
  if (Array.isArray(container))
    return /^\d+$/.test(segment) ? container[Number(segment)] : undefined;
  return isRecord(container) &&
    Object.prototype.hasOwnProperty.call(container, segment)
    ? container[segment]
    : undefined;
}

function assign(
  container: unknown,
  segment: string,
  value: unknown,
  surfaceId: string,
): void {
  if (Array.isArray(container)) {
    const index =
      segment === '-'
        ? container.length
        : /^\d+$/.test(segment)
          ? Number(segment)
          : -1;
    if (index < 0 || index > container.length)
      throw new A2uiError(
        'VALIDATION_FAILED',
        `"${segment}" is not an index this list can be written at`,
        '/path',
        surfaceId,
      );
    container[index] = value;
    return;
  }
  // Defined, not assigned: a key named like an accessor on Object.prototype must not reach it.
  Object.defineProperty(container, segment, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function remove(container: unknown, segment: string): void {
  if (Array.isArray(container)) {
    if (/^\d+$/.test(segment) && Number(segment) < container.length)
      container.splice(Number(segment), 1);
    return;
  }
  if (isRecord(container)) delete container[segment];
}

/** Reads a JSON Pointer from a data model, relative to `scope` when it does not start with `/`. */
export function readPointer(
  model: unknown,
  path: string,
  scope: { readonly base: readonly string[] } = { base: [] },
): unknown {
  let segments: readonly string[];
  if (path.startsWith('/')) segments = parsePointer(path);
  else if (path === '' || path === '.') segments = scope.base;
  else
    segments = [
      ...scope.base,
      ...path
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')),
    ];
  let current: unknown = model;
  for (const segment of segments) {
    if (
      segment === '__proto__' ||
      segment === 'constructor' ||
      segment === 'prototype'
    )
      return undefined;
    current = read(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

/** The absolute segments of a path as {@link readPointer} resolves it. */
export function resolvePointer(
  path: string,
  base: readonly string[] = [],
): string[] {
  if (path.startsWith('/')) return parsePointer(path);
  if (path === '' || path === '.') return [...base];
  return [
    ...base,
    ...path
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')),
  ];
}

/** Segments back into a JSON Pointer. */
export function formatPointer(segments: readonly string[]): string {
  return segments.length === 0
    ? '/'
    : segments
        .map(
          (segment) => `/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`,
        )
        .join('');
}
