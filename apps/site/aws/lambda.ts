import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { createHmac } from 'node:crypto';
import { handleContact, unavailable } from '../api/contact';
import { buildEmail } from '../api/email';
import { verifyTurnstile as siteverify } from '../api/turnstile';

/**
 * The contact form on AWS: a Lambda behind a Function URL, which Amplify reaches through a rewrite
 * of /api/contact, so the form stays same-origin.
 *
 * This file only translates. The Function URL event becomes a standard Request, the platform-neutral
 * handler in ../api does the work, and its Response becomes the Function URL result. Rate limiting is
 * a DynamoDB counter, mail goes through SES, and the Turnstile secret comes from SSM.
 *
 * The rewrite targets a secret path on the Function URL (`/api/contact/<secret>`), and every other
 * path is a 404. The Function URL is public, so without that secret a direct call — which could forge
 * X-Forwarded-For and pick its own rate-limit key — never reaches the handler.
 */

/** The parts of a Lambda Function URL (payload 2.0) event this uses. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded: boolean;
  requestContext: { http: { method: string; sourceIp: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

export interface AwsContactConfig {
  /** The public site, e.g. https://main.<app>.amplifyapp.com. Requests are rebuilt on it. */
  siteOrigin: string;
  /** The only path served: /api/contact/<secret>, as Amplify's rewrite sends it. */
  proxyPath: string;
  /** How many proxies we trust in front of the Lambda: 1 when Amplify's CloudFront proxies it. */
  trustedProxyHops: number;
  contactTo: string;
  contactFrom: string;
  perMinute: number;
  /** Counts one hit against `key` and returns the total so far in its window. */
  hit(key: string): Promise<number>;
  sendRaw(raw: string): Promise<void>;
  /** The Turnstile secret. Empty means it couldn't be read, which is our fault, not the visitor's. */
  turnstileSecret(): Promise<string>;
  verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean>;
  log(message: string, detail?: unknown): void;
}

export function toRequest(event: FunctionUrlEvent, siteOrigin: string): Request {
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers)) if (value !== undefined) headers.set(key, value);
  const method = event.requestContext.http.method;
  const body =
    event.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
  // The path the browser posted to, not the secret one Amplify forwarded to.
  return new Request(`${siteOrigin}/api/contact${query}`, { method, headers, body });
}

/**
 * The visitor's IP: count `hops` trusted proxies in from the right of X-Forwarded-For plus the
 * address that connected to the Lambda. Anything further left was sent by the visitor and could
 * say anything, so it is never used. Null when the chain is too short to tell.
 */
export function clientIpFrom(event: FunctionUrlEvent, hops: number): string | null {
  const forwarded = (event.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const chain = [...forwarded, event.requestContext.http.sourceIp];
  return chain[chain.length - 1 - hops] ?? null;
}

export async function toResult(response: Response): Promise<FunctionUrlResult> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  // Every response the handler makes is text (HTML, JSON or empty), so no base64 is needed.
  return { statusCode: response.status, headers, body: await response.text(), isBase64Encoded: false };
}

/** Raised for faults on our side; the handler turns them into a 503, never a visitor-facing 400. */
class ServerFault extends Error {}

export function createHandler(config: AwsContactConfig): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async (event) => {
    if (event.rawPath !== config.proxyPath) {
      return toResult(Response.json({ ok: false, error: 'not found' }, { status: 404 }));
    }
    const request = toRequest(event, config.siteOrigin);
    try {
      const response = await handleContact(request, {
        clientIp: () => clientIpFrom(event, config.trustedProxyHops),
        verifyTurnstile: async (token, ip) => {
          const secret = await config.turnstileSecret();
          if (!secret) throw new ServerFault('the Turnstile secret is not available');
          return config.verifyTurnstile(secret, token, ip);
        },
        rateLimit: async (ip) => {
          // Keyed by a keyed hash of the IP, not the IP itself, so the table never holds an address.
          const visitor = createHmac('sha256', await config.turnstileSecret()).update(ip).digest('hex');
          return (await config.hit(`${visitor}#${Math.floor(Date.now() / 60_000)}`)) <= config.perMinute;
        },
        send: (message) => config.sendRaw(buildEmail({ from: config.contactFrom, to: config.contactTo, message })),
        log: config.log,
      });
      return toResult(response);
    } catch (error) {
      // A missing secret, an unreachable table: the visitor can't fix these, so don't say they can.
      config.log('contact: failed on our side', error instanceof Error ? error.message : error);
      return toResult(unavailable(request));
    }
  };
}

/**
 * The real wiring, from the Lambda's environment and SSM. Built on the first invocation, not at
 * import, so the tests can import this file without configuration.
 */
async function fromEnvironment(): Promise<AwsContactConfig> {
  const env = process.env;
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`contact: ${name} is not set`);
    return value;
  };
  const positiveInteger = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 0) throw new Error(`contact: ${name} must be a whole number`);
    return value;
  };
  const dynamo = new DynamoDBClient({});
  const ses = new SESv2Client({});
  const ssm = new SSMClient({});
  const log = (message: string, detail?: unknown) => console.error(message, detail);
  const parameter = async (name: string, decrypt = false) =>
    (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: decrypt }))).Parameter?.Value ?? '';

  const table = required('RATE_LIMIT_TABLE');
  const contactTo = required('CONTACT_TO');
  const contactFrom = env['CONTACT_FROM'] || contactTo;
  // From SSM rather than the environment: the Amplify app (which knows its domain and holds the
  // rewrite) and this function can't reference each other directly without a cycle.
  const [siteOrigin, proxySecret] = await Promise.all([
    env['SITE_ORIGIN'] || parameter(required('SITE_ORIGIN_PARAMETER')),
    parameter(required('PROXY_SECRET_PARAMETER')),
  ]);
  if (!siteOrigin || !proxySecret) throw new Error('contact: the site origin or proxy secret is not configured');
  const secretName = required('TURNSTILE_SECRET_PARAMETER');
  // The token must have been issued for this site and this form. This also catches Cloudflare's test
  // keys used by mistake in production: they report hostname "example.com" and no action.
  const expected = { hostname: new URL(siteOrigin).hostname, action: 'contact' };

  let secret: Promise<string> | undefined;
  return {
    siteOrigin,
    proxyPath: `/api/contact/${proxySecret}`,
    trustedProxyHops: positiveInteger('TRUSTED_PROXY_HOPS', 1),
    contactTo,
    contactFrom,
    perMinute: positiveInteger('CONTACT_PER_MINUTE', 5),
    async hit(key) {
      const result = await dynamo.send(
        new UpdateItemCommand({
          TableName: table,
          Key: { pk: { S: key } },
          // Counters expire on their own a minute after their window closes.
          UpdateExpression: 'ADD hits :one SET expires = if_not_exists(expires, :ttl)',
          ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(Math.floor(Date.now() / 1000) + 120) } },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      return Number(result.Attributes?.['hits']?.N ?? '0');
    },
    async sendRaw(raw) {
      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: contactFrom,
          Destination: { ToAddresses: [contactTo] },
          Content: { Raw: { Data: new TextEncoder().encode(raw) } },
        }),
      );
    },
    turnstileSecret() {
      // Read once per cold start; a failed or empty read is retried next time rather than cached.
      secret ??= parameter(secretName, true)
        .then((value) => {
          if (!value) secret = undefined;
          return value;
        })
        .catch((error: unknown) => {
          secret = undefined;
          log('contact: reading the Turnstile secret failed', error instanceof Error ? error.message : error);
          return '';
        });
      return secret;
    },
    verifyTurnstile: (key, token, ip) => siteverify(key, token, ip, { expected, log }),
    log,
  };
}

let configured: Promise<(event: FunctionUrlEvent) => Promise<FunctionUrlResult>> | undefined;

/** The Lambda entry point. */
export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  // A failed setup (a transient SSM error, say) is not cached: the next invocation tries again.
  configured ??= fromEnvironment()
    .then(createHandler)
    .catch((error: unknown) => {
      configured = undefined;
      throw error;
    });
  try {
    return await (await configured)(event);
  } catch (error) {
    console.error('contact: setup failed', error instanceof Error ? error.message : error);
    return toResult(Response.json({ ok: false, errors: { form: 'The form isn’t working on our side right now.' } }, { status: 503 }));
  }
}
