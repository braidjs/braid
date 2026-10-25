import { describe, expect, it, vi } from 'vitest';
import { clientIpFrom, createHandler, toRequest, type AwsContactConfig, type FunctionUrlEvent } from './lambda';

const SITE = 'https://main.d1abc.amplifyapp.com';

function event(overrides: Partial<FunctionUrlEvent> & { form?: Record<string, string> } = {}): FunctionUrlEvent {
  const { form, ...rest } = overrides;
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return {
    rawPath: '/api/contact',
    rawQueryString: '',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: SITE,
      'x-forwarded-for': '198.51.100.20, 203.0.113.7',
    },
    body,
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST', sourceIp: '130.176.0.1' } },
    ...rest,
  };
}

const valid = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: '',
  message: 'Hosting please.',
  'cf-turnstile-response': 'tok',
};

function config(overrides: Partial<AwsContactConfig> = {}) {
  const sent: string[] = [];
  const all: AwsContactConfig = {
    siteOrigin: SITE,
    trustedProxyHops: 1,
    contactTo: 'team@braid.example',
    contactFrom: 'team@braid.example',
    perMinute: 5,
    hit: vi.fn(async () => 1),
    sendRaw: vi.fn(async (raw: string) => void sent.push(raw)),
    turnstileSecret: vi.fn(async () => 's3cret'),
    verifyTurnstile: vi.fn(async () => true),
    log: vi.fn(),
    ...overrides,
  };
  return { config: all, sent };
}

describe('toRequest', () => {
  it('rebuilds the request on the public site origin, so the Origin check compares like with like', async () => {
    const req = toRequest(event({ form: valid, rawQueryString: 'x=1' }), SITE);
    expect(req.url).toBe(`${SITE}/api/contact?x=1`);
    expect(req.method).toBe('POST');
    expect(req.headers.get('origin')).toBe(SITE);
    expect(await req.text()).toBe(new URLSearchParams(valid).toString());
  });

  it('decodes a base64 body', async () => {
    const form = new URLSearchParams(valid).toString();
    const req = toRequest(event({ body: Buffer.from(form).toString('base64'), isBase64Encoded: true }), SITE);
    expect(await req.text()).toBe(form);
  });
});

describe('clientIpFrom', () => {
  it('counts trusted proxy hops from the right of the forwarding chain', () => {
    // chain: 198.51.100.20 (client-sent), 203.0.113.7 (added by CloudFront), 130.176.0.1 (connected to Lambda)
    expect(clientIpFrom(event(), 1)).toBe('203.0.113.7');
    expect(clientIpFrom(event(), 0)).toBe('130.176.0.1');
  });

  it('ignores whatever the visitor put in X-Forwarded-For themselves', () => {
    const spoofed = event({ headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.7' } });
    expect(clientIpFrom(spoofed, 1)).toBe('203.0.113.7');
  });

  it('is null when the chain is shorter than the trusted hops, rather than guessing', () => {
    expect(clientIpFrom(event({ headers: {} }), 1)).toBeNull();
  });
});

describe('the Lambda handler', () => {
  it('sends a valid enquiry through SES as one raw message, and redirects', async () => {
    const { config: c, sent } = config();
    const res = await createHandler(c)(event({ form: valid }));
    expect(res.statusCode).toBe(303);
    expect(res.headers['location']).toBe('/contact/thanks/');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('To: team@braid.example');
    expect(sent[0]).toContain('Reply-To: ada@example.com');
    expect(c.verifyTurnstile).toHaveBeenCalledWith('s3cret', 'tok', '203.0.113.7');
  });

  it('keys the rate limit on the visitor and the current minute, and answers 429 past the limit', async () => {
    const { config: c, sent } = config({ hit: vi.fn(async () => 6) });
    const res = await createHandler(c)(event({ form: valid }));
    expect(res.statusCode).toBe(429);
    expect(c.hit).toHaveBeenCalledWith(expect.stringMatching(/^203\.0\.113\.7#\d+$/));
    expect(sent).toHaveLength(0);
  });

  it('returns JSON bodies and headers in the Function URL shape', async () => {
    const { config: c } = config();
    const res = await createHandler(c)(event({ form: { ...valid, email: 'nope' }, headers: { ...event().headers, accept: 'application/json' } }));
    expect(res.statusCode).toBe(400);
    expect(res.isBase64Encoded).toBe(false);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, errors: { email: expect.any(String) } });
  });

  it('answers 404 for anything but /api/contact', async () => {
    const { config: c } = config();
    expect((await createHandler(c)(event({ rawPath: '/' }))).statusCode).toBe(404);
  });

  it('refuses a post whose Origin is not the site', async () => {
    const { config: c, sent } = config();
    const res = await createHandler(c)(event({ form: valid, headers: { ...event().headers, origin: 'https://evil.test' } }));
    expect(res.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('logs and answers 502 when SES refuses the message', async () => {
    const { config: c } = config({ sendRaw: vi.fn(async () => Promise.reject(new Error('MessageRejected'))) });
    const res = await createHandler(c)(event({ form: valid }));
    expect(res.statusCode).toBe(502);
    expect(c.log).toHaveBeenCalled();
  });
});
