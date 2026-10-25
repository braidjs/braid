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
  /** The repository whose `main` branch may deploy, e.g. braidjs/braid. */
  githubRepo: string;
  /** An existing GitHub OIDC provider in the account, if there is one; otherwise this stack makes it. */
  githubOidcProviderArn?: string;
  /** Security headers for every page, as `[key, value]` pairs (read from src/static/_headers). */
  headers: Array<[string, string]>;
  /** Where things live on disk, for bundling the Lambda. */
  paths: { lambdaEntry: string; projectRoot: string; lockFile: string; tsconfig: string };
}

/** The SSM parameters the Lambda reads. The Turnstile secret is created by hand, as a SecureString. */
export const PARAMETERS = {
  turnstileSecret: '/braid-site/turnstile-secret',
  siteOrigin: '/braid-site/site-origin',
} as const;

/**
 * The whole site on AWS: an Amplify app serving the static files (deployed by CI, not built by
 * Amplify), a Lambda for the contact form behind an Amplify rewrite, a DynamoDB rate-limit table,
 * and the role GitHub Actions assumes to deploy all of it.
 */
export class SiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

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
      projectRoot: props.paths.projectRoot,
      depsLockFilePath: props.paths.lockFile,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'], tsconfig: props.paths.tsconfig },
      logGroup: new logs.LogGroup(this, 'ContactLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        RATE_LIMIT_TABLE: table.tableName,
        CONTACT_TO: props.contactTo,
        ...(props.contactFrom ? { CONTACT_FROM: props.contactFrom } : {}),
        ...(props.siteHostname ? { SITE_HOSTNAME: props.siteHostname } : {}),
        SITE_ORIGIN_PARAMETER: PARAMETERS.siteOrigin,
        TURNSTILE_SECRET_PARAMETER: PARAMETERS.turnstileSecret,
        // Amplify's CloudFront is the one proxy in front of the Lambda.
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
    // SES only sends from and to verified identities while the account is in the sandbox.
    contact.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
      }),
    );
    const url = contact.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // /api/contact is proxied to the Lambda, so the form posts to its own origin.
    app.customRules = [{ source: '/api/contact', target: `${url.url}api/contact`, status: '200' }];

    const provider = props.githubOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHub', props.githubOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GitHub', { url: 'https://token.actions.githubusercontent.com', clientIds: ['sts.amazonaws.com'] });
    const deployRole = new iam.Role(this, 'DeployRole', {
      description: `Deploys the Braid site from ${props.githubRepo}@main`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main`,
        },
      }),
    });
    // CDK deploys through the roles `cdk bootstrap` made; the role needs nothing broader than that.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['amplify:CreateDeployment', 'amplify:StartDeployment', 'amplify:GetJob'],
        resources: [
          this.formatArn({ service: 'amplify', resource: 'apps', resourceName: `${app.attrAppId}/branches/main` }),
          this.formatArn({ service: 'amplify', resource: 'apps', resourceName: `${app.attrAppId}/branches/main/jobs/*` }),
        ],
      }),
    );

    new CfnOutput(this, 'AppId', { value: app.attrAppId });
    new CfnOutput(this, 'SiteUrl', { value: siteOrigin });
    new CfnOutput(this, 'ContactFunctionUrl', { value: url.url });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
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
