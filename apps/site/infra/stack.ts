import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export interface SiteStackProps extends StackProps {
  /** The inbox enquiries go to. Must be a verified identity in SES. */
  contactTo: string;
  /** The sender. Defaults to `contactTo`, which SES allows once that address is verified. */
  contactFrom?: string;
  /** A custom domain, once there is one. Without it the site is main.<app>.amplifyapp.com. */
  siteHostname?: string;
  /** The repository whose deploys may publish the site, e.g. braidjs/braid. */
  githubRepo: string;
  /**
   * The start of the repository's OIDC `sub` claim. With GitHub's immutable subjects (the repo's
   * setting) it names the owner and repo by ID — `repo:braidjs@316401299/braid@1326724459` — so a
   * different repository that later takes the same name can't match. Read it from
   * `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (`sub_claim_prefix`).
   */
  githubSubjectPrefix: string;
  /** The GitHub environment the publish job runs in. Only that environment can assume the role. */
  githubEnvironment: string;
  /** An existing GitHub OIDC provider in the account, if there is one; otherwise this stack makes it. */
  githubOidcProviderArn?: string;
  /** Caps the contact function's concurrency so a flood can't starve the account's other functions. */
  reservedConcurrency?: number;
  /** Security headers for every page, as `[key, value]` pairs (read from src/static/_headers). */
  headers: Array<[string, string]>;
  /** Where things live on disk, for bundling the Lambda. */
  paths: { lambdaEntry: string; projectRoot: string; lockFile: string; tsconfig: string };
}

/**
 * The SSM parameters the Lambda reads. The first two are created by hand before the first deploy:
 * the Turnstile secret as a SecureString, and the proxy secret as a random String.
 */
export const PARAMETERS = {
  turnstileSecret: '/braid-site/turnstile-secret',
  proxySecret: '/braid-site/proxy-secret',
  siteOrigin: '/braid-site/site-origin',
} as const;

/**
 * The whole site on AWS: an Amplify app serving the static files (published by CI, not built by
 * Amplify), a Lambda for the contact form behind an Amplify rewrite, and a DynamoDB rate-limit table.
 *
 * Infrastructure is deployed by a person (`npx nx run site:infra-deploy`). The role CI gets can only
 * publish new site content to this app's main branch: nothing it runs can change infrastructure.
 */
export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const contactFrom = props.contactFrom ?? props.contactTo;

    const app = new amplify.CfnApp(this, 'App', {
      name: 'braid-site',
      platform: 'WEB',
      customHeaders: amplifyHeaders(props.headers),
    });
    new amplify.CfnBranch(this, 'Main', { appId: app.attrAppId, branchName: 'main', stage: 'PRODUCTION', enableAutoBuild: false });
    const siteOrigin = props.siteHostname ? `https://${props.siteHostname}` : `https://main.${app.attrDefaultDomain}`;
    new ssm.StringParameter(this, 'SiteOrigin', { parameterName: PARAMETERS.siteOrigin, stringValue: siteOrigin });

    const table = new dynamodb.Table(this, 'RateLimit', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires',
      // Only minute-long counters live here; nothing to keep.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const contact = new NodejsFunction(this, 'Contact', {
      entry: props.paths.lambdaEntry,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      ...(props.reservedConcurrency !== undefined ? { reservedConcurrentExecutions: props.reservedConcurrency } : {}),
      projectRoot: props.paths.projectRoot,
      depsLockFilePath: props.paths.lockFile,
      bundling: { minify: true, sourceMap: true, tsconfig: props.paths.tsconfig },
      logGroup: new logs.LogGroup(this, 'ContactLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        RATE_LIMIT_TABLE: table.tableName,
        CONTACT_TO: props.contactTo,
        CONTACT_FROM: contactFrom,
        SITE_ORIGIN_PARAMETER: PARAMETERS.siteOrigin,
        PROXY_SECRET_PARAMETER: PARAMETERS.proxySecret,
        TURNSTILE_SECRET_PARAMETER: PARAMETERS.turnstileSecret,
        // Amplify's CloudFront is the one proxy in front of the Lambda. Confirm on the first deploy.
        TRUSTED_PROXY_HOPS: '1',
      },
    });
    table.grant(contact, 'dynamodb:UpdateItem');
    contact.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: Object.values(PARAMETERS).map((name) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.slice(1) })),
      }),
    );
    // Only from the one sender, only to the one inbox, whatever SES later allows the account.
    const fromDomain = contactFrom.split('@')[1] ?? contactFrom;
    contact.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [contactFrom, fromDomain].map((identity) => this.formatArn({ service: 'ses', resource: 'identity', resourceName: identity })),
        conditions: {
          StringEquals: { 'ses:FromAddress': contactFrom },
          'ForAllValues:StringEquals': { 'ses:Recipients': [props.contactTo] },
        },
      }),
    );
    const url = contact.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // /api/contact is proxied to a secret path on the Lambda, so the form posts to its own origin and
    // the public Function URL is useless without the secret. Read from SSM at deploy time, so the
    // secret is in neither the repository nor the template.
    const proxySecret = ssm.StringParameter.valueForStringParameter(this, PARAMETERS.proxySecret);
    app.customRules = [{ source: '/api/contact', target: `${url.url}api/contact/${proxySecret}`, status: '200' }];

    const provider = props.githubOidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHub', props.githubOidcProviderArn)
      : new iam.OidcProviderNative(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const publishRole = new iam.Role(this, 'PublishRole', {
      description: `Publishes the Braid site from ${props.githubRepo} (environment ${props.githubEnvironment})`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          // An environment, not a branch: any job on main would match a branch.
          'token.actions.githubusercontent.com:sub': `${props.githubSubjectPrefix}:environment:${props.githubEnvironment}`,
        },
      }),
    });
    publishRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['amplify:CreateDeployment', 'amplify:StartDeployment', 'amplify:GetJob'],
        resources: [
          this.formatArn({ service: 'amplify', resource: 'apps', resourceName: `${app.attrAppId}/branches/main` }),
          this.formatArn({ service: 'amplify', resource: 'apps', resourceName: `${app.attrAppId}/branches/main/deployments/*` }),
          this.formatArn({ service: 'amplify', resource: 'apps', resourceName: `${app.attrAppId}/branches/main/jobs/*` }),
        ],
      }),
    );

    new CfnOutput(this, 'AppId', { value: app.attrAppId });
    new CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new CfnOutput(this, 'PublishRoleArn', { value: publishRole.roleArn });
  }
}

/** Amplify's custom-headers YAML, applying every header to every path. */
export function amplifyHeaders(headers: Array<[string, string]>): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  return [
    'customHeaders:',
    "  - pattern: '**'",
    '    headers:',
    ...headers.flatMap(([key, value]) => [`      - key: ${quote(key)}`, `        value: ${quote(value)}`]),
    '',
  ].join('\n');
}
