/**
 * A2UI v1.0 messages — the wire format agents speak to renderers, and renderers back to agents.
 *
 * Everything that arrives here is untrusted: an agent's output is text a model wrote, and a
 * prompt can steer a model. So each message is parsed at the door, against the shape the v1.0
 * schemas give it and against limits of its own, and refused with the spec's error codes and a
 * JSON Pointer to what was wrong. What passes is plain JSON of a known shape: nothing downstream
 * meets a reserved key, a value that is not JSON, or a document too deep or too large to walk.
 *
 * Specification: https://a2ui.org/specification/v1.0-a2ui/ (schemas vendored under
 * `conformance/a2ui/upstream/json/`).
 */

import { RESERVED_KEYS, isRecord, notJson } from '../lib/internal.js';

export const A2UI_VERSION = '1.0';
/** The media type of A2UI messages (v1.0; v0.9 used `application/json+a2ui`). */
export const A2UI_MIME_TYPE = 'application/a2ui+json';

/** The error codes v1.0 names. Renderers may report others; these are the ones this package uses. */
export type A2uiErrorCode =
  | 'VALIDATION_FAILED'
  | 'INTEGRITY_ERROR'
  | 'INVALID_FUNCTION_CALL'
  | 'UNALLOWED_PARENT'
  | 'UNALLOWED_CHILD'
  | 'EXPRESSION_ERROR'
  | 'UNKNOWN_FUNCTION';

/** A refused message, or a problem found while applying one. */
export class A2uiError extends Error {
  override readonly name = 'A2uiError';
  constructor(
    readonly code: A2uiErrorCode,
    message: string,
    /** A JSON Pointer into the message body, `/components/3/text`. `''` is the body itself. */
    readonly path = '',
    readonly surfaceId?: string,
  ) {
    super(message);
  }
}

/** A component on the wire: `{ id, component, ...props }`. */
export interface A2uiComponent {
  readonly id: string;
  readonly component: string;
  readonly [key: string]: unknown;
}

export interface A2uiFunctionCall {
  readonly '@call': string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly catalogId?: string;
}

export interface CreateSurface {
  readonly surfaceId: string;
  readonly catalogId?: string;
  readonly sendDataModel?: boolean;
  readonly components?: readonly A2uiComponent[];
  readonly dataModel?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type A2uiMessage =
  | { readonly version: '1.0'; readonly createSurface: CreateSurface }
  | {
      readonly version: '1.0';
      readonly updateComponents: {
        readonly surfaceId: string;
        readonly components: readonly A2uiComponent[];
      };
    }
  | {
      readonly version: '1.0';
      readonly updateDataModel: {
        readonly surfaceId: string;
        readonly path?: string;
        readonly value: unknown;
      };
    }
  | {
      readonly version: '1.0';
      readonly deleteSurface: { readonly surfaceId: string };
    }
  | {
      readonly version: '1.0';
      readonly callRendererFunction: {
        readonly functionCallId: string;
        readonly surfaceId?: string;
        readonly callFunction: A2uiFunctionCall;
      };
    }
  | {
      readonly version: '1.0';
      readonly agentFunctionResponse: A2uiFunctionResponse;
    };

export interface A2uiFunctionResponse {
  readonly functionCallId: string;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** What a renderer sends back. */
export type A2uiRendererMessage =
  | {
      readonly version: '1.0';
      readonly action: {
        readonly name: string;
        readonly surfaceId: string;
        readonly sourceComponentId: string;
        readonly timestamp: string;
        readonly context: Readonly<Record<string, unknown>>;
        readonly userMessage?: string;
      };
    }
  | {
      readonly version: '1.0';
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly surfaceId?: string;
        readonly functionCallId?: string;
        readonly path?: string;
      };
    }
  | {
      readonly version: '1.0';
      readonly rendererFunctionResponse: A2uiFunctionResponse;
    };

export type A2uiMessageKind =
  | 'createSurface'
  | 'updateComponents'
  | 'updateDataModel'
  | 'deleteSurface'
  | 'callRendererFunction'
  | 'agentFunctionResponse';

const KINDS: readonly A2uiMessageKind[] = [
  'createSurface',
  'updateComponents',
  'updateDataModel',
  'deleteSurface',
  'callRendererFunction',
  'agentFunctionResponse',
];

/** Which kind a parsed message is. */
export function messageKind(message: A2uiMessage): A2uiMessageKind {
  return KINDS.find((kind) => kind in message) as A2uiMessageKind;
}

/** The surface a message is about, when it is about one. */
export function messageSurfaceId(message: A2uiMessage): string | undefined {
  const body = (message as Record<string, unknown>)[messageKind(message)];
  return isRecord(body) && typeof body['surfaceId'] === 'string'
    ? body['surfaceId']
    : undefined;
}

/**
 * How big a message may be. An agent's whole UI fits in a fraction of each; a message past one is
 * a mistake or an attack, and is refused before anything walks it.
 */
export const A2UI_LIMITS = Object.freeze({
  /** Characters in one message as text. */
  messageChars: 2_000_000,
  /** Components in one message, and on one surface. */
  components: 5_000,
  /** Nesting inside any value: a prop, the data model, a call's arguments. */
  depth: 32,
  /**
   * Scalars, arrays and objects in one message. A message is applied in one go, so this is what
   * bounds the longest a page spends on one: parsing, checking and storing 50,000 values is tens
   * of milliseconds. A data model may grow larger, through several.
   */
  values: 50_000,
  /** Characters in one string. */
  string: 100_000,
  /** Characters in an id, a surface id, a component name, a catalog id. */
  id: 512,
  /** Messages in one stream read by {@link parseA2uiStream}. */
  messages: 10_000,
});

/** Envelope keys a component may carry. Anything else with a single leading `@` is refused. */
export const COMPONENT_ENVELOPE_KEYS = [
  '@catalogId',
  '@accessibility',
  '@metadata',
  '@checks',
] as const;

/** `^@([^@]|$)`: a directive, as opposed to `@@escaped`, which is a literal key. */
const isDirective = (key: string): boolean => /^@([^@]|$)/.test(key);

interface Walk {
  readonly surfaceId?: string;
  values: number;
}

function fail(
  code: A2uiErrorCode,
  message: string,
  path: string,
  walk: Walk,
): never {
  throw new A2uiError(code, message, path, walk.surfaceId);
}

const pointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function checkString(
  value: unknown,
  path: string,
  walk: Walk,
  max: number = A2UI_LIMITS.id,
): string {
  if (typeof value !== 'string' || value.length === 0)
    return fail('VALIDATION_FAILED', 'must be a non-empty string', path, walk);
  if (value.length > max)
    fail('VALIDATION_FAILED', `must be at most ${max} characters`, path, walk);
  return value;
}

function onlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  walk: Walk,
  hint?: Readonly<Record<string, string>>,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      const why = hint?.[key] ?? `"${key}" is not a field of this message`;
      fail('VALIDATION_FAILED', why, pointer(path, key), walk);
    }
  }
}

/**
 * Walks any JSON value an agent supplied. Refuses what is not JSON, a reserved key, nesting or
 * size past the limits, and — in a value where the protocol could read one — a single-`@` key
 * that is not a directive this package knows: `@path` and `@call` (with `args` and `catalogId`)
 * in a dynamic value; nothing else.
 */
function checkValue(
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
  dynamic: boolean,
): void {
  if (--walk.values < 0)
    fail(
      'VALIDATION_FAILED',
      `the message holds more than ${A2UI_LIMITS.values} values`,
      path,
      walk,
    );
  if (typeof value === 'string') {
    if (value.length > A2UI_LIMITS.string)
      fail(
        'VALIDATION_FAILED',
        `is a string of more than ${A2UI_LIMITS.string} characters`,
        path,
        walk,
      );
    return;
  }
  const problem = notJson(value);
  if (problem !== null)
    fail('VALIDATION_FAILED', `is ${problem}, which is not JSON`, path, walk);
  if (typeof value !== 'object' || value === null) return;
  if (depth >= A2UI_LIMITS.depth)
    fail(
      'VALIDATION_FAILED',
      `is nested more than ${A2UI_LIMITS.depth} levels deep`,
      path,
      walk,
    );
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      checkValue(value[index], pointer(path, index), depth + 1, walk, dynamic);
    return;
  }
  const keys = Object.keys(value);
  for (const key of keys)
    if (RESERVED_KEYS.has(key))
      fail(
        'VALIDATION_FAILED',
        `uses the reserved key "${key}"`,
        pointer(path, key),
        walk,
      );
  if (dynamic) {
    const directives = keys.filter(isDirective);
    if (directives.length > 0)
      checkDirective(
        value as Record<string, unknown>,
        directives,
        path,
        depth,
        walk,
      );
  }
  for (const [key, inner] of Object.entries(value)) {
    // A call's arguments are values that may themselves be bound; a binding's path is a string.
    checkValue(inner, pointer(path, key), depth + 1, walk, dynamic);
  }
}

function checkDirective(
  value: Record<string, unknown>,
  directives: readonly string[],
  path: string,
  depth: number,
  walk: Walk,
): void {
  if (directives.includes('@path')) {
    if (Object.keys(value).length !== 1)
      fail(
        'VALIDATION_FAILED',
        'a binding is { "@path": "<JSON Pointer>" } and nothing else',
        path,
        walk,
      );
    checkString(value['@path'], pointer(path, '@path'), walk, 2_048);
    return;
  }
  if (directives.includes('@call')) {
    const extra = Object.keys(value).find(
      (key) => !['@call', 'args', 'catalogId'].includes(key),
    );
    if (extra !== undefined)
      fail(
        'VALIDATION_FAILED',
        `a function call takes "@call", "args" and "catalogId"; "${extra}" is not one of them`,
        pointer(path, extra),
        walk,
      );
    checkString(value['@call'], pointer(path, '@call'), walk, 128);
    if (value['args'] !== undefined && !isRecord(value['args']))
      fail(
        'VALIDATION_FAILED',
        'args must be an object',
        pointer(path, 'args'),
        walk,
      );
    if (value['catalogId'] !== undefined)
      checkString(value['catalogId'], pointer(path, 'catalogId'), walk);
    void depth;
    return;
  }
  fail(
    'VALIDATION_FAILED',
    `"${directives[0]}" is not an A2UI directive — a literal key starting with "@" is written "@${directives[0]}"`,
    pointer(path, directives[0] as string),
    walk,
  );
}

function checkComponents(raw: unknown, path: string, walk: Walk): void {
  if (!Array.isArray(raw) || raw.length === 0)
    return fail(
      'VALIDATION_FAILED',
      'components must be a non-empty array',
      path,
      walk,
    );
  if (raw.length > A2UI_LIMITS.components)
    fail(
      'VALIDATION_FAILED',
      `a message may carry at most ${A2UI_LIMITS.components} components`,
      path,
      walk,
    );
  const ids = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const at = pointer(path, index);
    const component = raw[index];
    if (!isRecord(component))
      return fail(
        'VALIDATION_FAILED',
        'a component must be an object',
        at,
        walk,
      );
    const id = checkString(component['id'], pointer(at, 'id'), walk, 128);
    if (ids.has(id))
      fail(
        'VALIDATION_FAILED',
        `the component id "${id}" appears twice in one message`,
        pointer(at, 'id'),
        walk,
      );
    ids.add(id);
    const type = checkString(
      component['component'],
      pointer(at, 'component'),
      walk,
      128,
    );
    if (type === 'Surface')
      fail(
        'VALIDATION_FAILED',
        '"Surface" is the implicit container of every surface, not a component an agent can send',
        pointer(at, 'component'),
        walk,
      );
    for (const key of Object.keys(component)) {
      if (RESERVED_KEYS.has(key))
        fail(
          'VALIDATION_FAILED',
          `uses the reserved key "${key}"`,
          pointer(at, key),
          walk,
        );
      if (
        isDirective(key) &&
        !(COMPONENT_ENVELOPE_KEYS as readonly string[]).includes(key)
      )
        fail(
          'VALIDATION_FAILED',
          `"${key}" is not a component envelope key (${COMPONENT_ENVELOPE_KEYS.join(', ')}); a literal prop starting with "@" is written "@${key}"`,
          pointer(at, key),
          walk,
        );
    }
    if (component['@catalogId'] !== undefined)
      checkString(component['@catalogId'], pointer(at, '@catalogId'), walk);
    for (const [key, value] of Object.entries(component)) {
      if (key === 'id' || key === 'component' || key === '@catalogId') continue;
      checkValue(value, pointer(at, key), 1, walk, true);
    }
  }
}

/**
 * Validates one agent-to-renderer message, as `JSON.parse` gives it. Throws {@link A2uiError}.
 */
export function parseA2uiMessage(raw: unknown): A2uiMessage {
  const walk: { surfaceId?: string; values: number } = {
    values: A2UI_LIMITS.values,
  };
  if (!isRecord(raw))
    return fail('VALIDATION_FAILED', 'a message must be an object', '', walk);
  const kinds = Object.keys(raw).filter((key) => key !== 'version');
  if (raw['version'] !== A2UI_VERSION)
    fail(
      'VALIDATION_FAILED',
      `version must be "${A2UI_VERSION}"${typeof raw['version'] === 'string' ? `, got "${raw['version'].slice(0, 16)}"` : ''} — this reader understands A2UI v1.0`,
      '/version',
      walk,
    );
  if (
    kinds.length !== 1 ||
    !(KINDS as readonly string[]).includes(kinds[0] as string)
  )
    fail(
      'VALIDATION_FAILED',
      `a message carries exactly one of ${KINDS.join(', ')}${kinds.length > 0 ? `; this one has ${kinds.slice(0, 3).join(', ')}` : ''}`,
      kinds.length === 1 ? `/${kinds[0]}` : '',
      walk,
    );
  const kind = kinds[0] as A2uiMessageKind;
  const body = raw[kind];
  if (!isRecord(body))
    return fail('VALIDATION_FAILED', `${kind} must be an object`, '', walk);
  if (typeof body['surfaceId'] === 'string') walk.surfaceId = body['surfaceId'];

  switch (kind) {
    case 'createSurface': {
      onlyKeys(
        body,
        [
          'surfaceId',
          'catalogId',
          'sendDataModel',
          'components',
          'dataModel',
          'metadata',
        ],
        '',
        walk,
        {
          theme:
            '"theme" was removed in A2UI v1.0: a surface follows its host\'s styling',
        },
      );
      checkString(body['surfaceId'], '/surfaceId', walk);
      if (body['catalogId'] !== undefined)
        checkString(body['catalogId'], '/catalogId', walk);
      if (
        body['sendDataModel'] !== undefined &&
        typeof body['sendDataModel'] !== 'boolean'
      )
        fail(
          'VALIDATION_FAILED',
          'sendDataModel must be a boolean',
          '/sendDataModel',
          walk,
        );
      if (body['components'] !== undefined)
        checkComponents(body['components'], '/components', walk);
      if (body['dataModel'] !== undefined) {
        if (!isRecord(body['dataModel']))
          fail(
            'VALIDATION_FAILED',
            'dataModel must be an object',
            '/dataModel',
            walk,
          );
        checkValue(body['dataModel'], '/dataModel', 0, walk, false);
      }
      if (body['metadata'] !== undefined) {
        if (!isRecord(body['metadata']))
          fail(
            'VALIDATION_FAILED',
            'metadata must be an object',
            '/metadata',
            walk,
          );
        onlyKeys(
          body['metadata'] as Record<string, unknown>,
          ['extensions'],
          '/metadata',
          walk,
        );
        checkValue(body['metadata'], '/metadata', 0, walk, false);
      }
      break;
    }
    case 'updateComponents':
      onlyKeys(body, ['surfaceId', 'components'], '', walk);
      checkString(body['surfaceId'], '/surfaceId', walk);
      checkComponents(body['components'], '/components', walk);
      break;
    case 'updateDataModel':
      onlyKeys(body, ['surfaceId', 'path', 'value'], '', walk);
      checkString(body['surfaceId'], '/surfaceId', walk);
      if (body['path'] !== undefined) {
        if (typeof body['path'] !== 'string' || body['path'].length > 2_048)
          fail(
            'VALIDATION_FAILED',
            'path must be a JSON Pointer',
            '/path',
            walk,
          );
        parsePointer(body['path'] as string, '/path', walk);
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'value'))
        fail(
          'VALIDATION_FAILED',
          'value is required — send null to delete what is at path',
          '/value',
          walk,
        );
      checkValue(body['value'], '/value', 0, walk, false);
      break;
    case 'deleteSurface':
      onlyKeys(body, ['surfaceId'], '', walk);
      checkString(body['surfaceId'], '/surfaceId', walk);
      break;
    case 'callRendererFunction': {
      onlyKeys(body, ['functionCallId', 'surfaceId', 'callFunction'], '', walk);
      checkString(body['functionCallId'], '/functionCallId', walk);
      if (body['surfaceId'] !== undefined)
        checkString(body['surfaceId'], '/surfaceId', walk);
      const call = body['callFunction'];
      if (!isRecord(call) || typeof call['@call'] !== 'string')
        fail(
          'VALIDATION_FAILED',
          'callFunction must be a function call',
          '/callFunction',
          walk,
        );
      if (typeof (call as Record<string, unknown>)['catalogId'] !== 'string')
        fail(
          'VALIDATION_FAILED',
          'callFunction must name its catalogId',
          '/callFunction/catalogId',
          walk,
        );
      checkValue(call, '/callFunction', 0, walk, true);
      break;
    }
    case 'agentFunctionResponse':
      checkFunctionResponse(body, walk);
      break;
  }
  return raw as unknown as A2uiMessage;
}

function checkFunctionResponse(
  body: Record<string, unknown>,
  walk: Walk,
): void {
  onlyKeys(body, ['functionCallId', 'value', 'error'], '', walk);
  checkString(body['functionCallId'], '/functionCallId', walk);
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key);
  if (has('value') === has('error'))
    fail(
      'VALIDATION_FAILED',
      'a function response carries exactly one of value and error',
      '',
      walk,
    );
  if (has('error')) {
    const error = body['error'];
    if (
      !isRecord(error) ||
      typeof error['code'] !== 'string' ||
      typeof error['message'] !== 'string'
    )
      fail(
        'VALIDATION_FAILED',
        'error must be { code, message }',
        '/error',
        walk,
      );
  }
  checkValue(body, '', 0, walk, false);
}

/**
 * Reads a JSON Pointer (RFC 6901) into its segments. `''` and `'/'` are the whole document. A
 * reserved segment is refused: a pointer is used to write into the data model.
 */
export function parsePointer(
  path: string,
  where = '/path',
  walk: Walk = { values: 0 },
): string[] {
  if (path === '' || path === '/') return [];
  if (!path.startsWith('/'))
    return fail(
      'VALIDATION_FAILED',
      `"${path.slice(0, 40)}" is not a JSON Pointer — it must start with "/"`,
      where,
      walk,
    );
  const segments = path
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length > A2UI_LIMITS.depth)
    fail(
      'VALIDATION_FAILED',
      `the pointer has more than ${A2UI_LIMITS.depth} segments`,
      where,
      walk,
    );
  const reserved = segments.find((segment) => RESERVED_KEYS.has(segment));
  if (reserved !== undefined)
    fail(
      'VALIDATION_FAILED',
      `the pointer uses the reserved segment "${reserved}"`,
      where,
      walk,
    );
  return segments;
}

/**
 * Reads a stream of messages: JSON Lines (one message per line, blank lines ignored), or one JSON
 * array of messages. Throws {@link A2uiError} naming the line, or the index, that failed.
 */
export function parseA2uiStream(text: string): A2uiMessage[] {
  const walk: Walk = { values: 0 };
  if (text.length > A2UI_LIMITS.messageChars * 8)
    fail(
      'VALIDATION_FAILED',
      'the stream is too large to read at once',
      '',
      walk,
    );
  const trimmed = text.trimStart();
  const raws: { raw: unknown; at: string }[] = [];
  const read = (source: string, at: string): unknown => {
    try {
      return JSON.parse(source);
    } catch {
      return fail('VALIDATION_FAILED', `${at} is not JSON`, '', walk);
    }
  };
  if (trimmed.startsWith('[')) {
    const list = read(trimmed, 'the stream');
    if (!Array.isArray(list))
      return fail(
        'VALIDATION_FAILED',
        'the stream is not an array of messages',
        '',
        walk,
      );
    list.forEach((raw, index) => raws.push({ raw, at: `message ${index}` }));
  } else {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      if (line.length > A2UI_LIMITS.messageChars)
        fail(
          'VALIDATION_FAILED',
          `line ${index + 1} is longer than ${A2UI_LIMITS.messageChars} characters`,
          '',
          walk,
        );
      raws.push({
        raw: read(line, `line ${index + 1}`),
        at: `line ${index + 1}`,
      });
    });
  }
  if (raws.length > A2UI_LIMITS.messages)
    fail(
      'VALIDATION_FAILED',
      `the stream holds more than ${A2UI_LIMITS.messages} messages`,
      '',
      walk,
    );
  return raws.map(({ raw, at }) => {
    try {
      return parseA2uiMessage(raw);
    } catch (error) {
      if (error instanceof A2uiError)
        throw new A2uiError(
          error.code,
          `${at}: ${error.message}`,
          error.path,
          error.surfaceId,
        );
      throw error;
    }
  });
}

/** Messages as JSON Lines, the form {@link parseA2uiStream} reads and `prerender` writes. */
export function toJsonLines(messages: readonly unknown[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
}

/** A renderer's `error` message for a refused message or a failed update. */
export function errorMessage(error: A2uiError): A2uiRendererMessage {
  const validation =
    error.code === 'VALIDATION_FAILED' ||
    error.code === 'UNALLOWED_PARENT' ||
    error.code === 'UNALLOWED_CHILD';
  return {
    version: '1.0',
    error: {
      code: error.code,
      message: error.message,
      ...(error.surfaceId !== undefined
        ? { surfaceId: error.surfaceId }
        : { surfaceId: '' }),
      ...(validation ? { path: error.path } : {}),
    },
  };
}
