import type { SduiCatalog } from '../lib/catalog.js';
import { A2UI_BASIC_CATALOG_ID } from '../a2ui/basic.js';
import {
  A2UI_LIMITS,
  A2uiError,
  type A2uiMessage,
  type A2uiRendererMessage,
  errorMessage,
  messageKind,
  parseA2uiMessage,
  parseA2uiStream,
} from '../a2ui/messages.js';
import { A2uiSurfaces } from '../a2ui/surfaces.js';
import { patchChildren } from './dom.js';
import {
  DRAW_LIMITS,
  DrawBudget,
  type HostFunction,
  type UrlPolicy,
  checkUrl,
  createEvaluator,
} from './evaluate.js';
import { type ComponentRegistry, drawSafely, renderSurface } from './render.js';

/**
 * `<a2ui-surface>` — an A2UI renderer that draws into the host's own page.
 *
 * It renders in light DOM: the surfaces are part of the host's document, laid out by its CSS, read
 * by its accessibility tree, styled by its stylesheet. Component types can be the host's own (a
 * custom element, or a Braid fragment from another team) through the registry.
 *
 * Messages come from a prerendered `<script type="application/a2ui+json">` inside it, from `src`
 * (JSON Lines, or server-sent events whose `data:` lines are messages), or from `push()`. What it
 * sends back — actions, and errors — is dispatched as a cancelable `a2ui:message` event, and, unless
 * a listener cancels it, POSTed to `action-url` as `{ message, metadata }`, where `metadata` holds
 * `a2uiRendererCapabilities` and, for an action on a surface created with `sendDataModel`,
 * `a2uiRendererDataModel`.
 *
 * Attributes: `src`, `action-url`, `catalog-ids` (space-separated; the basic catalog by default),
 * `locale`, `time-zone`.
 */

export interface A2uiSurfaceOptions {
  readonly tag?: string;
  readonly registry?: ComponentRegistry;
  /** For which props of custom components are children and actions. */
  readonly catalog?: SduiCatalog;
  readonly urlPolicy?: UrlPolicy;
  readonly functions?: Readonly<Record<string, HostFunction>>;
}

export interface A2uiSurfaceElement extends HTMLElement {
  /** Applies messages, parsed or as text (JSON Lines or an array). */
  push(messages: string | readonly unknown[]): void;
  readonly surfaces: A2uiSurfaces;
  /** What this renderer declares: `{ "1.0": { supportedCatalogIds } }`. */
  readonly capabilities: {
    readonly '1.0': { readonly supportedCatalogIds: readonly string[] };
  };
  registry: ComponentRegistry;
}

/** The header `src` is fetched with: the renderer's capabilities, as JSON. */
export const CAPABILITIES_HEADER = 'A2UI-Renderer-Capabilities';

/** Errors an element sends the agent per draw; the rest of a flood is dropped. */
export const MAX_ERRORS_PER_DRAW = 10;

/**
 * How much an element tells the agent, however much is wrong: a burst of errors, then a few a
 * second; each error's message cut to a length; and a stream (or an answer to an action) that has
 * had this many messages refused is hung up on — it is not going to start making sense.
 */
export const ERROR_LIMITS = Object.freeze({
  burst: 20,
  perSecond: 2,
  message: 1_000,
  refusedPerStream: 100,
});

/**
 * How often an agent may have the renderer run a function and answer it: a burst, then a few a
 * second. Each answer is a request to the agent, and an agent's reply can ask for more, so past
 * this a call is refused — and a stream of refused calls is hung up on like any other.
 */
export const CALL_LIMITS = Object.freeze({ burst: 20, perSecond: 5 });

/** A refill-at-a-rate counter: `take()` is false once the burst is spent, until it refills. */
class Bucket {
  #tokens: number;
  #at = now();
  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {
    this.#tokens = burst;
  }
  take(): boolean {
    const at = now();
    this.#tokens = Math.min(
      this.burst,
      this.#tokens + ((at - this.#at) / 1_000) * this.perSecond,
    );
    this.#at = at;
    if (this.#tokens < 1) return false;
    this.#tokens--;
    return true;
  }
}

/** Milliseconds of messages an element applies before it lets the page run. */
const SLICE_MS = 8;
/** Characters of one POST: past this, an action goes without its surface's data model. */
const MAX_POST_CHARS = 4_000_000;
/** Milliseconds a draw's layout may take before the element draws less text. */
const LAYOUT_MS = 100;

const now = (): number => performance.now();
const yieldToPage = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Where messages come from, and how to stop it: a stream, an action's answer, or `push()`. */
interface Origin {
  refused: number;
  readonly hangUp?: () => void;
  /** True once whatever this came from has been replaced or closed: the rest is not applied. */
  readonly stopped?: () => boolean;
}

/** `text` cut to `length` characters, not through the middle of a surrogate pair. */
function cut(text: string, length: number): string {
  if (text.length <= length) return text;
  const end = /[\uD800-\uDBFF]/.test(text[length - 1] ?? '')
    ? length - 1
    : length;
  return `${text.slice(0, end)}…`;
}

/** Defines the element (once). Nothing is defined on import: call this in the browser. */
export function defineA2uiSurface(
  options: A2uiSurfaceOptions = {},
): CustomElementConstructor {
  const tag = options.tag ?? 'a2ui-surface';
  const existing = customElements.get(tag);
  if (existing) return existing;

  class Surface extends HTMLElement implements A2uiSurfaceElement {
    readonly surfaces = new A2uiSurfaces();
    registry: ComponentRegistry = options.registry ?? {};
    readonly #local = new Map<string, Map<string, unknown>>();
    #budget = new DrawBudget();
    #reportedThisDraw = 0;
    readonly #evaluators = new Map<
      string,
      ReturnType<typeof createEvaluator>
    >();
    #scheduled = false;
    #abort: AbortController | null = null;
    #reported = new Set<string>();
    /** How long the last draw took: the next one waits at least as long. */
    #lastDrawMs = 0;
    /** The share of `DRAW_LIMITS.chars` this element's draws may use: less after slow layouts. */
    #textScale = 1;
    readonly #errors = new Bucket(ERROR_LIMITS.burst, ERROR_LIMITS.perSecond);
    readonly #calls = new Bucket(CALL_LIMITS.burst, CALL_LIMITS.perSecond);

    static get observedAttributes() {
      return ['src'];
    }

    get capabilities() {
      const ids = (this.getAttribute('catalog-ids') ?? A2UI_BASIC_CATALOG_ID)
        .split(/\s+/)
        .filter(Boolean);
      return { '1.0': { supportedCatalogIds: ids } } as const;
    }

    connectedCallback(): void {
      const script = this.querySelector(
        ':scope > script[type="application/a2ui+json"]',
      );
      if (script) {
        const text = script.textContent ?? '[]';
        script.remove();
        this.#push(text, true);
        this.#draw(); // at once: the prerendered markup is adopted in this task, not the next
      } else if (this.surfaces.ids().length > 0) this.#schedule(); // pushed while detached
      this.#load();
    }

    disconnectedCallback(): void {
      this.#abort?.abort();
    }

    attributeChangedCallback(): void {
      if (this.isConnected) this.#load();
    }

    push(messages: string | readonly unknown[]): void {
      this.#push(messages, false);
    }

    /**
     * Messages from the host, as a list or text. Applied through the queue, a little at a time,
     * like a stream's — or, for the prerendered messages adopted as the element connects, at once.
     */
    #push(messages: string | readonly unknown[], now: boolean): void {
      const origin: Origin = { refused: 0 };
      const steps: (() => void)[] = [];
      if (typeof messages !== 'string')
        for (const raw of messages) steps.push(() => this.#take(raw, origin));
      else if (messages.trimStart().startsWith('[')) {
        let list: readonly unknown[] = [];
        try {
          list = parseA2uiStream(messages);
        } catch (error) {
          this.#refuse(error, origin);
        }
        for (const raw of list) steps.push(() => this.#take(raw, origin));
      } else
        for (const line of messages.split(/\r?\n/))
          steps.push(() => this.#line(line, origin));
      if (now) {
        for (const step of steps) {
          if (origin.refused > ERROR_LIMITS.refusedPerStream) break;
          step();
        }
        return;
      }
      void this.#enqueue(steps, origin);
    }

    /** JSON Lines from a stream or an action's answer, through the queue; resolves once applied. */
    #feed(lines: Iterable<string>, origin: Origin): Promise<void> {
      const steps: (() => void)[] = [];
      for (const line of lines) steps.push(() => this.#line(line, origin));
      return this.#enqueue(steps, origin);
    }

    /** Work waiting to be applied, in arrival order: a message or a line each. */
    #queue: { readonly step: () => void; readonly origin: Origin | null }[] =
      [];
    #head = 0;
    #pumping = false;

    #enqueue(steps: readonly (() => void)[], origin: Origin): Promise<void> {
      for (const step of steps) this.#queue.push({ step, origin });
      const applied = new Promise<void>((resolve) =>
        this.#queue.push({ step: resolve, origin: null }),
      );
      void this.#pump();
      return applied;
    }

    /**
     * Applies what is queued, letting the page run every few milliseconds: a million lines, or one
     * `push()` of many large messages, is a busy surface, not a frozen page. It starts in the task
     * that queued the work, so a small push is applied before `push()` returns.
     */
    async #pump(): Promise<void> {
      if (this.#pumping) return;
      this.#pumping = true;
      let slice = now();
      try {
        while (this.#head < this.#queue.length) {
          const { step, origin } = this.#queue[this.#head++]!;
          const stopped =
            origin !== null &&
            (origin.stopped?.() === true ||
              origin.refused > ERROR_LIMITS.refusedPerStream);
          if (!stopped) step();
          if (now() - slice > SLICE_MS) {
            this.#schedule();
            await yieldToPage();
            slice = now();
          }
        }
        this.#queue = [];
        this.#head = 0;
      } finally {
        this.#pumping = false;
        // what was applied is drawn, however it ended
        this.#schedule();
      }
    }

    /** One line of JSON Lines: one bad line is one error, not the loss of its neighbours. */
    #line(line: string, origin: Origin): void {
      if (line.trim() === '') return;
      // A line is a message, or a list of them, of at most one message's length.
      if (line.length > A2UI_LIMITS.messageChars) {
        this.#refuse(
          new A2uiError(
            'VALIDATION_FAILED',
            `a line is longer than ${A2UI_LIMITS.messageChars} characters`,
            '',
          ),
          origin,
        );
        return;
      }
      let list: readonly unknown[] = [];
      try {
        list = parseA2uiStream(line);
      } catch (error) {
        this.#refuse(error, origin);
      }
      for (const raw of list) this.#take(raw, origin);
    }

    #take(raw: unknown, origin: Origin): void {
      try {
        this.#accept(parseA2uiMessage(raw));
      } catch (error) {
        this.#refuse(error, origin);
      }
    }

    #refuse(error: unknown, origin: Origin): void {
      if (!(error instanceof A2uiError)) throw error;
      this.#send(errorMessage(error));
      if (++origin.refused === ERROR_LIMITS.refusedPerStream + 1) {
        origin.hangUp?.();
        this.#send(
          errorMessage(
            new A2uiError(
              'VALIDATION_FAILED',
              `more than ${ERROR_LIMITS.refusedPerStream} messages were refused; the renderer stopped reading the rest`,
              '',
            ),
          ),
          true,
        );
      }
    }

    #accept(message: A2uiMessage): void {
      if (messageKind(message) === 'createSurface') {
        const catalogId = (
          message as Extract<A2uiMessage, { createSurface: unknown }>
        ).createSurface.catalogId;
        const supported = this.capabilities['1.0'].supportedCatalogIds;
        if (catalogId !== undefined && !supported.includes(catalogId))
          throw new A2uiError(
            'VALIDATION_FAILED',
            `this renderer supports ${supported.join(', ')}, not "${catalogId}"`,
            '/catalogId',
            (
              message as Extract<A2uiMessage, { createSurface: unknown }>
            ).createSurface.surfaceId,
          );
      }
      if (messageKind(message) === 'callRendererFunction') {
        const body = (
          message as Extract<A2uiMessage, { callRendererFunction: unknown }>
        ).callRendererFunction;
        const surface = body.surfaceId
          ? this.surfaces.get(body.surfaceId)
          : undefined;
        if (!this.#calls.take())
          throw new A2uiError(
            'VALIDATION_FAILED',
            `the agent asks for renderer functions more often than ${CALL_LIMITS.perSecond} a second`,
            '/callRendererFunction',
            body.surfaceId,
          );
        const failures: string[] = [];
        // A call of its own, with a budget of its own: nothing a draw left over or ran out of.
        this.#budget = new DrawBudget({ ms: DRAW_LIMITS.ms });
        const evaluator = this.#evaluator(
          surface?.id ?? '',
          () => surface?.dataModel ?? {},
          (error) => failures.push(error.message),
        );
        const value = evaluator.value(body.callFunction);
        this.#send({
          version: '1.0',
          rendererFunctionResponse: failures.length
            ? {
                functionCallId: body.functionCallId,
                error: {
                  code: 'EXPRESSION_ERROR',
                  message: failures[0] as string,
                },
              }
            : {
                functionCallId: body.functionCallId,
                // a copy: a value read from the data model changes with it
                value:
                  value === null || value === undefined
                    ? null
                    : structuredClone(value),
              },
        });
        return;
      }
      const applied = this.surfaces.apply(message);
      if (applied.kind === 'deleteSurface' && applied.surfaceId) {
        this.#local.delete(applied.surfaceId);
        this.#evaluators.delete(applied.surfaceId);
      }
    }

    /** One evaluator per surface, kept between draws: its compiled patterns are worth keeping. */
    #evaluatorFor(id: string) {
      let evaluator = this.#evaluators.get(id);
      if (!evaluator) {
        evaluator = this.#evaluator(
          id,
          () => this.surfaces.get(id)?.dataModel ?? {},
        );
        this.#evaluators.set(id, evaluator);
      }
      return evaluator;
    }

    #evaluator(
      surfaceId: string,
      model: () => unknown,
      report?: (error: { code: string; message: string }) => void,
    ) {
      return createEvaluator({
        model,
        // One budget for everything between draws: every surface, every function call.
        budget: () => this.#budget,
        locale:
          this.getAttribute('locale') ??
          (this.ownerDocument.documentElement.lang || undefined),
        timeZone: this.getAttribute('time-zone') ?? undefined,
        urlPolicy: options.urlPolicy,
        functions: options.functions,
        openUrl: (url) => {
          if (checkUrl(url, 'link', options.urlPolicy).ok)
            this.ownerDocument.defaultView?.open(
              url,
              '_blank',
              'noopener,noreferrer',
            );
        },
        report: report ?? ((error) => this.#problem(surfaceId, error)),
      });
    }

    #problem(
      surfaceId: string,
      error: { code: string; message: string; path?: string },
    ): void {
      // Reported once per surface: a broken binding is not a message per keystroke.
      const key = `${surfaceId}\u0000${error.code}\u0000${error.message.slice(0, ERROR_LIMITS.message)}`;
      if (this.#reported.has(key)) return;
      // And a few per draw: content can make every one of a thousand checks fail differently,
      // and the agent needs to hear that something is wrong, not a thousand times.
      if (++this.#reportedThisDraw > MAX_ERRORS_PER_DRAW) return;
      if (this.#reported.size > 1_000) this.#reported.clear();
      const validation =
        error.code === 'VALIDATION_FAILED' ||
        error.code === 'UNALLOWED_PARENT' ||
        error.code === 'UNALLOWED_CHILD';
      const sent = this.#send({
        version: '1.0',
        error: {
          code: error.code,
          message: error.message,
          surfaceId,
          ...(validation ? { path: error.path ?? '' } : {}),
        },
      });
      // Only what was told counts as told: one the limiter dropped may be told later.
      if (sent) this.#reported.add(key);
    }

    /**
     * A draw in a task of its own, after whatever scheduled it: messages arriving together are
     * drawn once. A draw that took long is not followed at once by another — the page gets at
     * least as long to itself as the last draw took.
     */
    #schedule(): void {
      if (this.#scheduled) return;
      this.#scheduled = true;
      setTimeout(
        () => {
          this.#scheduled = false;
          if (this.isConnected) this.#draw();
        },
        this.#lastDrawMs > 16 ? Math.min(this.#lastDrawMs, 500) : 0,
      );
    }

    #draw(): void {
      const started = now();
      this.#budget = new DrawBudget({
        ms: DRAW_LIMITS.ms,
        textLimit: DRAW_LIMITS.chars * this.#textScale,
        // not only text lays out slowly: a page that did draws fewer components too
        drawLimit: Math.max(
          50,
          Math.floor(DRAW_LIMITS.draws * this.#textScale),
        ),
      });
      this.#reportedThisDraw = 0;
      const views = this.surfaces.ids().map((id) => {
        const surface = this.surfaces.get(id)!;
        let local = this.#local.get(id);
        if (!local) this.#local.set(id, (local = new Map()));
        return drawSafely(
          id,
          (error) => this.#problem(id, error),
          () =>
            renderSurface(surface, {
              registry: this.registry,
              catalog: options.catalog,
              evaluator: this.#evaluatorFor(id),
              urlPolicy: options.urlPolicy,
              dispatch: (message) => this.#send(message),
              write: (pointer, value) => {
                try {
                  this.surfaces.write(id, pointer, value);
                } catch (error) {
                  if (error instanceof A2uiError) this.#problem(id, error);
                }
                this.#schedule();
              },
              report: (error) => this.#problem(id, error),
              local,
              redraw: () => this.#schedule(),
            }),
        );
      });
      // Each surface's container is matched by its key, prerendered or not.
      patchChildren(this, views);
      this.#lastDrawMs = now() - started;
      // Laying the page out comes after, and is the browser's: it is timed from here to the next
      // frame, and a draw whose layout ran long is followed by as long a pause.
      const drawn = now();
      requestAnimationFrame(() =>
        setTimeout(() => {
          const layout = now() - drawn;
          // a frame's own wait is not layout
          if (layout > 50 && layout > this.#lastDrawMs)
            this.#lastDrawMs = layout;
          // Text priced too cheaply shows here: the next draw may lay out less of it, and the
          // limit comes back as the page does.
          if (layout > LAYOUT_MS)
            this.#textScale = Math.max(
              0.0005,
              (this.#textScale * LAYOUT_MS) / layout,
            );
          // and comes back slowly: a limit that recovers at once lets the same slow text back
          // in a draw or two later
          else if (layout < LAYOUT_MS / 4)
            this.#textScale = Math.min(1, this.#textScale * 1.1);
        }, 0),
      );
      // What runs between draws — a click, a check — gets a budget of its own, with no deadline:
      // the draw's ended with it.
      this.#budget = new DrawBudget();
      this.dispatchEvent(new CustomEvent('a2ui:render', { bubbles: true }));
    }

    /** Sends a message; `false` when the error limiter dropped it. */
    #send(message: A2uiRendererMessage, always = false): boolean {
      if ('error' in message && message.error) {
        if (!always && !this.#errors.take()) return false;
        if (message.error.message.length > ERROR_LIMITS.message)
          message = {
            ...message,
            error: {
              ...message.error,
              message: cut(message.error.message, ERROR_LIMITS.message),
            },
          };
      }
      const event = new CustomEvent('a2ui:message', {
        detail: message,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      if (!this.dispatchEvent(event)) return true;
      const url = this.getAttribute('action-url');
      if (!url) return true;
      // The data model of the surface a person acted on, when that surface asked for it to be
      // sent. Only with an action: an error or a function's answer is the agent's own doing, and
      // writing out a large model for each would let it make the page do that as often as it likes.
      const dataModels: Record<string, unknown> = {};
      const acted = (message as { action?: { surfaceId?: string } }).action
        ?.surfaceId;
      const surface = acted ? this.surfaces.get(acted) : undefined;
      if (surface?.sendDataModel) dataModels[surface.id] = surface.dataModel;
      const body = (withModel: boolean) =>
        JSON.stringify({
          message,
          metadata: {
            a2uiRendererCapabilities: this.capabilities,
            ...(withModel && Object.keys(dataModels).length > 0
              ? { a2uiRendererDataModel: dataModels }
              : {}),
          },
        });
      let text = body(true);
      // Written out, a data model can be several times its characters (a control character is
      // six); past this the message goes without it.
      if (text.length > MAX_POST_CHARS) text = body(false);
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: text,
      })
        .then((response) => (response.ok ? response.text() : ''))
        .then((text) => {
          // An agent may answer an action with more messages, in the response.
          if (text.trim())
            return this.#feed(text.split(/\r?\n/), { refused: 0 });
        })
        .catch(() => undefined);
      return true;
    }

    #load(): void {
      const src = this.getAttribute('src');
      this.#abort?.abort();
      if (!src) return;
      const abort = (this.#abort = new AbortController());
      void (async () => {
        const response = await fetch(src, {
          headers: {
            accept: 'application/jsonl, text/event-stream, application/json',
            [CAPABILITIES_HEADER]: JSON.stringify(this.capabilities),
          },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) return;
        const sse = (response.headers.get('content-type') ?? '').includes(
          'text/event-stream',
        );
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        const origin: Origin = {
          refused: 0,
          hangUp: () => abort.abort(),
          stopped: () => abort.signal.aborted,
        };
        let slice = now();
        let buffer = '';
        let event: string[] = [];
        let eventLength = 0;
        const tooLong = (): void => {
          abort.abort();
          this.#send(
            errorMessage(
              new A2uiError(
                'VALIDATION_FAILED',
                `a line of the stream is longer than ${A2UI_LIMITS.messageChars} characters`,
                '',
              ),
            ),
          );
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buffer += value;
          // A chunk with no line end only lengthens the line: no need to split it all again.
          if (!done && value && !value.includes('\n')) {
            if (buffer.length > A2UI_LIMITS.messageChars) return tooLong();
            continue;
          }
          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() ?? '');
          if (buffer.length > A2UI_LIMITS.messageChars) return tooLong();
          if (!sse) {
            await this.#feed(lines, origin);
            if (abort.signal.aborted) return;
          } else {
            // An event is its data lines, joined; a blank line ends it.
            for (const line of [...lines, ...(done ? [''] : [])]) {
              const bare = line.replace(/\r$/, '');
              if (bare.startsWith('data:')) {
                const part = bare.slice(5).replace(/^ /, '');
                event.push(part);
                eventLength += part.length + 1;
                if (eventLength > A2UI_LIMITS.messageChars) return tooLong();
              } else if (bare === '' && event.length > 0) {
                const data = event.join('\n');
                event = [];
                eventLength = 0;
                if (data.length > A2UI_LIMITS.messageChars) return tooLong();
                let message: unknown;
                try {
                  message = JSON.parse(data);
                } catch {
                  this.#refuse(
                    new A2uiError(
                      'VALIDATION_FAILED',
                      'an event of the stream is not JSON',
                      '',
                    ),
                    origin,
                  );
                  if (abort.signal.aborted) return this.#schedule();
                  continue;
                }
                this.#take(message, origin);
                if (abort.signal.aborted) return this.#schedule();
                if (now() - slice > SLICE_MS) {
                  this.#schedule();
                  await yieldToPage();
                  slice = now();
                }
              }
            }
            this.#schedule();
          }
          if (done) break;
        }
      })().catch(() => undefined);
    }
  }

  customElements.define(tag, Surface);
  return Surface;
}
