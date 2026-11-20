import type { SduiCatalog } from '../lib/catalog.js';
import { A2UI_BASIC_CATALOG_ID } from '../a2ui/basic.js';
import {
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
  type HostFunction,
  type UrlPolicy,
  checkUrl,
  createEvaluator,
} from './evaluate.js';
import { type ComponentRegistry, renderSurface } from './render.js';

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
    #scheduled = false;
    #abort: AbortController | null = null;
    #reported = new Set<string>();

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
      }
      this.#load();
    }

    disconnectedCallback(): void {
      this.#abort?.abort();
    }

    attributeChangedCallback(): void {
      if (this.isConnected) this.#load();
    }

    push(messages: string | readonly unknown[]): void {
      let list: readonly unknown[];
      try {
        list =
          typeof messages === 'string' ? parseA2uiStream(messages) : messages;
      } catch (error) {
        if (error instanceof A2uiError) this.#send(errorMessage(error));
        return;
      }
      for (const raw of list) {
        try {
          const message = parseA2uiMessage(raw);
          this.#accept(message);
        } catch (error) {
          if (!(error instanceof A2uiError)) throw error;
          this.#send(errorMessage(error));
        }
      }
      this.#schedule();
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
            : { functionCallId: body.functionCallId, value: value ?? null },
        });
        return;
      }
      const applied = this.surfaces.apply(message);
      if (applied.kind === 'deleteSurface' && applied.surfaceId)
        this.#local.delete(applied.surfaceId);
    }

    #evaluator(
      surfaceId: string,
      model: () => unknown,
      report?: (error: { code: string; message: string }) => void,
    ) {
      return createEvaluator({
        model,
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
      const key = `${surfaceId}\u0000${error.code}\u0000${error.message}`;
      if (this.#reported.has(key)) return;
      this.#reported.add(key);
      const validation =
        error.code === 'VALIDATION_FAILED' ||
        error.code === 'UNALLOWED_PARENT' ||
        error.code === 'UNALLOWED_CHILD';
      this.#send({
        version: '1.0',
        error: {
          code: error.code,
          message: error.message,
          surfaceId,
          ...(validation ? { path: error.path ?? '' } : {}),
        },
      });
    }

    #schedule(): void {
      if (this.#scheduled) return;
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.#draw();
      });
    }

    #draw(): void {
      const views = this.surfaces.ids().map((id) => {
        const surface = this.surfaces.get(id)!;
        let local = this.#local.get(id);
        if (!local) this.#local.set(id, (local = new Map()));
        return renderSurface(surface, {
          registry: this.registry,
          catalog: options.catalog,
          evaluator: this.#evaluator(
            id,
            () => this.surfaces.get(id)?.dataModel ?? {},
          ),
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
        });
      });
      // Each surface's container is matched by its key, prerendered or not.
      patchChildren(this, views);
      this.dispatchEvent(new CustomEvent('a2ui:render', { bubbles: true }));
    }

    #send(message: A2uiRendererMessage): void {
      const event = new CustomEvent('a2ui:message', {
        detail: message,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      if (!this.dispatchEvent(event)) return;
      const url = this.getAttribute('action-url');
      if (!url) return;
      const dataModels: Record<string, unknown> = {};
      for (const id of this.surfaces.ids()) {
        const surface = this.surfaces.get(id)!;
        if (surface.sendDataModel) dataModels[id] = surface.dataModel;
      }
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
          if (text.trim()) this.push(text);
        })
        .catch(() => undefined);
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
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buffer += value;
          const lines = buffer.split('\n');
          buffer = done ? '' : (lines.pop() ?? '');
          const messages = lines
            .map((line) =>
              sse
                ? line.startsWith('data:')
                  ? line.slice(5).trim()
                  : ''
                : line.trim(),
            )
            .filter(Boolean);
          if (messages.length > 0) this.push(messages.join('\n'));
          if (done) break;
        }
      })().catch(() => undefined);
    }
  }

  customElements.define(tag, Surface);
  return Surface;
}
