import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { BraidGateway } from './gateway.js';

/**
 * Node/Connect binding for the gateway.
 *
 * Requests Braid doesn't own call the downstream `next()` untouched, so the binding composes
 * with any Connect-compatible server (Express, the Vite and Angular dev servers, plain http).
 *
 * Piercing needs more than pass-through: the gateway must *read* the shell application's
 * response in order to interleave fragments into it. Connect middleware has no return value to
 * read, so the shell response is captured by temporarily intercepting the response object's
 * write methods (see {@link captureDownstreamResponse}) while the downstream handler runs. The
 * capture streams — it does not buffer the shell — so the shell's own streaming is preserved.
 */
export function toNodeMiddleware(
  gateway: BraidGateway,
): (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    // Captured before any interception, so the final response is always written with the real
    // methods — even while the downstream shell is still streaming through the interceptors,
    // which is exactly what happens during a pierce.
    //
    // `writeHead` matters as much as `write`: Node's own `write()` calls it internally to flush
    // headers, so writing through an intercepted `writeHead` would commit a response with no
    // headers and drop the body on the floor.
    const native = {
      write: res.write.bind(res),
      end: res.end.bind(res),
      writeHead: res.writeHead.bind(res),
    };

    void (async () => {
      const request = nodeRequestToWebRequest(req);

      // the downstream handler must run at most once: if the gateway captured it and then
      // declined to produce a response, falling through to next() would run it a second time
      let captured: Promise<Response> | undefined;
      const response = await gateway.handle(
        request,
        () => (captured ??= captureDownstreamResponse(res, next)),
      );

      if (!response) {
        if (!captured) next();
        return;
      }

      // the downstream handler may have staged headers on `res` before we captured it; the
      // response we're about to write already carries everything it should
      for (const name of res.getHeaderNames()) {
        res.removeHeader(name);
      }

      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const setCookie = response.headers.getSetCookie?.();
      if (setCookie?.length) {
        headers['set-cookie'] = setCookie;
      }

      native.writeHead(response.status, headers);

      if (!response.body) {
        native.end();
        return;
      }

      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          native.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      native.end();
    })().catch(next);
  };
}

/**
 * Runs the downstream handler and captures what it writes as a `Response`.
 *
 * The returned promise resolves as soon as the downstream handler commits its status and
 * headers — its body is exposed as a stream that fills as the handler writes, so a streaming
 * shell stays streaming through the gateway.
 */
function captureDownstreamResponse(res: ServerResponse, next: (error?: unknown) => void): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      controller = undefined;
    },
  });

  let committed = false;

  const isNullBodyStatus = (status: number) =>
    status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);

  const commit = () => {
    if (committed) return;
    committed = true;

    const headers = new Headers();
    for (const [name, value] of Object.entries(res.getHeaders())) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        headers.append(name, String(entry));
      }
    }

    const responseBody = isNullBodyStatus(res.statusCode) ? null : body;
    resolve(new Response(responseBody, { status: res.statusCode, headers }));
  };

  const enqueue = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null || !controller) return;
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : (chunk as Uint8Array);
    controller.enqueue(new Uint8Array(bytes));
  };

  res.writeHead = function patchedWriteHead(statusCode: number, ...rest: unknown[]) {
    res.statusCode = statusCode;
    // headers may arrive as the 2nd or 3rd argument, as an object or a flat array
    const headerArgument = rest.find((argument) => typeof argument === 'object' && argument !== null);
    if (Array.isArray(headerArgument)) {
      for (let index = 0; index + 1 < headerArgument.length; index += 2) {
        res.setHeader(String(headerArgument[index]), headerArgument[index + 1] as string);
      }
    } else if (headerArgument) {
      for (const [name, value] of Object.entries(headerArgument as Record<string, unknown>)) {
        if (value !== undefined) res.setHeader(name, value as string);
      }
    }
    return res;
  } as ServerResponse['writeHead'];

  res.write = function patchedWrite(chunk: unknown, encoding?: unknown, callback?: unknown) {
    commit();
    enqueue(chunk, encoding);
    if (typeof encoding === 'function') (encoding as () => void)();
    else if (typeof callback === 'function') (callback as () => void)();
    return true;
  } as ServerResponse['write'];

  res.end = function patchedEnd(chunk?: unknown, encoding?: unknown, callback?: unknown) {
    if (typeof chunk !== 'function') {
      enqueue(chunk, encoding);
    }
    commit();
    controller?.close();
    controller = undefined;
    for (const argument of [chunk, encoding, callback]) {
      if (typeof argument === 'function') (argument as () => void)();
    }
    return res;
  } as ServerResponse['end'];

  try {
    next();
  } catch (error) {
    reject(error);
  }

  return promise;
}

/**
 * Proxies websocket upgrades addressed to a fragment through to its endpoint.
 *
 * Mount it on the server's `upgrade` event, alongside {@link toNodeMiddleware}:
 *
 * ```ts
 * const server = createServer(app);
 * server.on('upgrade', toNodeUpgradeHandler(gateway));
 * ```
 *
 * This is what keeps a fragment's dev-server live reload working when the fragment is reached
 * through the gateway rather than directly — and what lets a fragment use websockets in
 * production. Upgrades Braid does not own are left alone, so the shell's own dev socket still
 * reaches whatever else is listening.
 *
 * @param next handles upgrades that are not fragment upgrades. Defaults to destroying the
 *             socket; pass your dev server's own upgrade handler to chain them.
 */
export function toNodeUpgradeHandler(
  gateway: BraidGateway,
  next?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    void (async () => {
      const target = await gateway.resolveUpgrade(nodeRequestToWebRequest(req, { bodyless: true }));

      if (!target) {
        if (next) next(req, socket, head);
        else socket.destroy();
        return;
      }

      const isSecure = target.target.protocol === 'https:';
      const transport = isSecure ? https : http;

      const upstream = transport.request({
        host: target.target.hostname,
        port: target.target.port || (isSecure ? 443 : 80),
        path: `${target.target.pathname}${target.target.search}`,
        method: req.method,
        headers: { ...Object.fromEntries(target.headers), host: target.target.host },
      });

      upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        const statusLine =
          `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n` +
          Object.entries(upstreamRes.headers)
            .flatMap(([name, value]) => (Array.isArray(value) ? value.map((v) => `${name}: ${v}`) : [`${name}: ${value}`]))
            .join('\r\n') +
          '\r\n\r\n';

        socket.write(statusLine);
        if (upstreamHead?.length) socket.write(upstreamHead);

        upstreamSocket.on('error', () => socket.destroy());
        socket.on('error', () => upstreamSocket.destroy());
        upstreamSocket.pipe(socket).pipe(upstreamSocket);
      });

      upstream.on('response', () => {
        // the endpoint declined the upgrade
        socket.destroy();
      });

      upstream.on('error', () => socket.destroy());

      if (head?.length) upstream.write(head);
      upstream.end();
    })().catch(() => socket.destroy());
  };
}

function nodeRequestToWebRequest(req: IncomingMessage, options: { bodyless?: boolean } = {}): Request {
  const host = req.headers.host ?? 'localhost';
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(name, entry));
    } else {
      headers.set(name, value);
    }
  }

  const method = req.method ?? 'GET';
  const hasBody = !options.bodyless && method !== 'GET' && method !== 'HEAD';

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
    // required by undici when a body stream is attached
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}
