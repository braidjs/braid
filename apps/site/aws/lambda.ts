import { handleContact } from '../api/contact';
import { buildEmail } from '../api/email';
import { verifyTurnstile as siteverify, type TurnstileExpectations } from '../api/turnstile';

/**
 * The contact form on AWS: a Lambda behind a Function URL, which Amplify reaches through a rewrite
 * of /api/contact, so the form stays same-origin.
 *
 * This file only translates. The Function URL event becomes a standard Request, the platform-neutral
 * handler in ../api does the work, and its Response becomes the Function URL result. Rate limiting is
 * a DynamoDB counter, mail goes through SES, and the Turnstile secret comes from SSM.
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
  /** How many proxies we trust in front of the Lambda: 1 when Amplify's CloudFront proxies it. */
  trustedProxyHops: number;
  contactTo: string;
  contactFrom: string;
  perMinute: number;
  /** Counts one hit against `key` and returns the total so far in its window. */
  hit(key: string): Promise<number>;
  sendRaw(raw: string): Promise<void>;
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
  return new Request(`${siteOrigin}${event.rawPath}${query}`, { method, headers, body });
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

export function createHandler(config: AwsContactConfig): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return async (event) => {
    if (event.rawPath !== '/api/contact') {
      return toResult(Response.json({ ok: false, error: 'not found' }, { status: 404 }));
    }
    const response = await handleContact(toRequest(event, config.siteOrigin), {
      clientIp: () => clientIpFrom(event, config.trustedProxyHops),
      rateLimit: async (ip) => (await config.hit(`${ip}#${Math.floor(Date.now() / 60_000)}`)) <= config.perMinute,
      verifyTurnstile: async (token, ip) => config.verifyTurnstile(await config.turnstileSecret(), token, ip),
      send: (message) => config.sendRaw(buildEmail({ from: config.contactFrom, to: config.contactTo, message })),
      log: config.log,
    });
    return toResult(response);
  };
}

/**
 * The real wiring, from the Lambda's environment. Built on the first invocation, not at import, so
 * the tests can import this file without AWS credentials or configuration.
 */
async function fromEnvironment(): Promise<AwsContactConfig> {
  const env = process.env;
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`contact: ${name} is not set`);
    return value;
  };
  const [{ DynamoDBClient, UpdateItemCommand }, { SESv2Client, SendEmailCommand }, { SSMClient, GetParameterCommand }] =
    await Promise.all([import('@aws-sdk/client-dynamodb'), import('@aws-sdk/client-sesv2'), import('@aws-sdk/client-ssm')]);
  const dynamo = new DynamoDBClient({});
  const ses = new SESv2Client({});
  const ssm = new SSMClient({});
  const table = required('RATE_LIMIT_TABLE');
  const parameter = required('TURNSTILE_SECRET_PARAMETER');
  const siteHostname = env['SITE_HOSTNAME'];
  const expected: TurnstileExpectations = siteHostname ? { hostname: siteHostname, action: 'contact' } : {};
  const log = (message: string, detail?: unknown) => console.error(message, detail);

  let secret: Promise<string> | undefined;
  return {
    siteOrigin: required('SITE_ORIGIN'),
    trustedProxyHops: Number(env['TRUSTED_PROXY_HOPS'] ?? '1'),
    contactTo: required('CONTACT_TO'),
    contactFrom: env['CONTACT_FROM'] || required('CONTACT_TO'),
    perMinute: Number(env['CONTACT_PER_MINUTE'] ?? '5'),
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
          FromEmailAddress: env['CONTACT_FROM'] || required('CONTACT_TO'),
          Destination: { ToAddresses: [required('CONTACT_TO')] },
          Content: { Raw: { Data: new TextEncoder().encode(raw) } },
        }),
      );
    },
    turnstileSecret() {
      // Read once per cold start; a failed read is retried next time rather than cached.
      secret ??= ssm
        .send(new GetParameterCommand({ Name: parameter, WithDecryption: true }))
        .then((out) => out.Parameter?.Value ?? '')
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
  configured ??= fromEnvironment().then(createHandler);
  return (await configured)(event);
}
