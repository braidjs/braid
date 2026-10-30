import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { createGateway, type GatewayOptions } from '../libs/braid-gateway/src/index.js';
import { toNodeMiddleware } from '../libs/braid-gateway/src/node.js';

const root = fileURLToPath(new URL('..', import.meta.url));

let coreBundle: Promise<string> | undefined;

/** `@braidlabs/core` from source, as one ES module the page imports from `/core.js`. */
function bundleCore(): Promise<string> {
  coreBundle ??= build({
    entryPoints: [`${root}libs/core/src/index.ts`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    tsconfig: `${root}tsconfig.base.json`,
    logLevel: 'silent',
  }).then((result) => result.outputFiles[0].text);
  return coreBundle;
}

export interface HostOptions {
  /** Gateway options; `registry` carries the fragments, usually with function endpoints. */
  gateway: GatewayOptions;
  /** The host page's `<body>`: slots and any host markup. */
  body: string;
  /** Passed to `initBraid` as JSON. */
  braid?: Record<string, unknown>;
  /** Extra `<head>` markup, e.g. styles. */
  head?: string;
}

export interface Host {
  url: string;
  close(): Promise<void>;
}

/** A host page behind a real gateway, on a random local port. */
export async function startHost(options: HostOptions): Promise<Host> {
  const core = await bundleCore();
  const gateway = createGateway({ mode: 'production', ...options.gateway });
  const middleware = toNodeMiddleware(gateway);
  const page = `<!doctype html><html><head><meta charset="utf-8">${options.head ?? ''}
<script type="module">import { initBraid } from '/core.js'; initBraid(${JSON.stringify(options.braid ?? {})});</script>
</head><body>${options.body}</body></html>`;

  const server: Server = createServer((req, res) => {
    if (req.url === '/core.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(core);
      return;
    }
    middleware(req, res, () => {
      if (req.url === '/' || req.url?.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A fragment endpoint as a function of the path it is asked for (namespace prefix already stripped). */
export function endpoint(serve: (path: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return serve(new URL(url).pathname);
  }) as typeof fetch;
}

/** An HTML response, as a fragment endpoint would send. */
export function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });
}

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

/** Waits until each named slot has booted: `ready`, or `healthy` once liveness has checked in. */
export async function readySlots(page: Page, ...names: string[]): Promise<void> {
  for (const name of names) {
    await page.waitForSelector(`fragment-slot[name="${name}"]:is([state="ready"], [state="healthy"])`, {
      state: 'attached',
      timeout: 15_000,
    });
  }
}
