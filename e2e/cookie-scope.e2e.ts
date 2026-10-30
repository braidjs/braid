import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { endpoint, html, launch, readySlots, startHost, type Host } from './harness.js';
import {
  cookieScopePrefix as gatewayPrefix,
  scopeRequestCookies,
  scopeSetCookie,
} from '../libs/braid-gateway/src/cookie-scope.js';
import { cookieScopePrefix as clientPrefix, partitionCookie } from '../libs/core/src/compat/cookie-partition.js';

/**
 * Session cookies from authorization-code logins, in a real browser cookie jar.
 *
 * Each fragment's backend finishes its login by setting `session` (HttpOnly) and a script-readable
 * `csrf`, both `Path=/` — what a BFF or an OIDC proxy plugin does. Shared fragments overwrite each
 * other's; partitioned ones (capabilities.storage) each keep theirs, see only theirs from script,
 * and send only theirs to their own backend.
 */

type Probe = { fragment: string; kind: string; detail?: unknown }[];

function fragmentPage(id: string): string {
  return `<p>${id}</p><script>
  (async function () {
    var log = function (kind, detail) { top.__probe.push({ fragment: '${id}', kind: kind, detail: detail }); };
    await fetch('/__braid/frag/${id}/login');
    top.__loggedIn = (top.__loggedIn || 0) + 1;
    // wait for every fragment's login, so each sees the others' cookies if it can
    while (top.__loggedIn < top.__expected) await new Promise(function (r) { setTimeout(r, 20); });
    document.cookie = 'pref-${id}=1; Path=/somewhere; Domain=127.0.0.1';
    log('document.cookie', document.cookie);
    log('backend saw', await (await fetch('/__braid/frag/${id}/whoami')).text());
  })();
</script>`;
}

function fragment(id: string, storage?: unknown) {
  return {
    id,
    ...(storage === undefined ? {} : { capabilities: { storage } as never }),
    endpoint: endpoint(async (path) => {
      if (path === '/login') {
        const headers = new Headers({ 'content-type': 'text/plain' });
        headers.append('set-cookie', `session=${id}-session; Path=/; HttpOnly`);
        headers.append('set-cookie', `csrf=${id}-token; Path=/`);
        return new Response('ok', { headers });
      }
      return html(fragmentPage(id));
    }),
  };
}

/** The `whoami` answer: the Cookie header the fragment's endpoint received. */
function withWhoami(manifest: ReturnType<typeof fragment>) {
  const serve = manifest.endpoint;
  return {
    ...manifest,
    endpoint: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === '/whoami') return new Response(request.headers.get('cookie') ?? '');
      return serve(request);
    }) as typeof fetch,
  };
}

let browser: Browser;
let partitioned: Host;
let shared: Host;
let partitionedWithHostCookies: Host;

beforeAll(async () => {
  browser = await launch();
  const head = (expected: number) =>
    `<script>window.__probe = []; window.__expected = ${expected}; document.cookie = 'theme=dark; Path=/';</script>`;
  partitioned = await startHost({
    gateway: { registry: [withWhoami(fragment('a', 'partitioned')), withWhoami(fragment('b', 'partitioned'))] },
    head: head(2),
    body: '<fragment-slot name="a"></fragment-slot><fragment-slot name="b"></fragment-slot>',
  });
  partitionedWithHostCookies = await startHost({
    gateway: { forwardCredentials: true, registry: [withWhoami(fragment('a', 'partitioned')), withWhoami(fragment('b', 'partitioned'))] },
    // the host (or a proxy) has its own `session`, set first, as is usual
    head: head(2).replace("document.cookie = 'theme=dark; Path=/';", "document.cookie = 'theme=dark; Path=/'; document.cookie = 'session=HOST; Path=/';"),
    body: '<fragment-slot name="a"></fragment-slot><fragment-slot name="b"></fragment-slot>',
  });
  shared = await startHost({
    gateway: { forwardCredentials: true, registry: [withWhoami(fragment('a')), withWhoami(fragment('b'))] },
    head: head(2),
    body: '<fragment-slot name="a"></fragment-slot><fragment-slot name="b"></fragment-slot>',
  });
});

afterAll(async () => {
  await browser?.close();
  await partitioned?.close();
  await partitionedWithHostCookies?.close();
  await shared?.close();
});

async function run(host: Host): Promise<{ page: Page; context: BrowserContext; probe: Probe }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(host.url);
  await readySlots(page, 'a', 'b');
  await page.waitForFunction(() => (window as unknown as { __probe: Probe }).__probe.filter((e) => e.kind === 'backend saw').length === 2);
  return { page, context, probe: await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe) };
}

const detail = (probe: Probe, fragment: string, kind: string) =>
  probe.find((entry) => entry.fragment === fragment && entry.kind === kind)?.detail as string;

const cookies = (header: string) =>
  header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();

describe('shared fragments, today', () => {
  it("overwrite each other's session: the jar ends up with one, and both backends get it", async () => {
    const { context, probe } = await run(shared);
    const sessions = (await context.cookies()).filter((cookie) => cookie.name === 'session');
    expect(sessions).toHaveLength(1);
    expect(detail(probe, 'a', 'backend saw')).toContain(`session=${sessions[0]!.value}`);
    expect(detail(probe, 'b', 'backend saw')).toContain(`session=${sessions[0]!.value}`);
    await context.close();
  });
});

describe('partitioned fragments', () => {
  it('each keep their own session in the jar, scoped and host-only on Path=/', async () => {
    const { context } = await run(partitioned);
    const jar = await context.cookies();
    const byName = Object.fromEntries(jar.map((cookie) => [cookie.name, cookie]));
    expect(byName['session']).toBeUndefined();
    expect(byName['braid$a$session']).toMatchObject({ value: 'a-session', httpOnly: true, path: '/' });
    expect(byName['braid$b$session']).toMatchObject({ value: 'b-session', httpOnly: true, path: '/' });
    // a cookie written from script lands in the writer's scope, on Path=/
    expect(byName['braid$a$pref-a']).toMatchObject({ value: '1', path: '/' });
    await context.close();
  });

  it('send each backend only its own cookies, under the names it set', async () => {
    const { context, probe } = await run(partitioned);
    expect(cookies(detail(probe, 'a', 'backend saw'))).toEqual(['csrf=a-token', 'pref-a=1', 'session=a-session']);
    expect(cookies(detail(probe, 'b', 'backend saw'))).toEqual(['csrf=b-token', 'pref-b=1', 'session=b-session']);
    await context.close();
  });

  it("show each fragment's script its own readable cookies and the host's, never the other fragment's", async () => {
    const { context, probe } = await run(partitioned);
    expect(cookies(detail(probe, 'a', 'document.cookie'))).toEqual(['csrf=a-token', 'pref-a=1', 'theme=dark']);
    expect(cookies(detail(probe, 'b', 'document.cookie'))).toEqual(['csrf=b-token', 'pref-b=1', 'theme=dark']);
    await context.close();
  });

  it("still send each backend its own session when the host has a cookie of the same name", async () => {
    const { context, probe } = await run(partitionedWithHostCookies);
    // own first, the host's same-named one left out: a backend reading the first `session` is right
    expect(cookies(detail(probe, 'a', 'backend saw'))).toEqual(['csrf=a-token', 'pref-a=1', 'session=a-session', 'theme=dark']);
    expect(cookies(detail(probe, 'b', 'backend saw'))).toEqual(['csrf=b-token', 'pref-b=1', 'session=b-session', 'theme=dark']);
    await context.close();
  });

  it('use one scope encoding and one rule in the gateway and the client', () => {
    for (const name of ['a', 'kcd', 'a.b', 'a$b', 'ünï', 'with space', '(x)', 'a;b=c']) {
      expect(clientPrefix(name), name).toBe(gatewayPrefix(name));
    }
    // the duplicated logic agrees: what the client writes is what the gateway would have set, and
    // what the client reads is what the gateway would send (host cookies included)
    const lines = ['session=x; Domain=example.com; Path=/api; HttpOnly', '__Host-sid=y; Secure', '__secure-a=b', 'k=v=w; Max-Age=0'];
    for (const line of lines) {
      const writes: string[] = [];
      partitionCookie({ get: () => '', set: (value) => void writes.push(value) }, 'kcd').set(line);
      expect(writes[0], line).toBe(scopeSetCookie(line, 'kcd'));
    }
    const headers = ['braid$kcd$session=own; session=host; theme=dark', '__Host-braid$kcd$sid=1; braid$other$x=2', 'a=1'];
    for (const header of headers) {
      const read = partitionCookie({ get: () => header, set: () => undefined }, 'kcd').get();
      expect(read, header).toBe(scopeRequestCookies(header, 'kcd', true) ?? '');
    }
  });
});
