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
 * `a2uiRendererCapabilities` and, for surfaces created with `sendDataModel`,
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

/** Milliseconds of messages an element applies before it lets the page run. */
const SLICE_MS = 8;

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
    #errorTokens: number = ERROR_LIMITS.burst;
    #errorsAt = now();

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
        this.push(text);
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
      const origin: Origin = {
        refused: 0,
        stopped: () => origin.refused > ERROR_LIMITS.refusedPerStream,
      };
      if (typeof messages !== 'string') {
        for (const raw of messages) {
          if (origin.stopped?.()) break;
          this.#take(raw, origin);
        }
      } else if (messages.trimStart().startsWith('[')) {
        let list: readonly unknown[] = [];
        try {
          list = parseA2uiStream(messages);
        } catch (error) {
          this.#refuse(error, origin);
        }
        for (const raw of list) {
          if (origin.stopped?.()) break;
          this.#take(raw, origin);
        }
      } else
        for (const line of messages.split(/\r?\n/)) {
          if (origin.stopped?.()) break;
          this.#line(line, origin);
        }
      this.#schedule();
    }

    /**
     * JSON Lines a little at a time, letting the page run between slices: a stream of a million
     * lines is a busy surface, not a frozen page.
     */
    async #feed(lines: Iterable<string>, origin: Origin): Promise<void> {
      let slice = now();
      try {
        for (const line of lines) {
          if (origin.stopped?.()) return;
          if (origin.refused > ERROR_LIMITS.refusedPerStream) return;
          this.#line(line, origin);
          if (now() - slice > SLICE_MS) {
            this.#schedule();
            await yieldToPage();
            slice = now();
          }
        }
      } finally {
        // what was applied is drawn, however the feed ended
        this.#schedule();
      }
    }

    /** One line of JSON Lines: one bad line is one error, not the loss of its neighbours. */
    #line(line: string, origin: Origin): void {
      if (line.trim() === '') return;
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
        const failures: string[] = [];
        // A call of its own, with a budget of its own: nothing a draw left over or ran out of.
        this.#budget = new DrawBudget();
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
      this.#budget = new DrawBudget({ ms: DRAW_LIMITS.ms });
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
      // What runs between draws — a click, a check — gets a budget of its own, with no deadline:
      // the draw's ended with it.
      this.#budget = new DrawBudget();
      this.dispatchEvent(new CustomEvent('a2ui:render', { bubbles: true }));
    }

    /** Whether one more error may go out: a burst, then a few a second. */
    #mayReport(): boolean {
      const at = now();
      this.#errorTokens = Math.min(
        ERROR_LIMITS.burst,
        this.#errorTokens +
          ((at - this.#errorsAt) / 1_000) * ERROR_LIMITS.perSecond,
      );
      this.#errorsAt = at;
      if (this.#errorTokens < 1) return false;
      this.#errorTokens--;
      return true;
    }

    /** Sends a message; `false` when the error limiter dropped it. */
    #send(message: A2uiRendererMessage, always = false): boolean {
      if ('error' in message && message.error) {
        if (!always && !this.#mayReport()) return false;
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
      // The data model of the surface the message is about, when that surface asked for it to
      // be sent — not every surface's, on every message.
      const dataModels: Record<string, unknown> = {};
      const about =
        (
          message as {
            action?: { surfaceId?: string };
            error?: { surfaceId?: string };
          }
        ).action?.surfaceId ??
        (message as { error?: { surfaceId?: string } }).error?.surfaceId;
      const surface = about ? this.surfaces.get(about) : undefined;
      if (surface?.sendDataModel) dataModels[surface.id] = surface.dataModel;
      void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          metadata: {
            a2uiRendererCapabilities: this.capabilities,
            ...(Object.keys(dataModels).length > 0
              ? { a2uiRendererDataModel: dataModels }
              : {}),
          },
        }),
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
