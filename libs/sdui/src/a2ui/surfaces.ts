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

/** How many surfaces one renderer holds at once. */
export const MAX_SURFACES = 64;

/**
 * How large a surface's data model may grow, through any number of updates: nesting, values (each
 * scalar, list and object), and characters (of its strings and keys). Characters are what a page
 * keeps in memory; values are what walking it costs.
 */
export const DATA_MODEL_LIMITS = Object.freeze({
  depth: 40,
  values: 200_000,
  chars: 2_000_000,
});

/**
 * What one renderer holds in all: the characters of every surface's components and data model
 * together. A surface may grow to its own limits only while the renderer has room.
 */
export const SURFACES_LIMITS = Object.freeze({
  surfaces: MAX_SURFACES,
  /** Characters of one surface's components, counted as for the data model plus one per value. */
  componentChars: 2_000_000,
  chars: 8_000_000,
});

interface MutableSurface {
  id: string;
  catalogId?: string;
  sendDataModel: boolean;
  metadata?: Record<string, unknown>;
  components: Map<string, A2uiComponent>;
  /** What each component costs to hold, so replacing one need not weigh the old one again. */
  componentWeights: Map<string, number>;
  componentChars: number;
  dataModel: Record<string, unknown>;
  /** The data model's weight, kept as it changes so no update has to weigh it all again. */
  values: number;
  chars: number;
  revision: number;
}

export class A2uiSurfaces {
  readonly #surfaces = new Map<string, MutableSurface>();
  /** Characters held across every surface: components and data models. */
  #chars = 0;

  get(id: string): A2uiSurfaceState | undefined {
    return this.#surfaces.get(id);
  }

  ids(): string[] {
    return [...this.#surfaces.keys()];
  }

  /** Characters this renderer holds, across all its surfaces. */
  get chars(): number {
    return this.#chars;
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
        const dataModel = body.dataModel
          ? (structuredClone(body.dataModel) as Record<string, unknown>)
          : {};
        const weight = weigh(dataModel);
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
          componentWeights: new Map(),
          componentChars: 0,
          dataModel: {},
          values: 0,
          chars: 0,
          revision: 1,
        };
        this.#fitData(surface, weight.values, weight.chars, weight.depth);
        surface.dataModel = dataModel;
        surface.values = weight.values;
        surface.chars = weight.chars;
        this.#chars += weight.chars;
        let ids: string[] = [];
        try {
          ids = body.components ? this.#merge(surface, body.components) : [];
        } catch (error) {
          this.#chars -= weight.chars;
          throw error;
        }
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
        const ids = this.#merge(surface, body.components);
        surface.revision++;
        return { kind, surfaceId: surface.id, changed: { components: ids } };
      }
      case 'updateDataModel': {
        const body = (
          message as Extract<A2uiMessage, { updateDataModel: unknown }>
        ).updateDataModel;
        const surface = this.#existing(body.surfaceId, kind);
        this.#write(surface, parsePointer(body.path ?? '/'), body.value);
        surface.revision++;
        return { kind, surfaceId: surface.id, changed: { dataModel: true } };
      }
      case 'deleteSurface': {
        const body = (
          message as Extract<A2uiMessage, { deleteSurface: unknown }>
        ).deleteSurface;
        const surface = this.#existing(body.surfaceId, kind);
        this.#chars -= surface.chars + surface.componentChars;
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
    this.#write(surface, parsePointer(path), value);
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

  /** Refuses a data model of this weight, replacing the surface's current one, past any limit. */
  #fitData(
    surface: MutableSurface,
    values: number,
    chars: number,
    depth: number,
  ): void {
    const refuse = (message: string): never => {
      throw new A2uiError('VALIDATION_FAILED', message, '/value', surface.id);
    };
    if (depth > DATA_MODEL_LIMITS.depth)
      refuse(
        `the data model would nest more than ${DATA_MODEL_LIMITS.depth} levels deep`,
      );
    if (values > DATA_MODEL_LIMITS.values)
      refuse(
        `the data model would hold more than ${DATA_MODEL_LIMITS.values} values`,
      );
    if (chars > DATA_MODEL_LIMITS.chars)
      refuse(
        `the data model would hold more than ${DATA_MODEL_LIMITS.chars} characters`,
      );
    if (this.#chars - surface.chars + chars > SURFACES_LIMITS.chars)
      refuse(
        `the renderer would hold more than ${SURFACES_LIMITS.chars} characters across its surfaces`,
      );
  }

  #merge(
    surface: MutableSurface,
    components: readonly A2uiComponent[],
  ): string[] {
    let added = 0;
    let chars = surface.componentChars;
    const weights = new Map<string, number>();
    for (const component of components) {
      const previous = weights.has(component.id)
        ? weights.get(component.id)
        : surface.componentWeights.get(component.id);
      if (previous === undefined) added++;
      const weight = weigh(component);
      const units = weight.values + weight.chars;
      chars += units - (previous ?? 0);
      weights.set(component.id, units);
    }
    const refuse = (message: string): never => {
      throw new A2uiError(
        'VALIDATION_FAILED',
        message,
        '/components',
        surface.id,
      );
    };
    if (surface.components.size + added > A2UI_LIMITS.components)
      refuse(
        `the surface would hold more than ${A2UI_LIMITS.components} components`,
      );
    if (chars > SURFACES_LIMITS.componentChars)
      refuse(
        `the surface's components would hold more than ${SURFACES_LIMITS.componentChars} characters`,
      );
    const total = this.#chars - surface.componentChars + chars;
    if (total > SURFACES_LIMITS.chars)
      refuse(
        `the renderer would hold more than ${SURFACES_LIMITS.chars} characters across its surfaces`,
      );
    for (const component of components)
      surface.components.set(component.id, component);
    for (const [id, units] of weights) surface.componentWeights.set(id, units);
    this.#chars = total;
    surface.componentChars = chars;
    return components.map((component) => component.id);
  }

  /**
   * Puts `value` at `segments` in a surface's data model — `null` deletes — in place, after
   * everything that could refuse it has been checked, so a refused update leaves the model as it
   * was. An update costs what it changes: nothing is copied but the value itself, and nothing
   * weighed but it and what it replaces. Missing containers on the way are created as objects; a
   * numeric segment into an array addresses an index, and `-` appends.
   */
  #write(
    surface: MutableSurface,
    segments: readonly string[],
    value: unknown,
  ): void {
    const fresh = value === null ? null : structuredClone(value);
    const added =
      fresh === null ? { values: 0, chars: 0, depth: 0 } : weigh(fresh);
    if (segments.length === 0) {
      if (fresh !== null && !isRecord(fresh))
        throw new A2uiError(
          'VALIDATION_FAILED',
          'the data model as a whole must be an object',
          '/value',
          surface.id,
        );
      const next = (fresh as Record<string, unknown> | null) ?? {};
      const weight = fresh === null ? weigh(next) : added;
      this.#fitData(surface, weight.values, weight.chars, weight.depth);
      this.#chars += weight.chars - surface.chars;
      surface.dataModel = next;
      surface.values = weight.values;
      surface.chars = weight.chars;
      return;
    }
    // Find, without changing anything, how far the path exists.
    let container: unknown = surface.dataModel;
    let at = 0;
    for (; at < segments.length - 1; at++) {
      const child = read(container, segments[at] as string);
      if (typeof child !== 'object' || child === null) break;
      container = child;
    }
    const last = segments.length - 1;
    // Deleting below something that is not a container changes nothing.
    if (fresh === null && at < last) return;
    const keyChars = (parent: unknown, key: string): number =>
      Array.isArray(parent) ? 0 : key.length;
    let values = surface.values;
    let chars = surface.chars;
    // The entry the write replaces: a scalar in the way of the path, or the value at its end.
    const target = segments[at] as string;
    const replaced = read(container, target);
    if (replaced !== undefined) {
      const old = weigh(replaced);
      values -= old.values;
      chars -= old.chars + keyChars(container, target);
    } else if (fresh === null) return; // deleting what is not there changes nothing
    if (fresh !== null) {
      writable(container, target, surface.id);
      // Containers the path creates: an object per segment, each under its key.
      for (let index = at; index < last; index++) {
        values += 1;
        chars +=
          index === at ? keyChars(container, target) : segments[index]!.length;
      }
      values += added.values;
      chars +=
        added.chars +
        (at < last ? segments[last]!.length : keyChars(container, target));
    }
    this.#fitData(
      surface,
      values,
      chars,
      fresh === null ? 0 : segments.length + added.depth,
    );
    // Accepted: change the model.
    if (fresh === null) remove(container, target);
    else if (at === last) assign(container, target, fresh);
    else {
      let parent = container;
      for (let index = at; index < last; index++) {
        const created = {};
        assign(parent, segments[index] as string, created);
        parent = created;
      }
      assign(parent, segments[last] as string, fresh);
    }
    this.#chars += chars - surface.chars;
    surface.values = values;
    surface.chars = chars;
  }
}

/**
 * What holding a value costs: `values` (each scalar, list and object), `chars` (the characters of
 * its strings and object keys) and `depth` (how many containers deep it goes; a scalar is 0).
 */
export function weigh(value: unknown): {
  values: number;
  chars: number;
  depth: number;
} {
  let values = 0;
  let chars = 0;
  let depth = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [inner, level] = stack.pop() as [unknown, number];
    values++;
    if (typeof inner === 'string') chars += inner.length;
    else if (inner !== null && typeof inner === 'object') {
      if (level + 1 > depth) depth = level + 1;
      if (Array.isArray(inner))
        for (const child of inner) stack.push([child, level + 1]);
      else
        for (const key of Object.keys(inner)) {
          chars += key.length;
          stack.push([(inner as Record<string, unknown>)[key], level + 1]);
        }
    }
  }
  return { values, chars, depth };
}

function read(container: unknown, segment: string): unknown {
  if (Array.isArray(container))
    return /^\d+$/.test(segment) ? container[Number(segment)] : undefined;
  return isRecord(container) &&
    Object.prototype.hasOwnProperty.call(container, segment)
    ? container[segment]
    : undefined;
}

/** Throws unless `segment` of `container` can be written: an array takes an index up to its end. */
function writable(
  container: unknown,
  segment: string,
  surfaceId: string,
): void {
  if (!Array.isArray(container)) return;
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
}

function assign(container: unknown, segment: string, value: unknown): void {
  if (Array.isArray(container)) {
    container[segment === '-' ? container.length : Number(segment)] = value;
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
