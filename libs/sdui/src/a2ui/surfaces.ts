import { isRecord } from '../lib/internal.js';
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

/** How many surfaces one renderer holds at once: each may be 5,000 components and its data. */
export const MAX_SURFACES = 64;

/** How large a data model may grow, through any number of updates. */
export const DATA_MODEL_LIMITS = Object.freeze({ depth: 40, values: 400_000 });

interface MutableSurface {
  id: string;
  catalogId?: string;
  sendDataModel: boolean;
  metadata?: Record<string, unknown>;
  components: Map<string, A2uiComponent>;
  dataModel: Record<string, unknown>;
  /** Values in the data model, kept as it changes so no update has to count them all again. */
  size: number;
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
        if (this.#surfaces.size >= MAX_SURFACES)
          throw new A2uiError(
            'VALIDATION_FAILED',
            `a renderer holds at most ${MAX_SURFACES} surfaces; delete one first`,
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
          size: 0,
          revision: 1,
        };
        surface.size = countValues(surface.dataModel);
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
        writeAt(surface, parsePointer(body.path ?? '/'), body.value);
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
    writeAt(surface, parsePointer(path), value);
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

/** Values in a value — scalars, arrays and objects — as the data model limit counts them. */
function countValues(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const inner = stack.pop();
    count++;
    if (inner !== null && typeof inner === 'object')
      for (const child of Array.isArray(inner) ? inner : Object.values(inner))
        stack.push(child);
  }
  return count;
}

function depthOf(value: unknown, limit: number): number {
  const visit = (inner: unknown, depth: number): number => {
    if (depth > limit || inner === null || typeof inner !== 'object')
      return depth;
    let deepest = depth;
    for (const child of Array.isArray(inner) ? inner : Object.values(inner))
      deepest = Math.max(deepest, visit(child, depth + 1));
    return deepest;
  };
  return visit(value, 0);
}

const shallow = (container: object): Record<string, unknown> | unknown[] =>
  Array.isArray(container)
    ? container.slice()
    : { ...(container as Record<string, unknown>) };

/**
 * Puts `value` at `segments` in a surface's data model — `null` deletes — copying only the
 * containers on the way, so the old model is untouched until the new one is accepted, and an
 * update costs what it changes rather than the size of the whole model. Missing containers on the
 * way are created as objects; a numeric segment into an array addresses an index, and `-` appends.
 */
function writeAt(
  surface: MutableSurface,
  segments: readonly string[],
  value: unknown,
): void {
  const refuse = (message: string): never => {
    throw new A2uiError('VALIDATION_FAILED', message, '/value', surface.id);
  };
  const fresh = value === null ? null : structuredClone(value);
  if (
    fresh !== null &&
    segments.length + depthOf(fresh, DATA_MODEL_LIMITS.depth) >
      DATA_MODEL_LIMITS.depth
  )
    refuse(
      `the data model would nest more than ${DATA_MODEL_LIMITS.depth} levels deep`,
    );
  let next: Record<string, unknown>;
  let size: number;
  if (segments.length === 0) {
    if (fresh !== null && !isRecord(fresh))
      return refuse('the data model as a whole must be an object');
    next = (fresh as Record<string, unknown> | null) ?? {};
    size = countValues(next);
  } else {
    next = shallow(surface.dataModel) as Record<string, unknown>;
    size = surface.size;
    let container: unknown = next;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index] as string;
      const child = read(container, segment);
      if (typeof child !== 'object' || child === null) {
        if (fresh === null) return; // deleting below something absent changes nothing
        const created = {};
        size += 1 - (child === undefined ? 0 : 1);
        assign(container, segment, created, surface.id);
        container = created;
      } else {
        const copy = shallow(child);
        assign(container, segment, copy, surface.id);
        container = copy;
      }
    }
    const last = segments[segments.length - 1] as string;
    const old = read(container, last);
    size -= old === undefined ? 0 : countValues(old);
    if (fresh === null) remove(container, last);
    else {
      assign(container, last, fresh, surface.id);
      size += countValues(fresh);
    }
  }
  if (size > DATA_MODEL_LIMITS.values)
    refuse(
      `the data model would hold more than ${DATA_MODEL_LIMITS.values} values`,
    );
  surface.dataModel = next;
  surface.size = size;
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
