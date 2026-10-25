import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { amplifyHeaders, PARAMETERS, SiteStack } from './stack';

const workspace = resolve(import.meta.dirname, '../../..');
let template: Template;

type Statement = { Action: string | string[]; Resource?: unknown; Condition?: Record<string, unknown> };
const statementsOf = (prefix: string): Statement[] =>
  Object.values(template.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp(`^${prefix}`) } })).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );

beforeAll(() => {
  const app = new App();
  const stack = new SiteStack(app, 'Test', {
    env: { account: '111111111111', region: 'us-east-1' },
    contactTo: 'team@braid.example',
    siteHostname: 'oss.braid.example',
    githubRepo: 'braidjs/braid',
    githubSubjectPrefix: 'repo:braidjs@316401299/braid@1326724459',
    githubEnvironment: 'site-production',
    reservedConcurrency: 5,
    headers: [['X-Content-Type-Options', 'nosniff']],
    paths: {
      lambdaEntry: join(workspace, 'apps/site/aws/lambda.ts'),
      projectRoot: workspace,
      lockFile: join(workspace, 'package-lock.json'),
      tsconfig: join(workspace, 'tsconfig.base.json'),
    },
  });
  template = Template.fromStack(stack);
}, 120_000);

describe('the site stack', () => {
  it('proxies /api/contact to a secret path on the function, read from SSM at deploy time', () => {
    const app = Object.values(template.findResources('AWS::Amplify::App'))[0] as { Properties: { CustomRules: unknown[] } };
    const rule = JSON.stringify(app.Properties.CustomRules);
    expect(rule).toContain('"Source":"/api/contact"');
    expect(rule).toContain('FunctionUrl');
    expect(rule).toContain('api/contact/');
    // The secret arrives as an SSM-typed stack parameter, never as a literal in the template.
    const parameters = template.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    expect(Object.values(parameters).some((p) => p.Default === PARAMETERS.proxySecret && p.Type.includes('AWS::SSM::Parameter::Value'))).toBe(true);
  });

  it('does not publish the Function URL as an output', () => {
    expect(Object.keys(template.toJSON().Outputs ?? {}).sort()).toEqual(['AppId', 'PublishRoleArn', 'SiteUrl']);
  });

  it('records the public origin, the custom hostname, for the function to read', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: PARAMETERS.siteOrigin, Value: 'https://oss.braid.example' });
  });

  it('attaches the hostname itself as the domain, so it claims no parent domain, serving main', () => {
    template.resourceCountIs('AWS::Amplify::Domain', 1);
    template.hasResourceProperties('AWS::Amplify::Domain', {
      DomainName: 'oss.braid.example',
      SubDomainSettings: [{ Prefix: '', BranchName: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Main'), 'BranchName'] } }],
      EnableAutoSubDomain: false,
      CertificateSettings: Match.absent(),
    });
  });

  it('runs the function on Node 24, capped, with the configuration the adapter reads', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      ReservedConcurrentExecutions: 5,
      Environment: {
        Variables: Match.objectLike({
          CONTACT_TO: 'team@braid.example',
          CONTACT_FROM: 'team@braid.example',
          SITE_ORIGIN: 'https://oss.braid.example',
          SITE_ORIGIN_PARAMETER: PARAMETERS.siteOrigin,
          PROXY_SECRET_PARAMETER: PARAMETERS.proxySecret,
          TURNSTILE_SECRET_PARAMETER: PARAMETERS.turnstileSecret,
          TRUSTED_PROXY_HOPS: '1',
        }),
      },
    });
  });

  it('gives the function only what it needs: one table action, three parameters, SES send', () => {
    expect(statementsOf('Contact').flatMap((s) => s.Action).sort()).toEqual(['dynamodb:UpdateItem', 'ses:SendEmail', 'ssm:GetParameter']);
  });

  it('lets the function send only from the configured sender to the configured inbox', () => {
    const ses = statementsOf('Contact').find((s) => s.Action === 'ses:SendEmail');
    expect(ses?.Condition).toEqual({
      StringEquals: { 'ses:FromAddress': 'team@braid.example' },
      'ForAllValues:StringEquals': { 'ses:Recipients': ['team@braid.example'] },
    });
  });

  it('lets only the site-production environment of this exact repository (by ID) assume the publish role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:braidjs@316401299/braid@1326724459:environment:site-production',
              },
            },
          }),
        ],
      },
    });
  });

  it('lets the publish role publish to Amplify and nothing else: no CDK roles, no infrastructure', () => {
    expect(statementsOf('PublishRole').flatMap((s) => s.Action).sort()).toEqual(['amplify:CreateDeployment', 'amplify:GetJob', 'amplify:StartDeployment']);
  });

  it('scopes the publish role to the main branch, its deployments and its jobs', () => {
    // CreateDeployment is authorized against branches/main/deployments/*, which the service
    // authorization reference does not list; without it the first publish is denied.
    const resources = JSON.stringify(statementsOf('PublishRole').flatMap((s) => s.Resource));
    for (const suffix of ['/branches/main"', '/branches/main/deployments/*"', '/branches/main/jobs/*"']) expect(resources).toContain(suffix);
  });

  it('expires rate-limit counters on their own', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', { TimeToLiveSpecification: { AttributeName: 'expires', Enabled: true } });
  });
});

describe('amplifyHeaders', () => {
  it('produces YAML that parses to every header, on every path', () => {
    const yaml = parse(amplifyHeaders([['Content-Security-Policy', "default-src 'self'"], ['X-Frame-Options', 'DENY']]));
    expect(yaml).toEqual({
      customHeaders: [
        {
          pattern: '**',
          headers: [
            { key: 'Content-Security-Policy', value: "default-src 'self'" },
            { key: 'X-Frame-Options', value: 'DENY' },
          ],
        },
      ],
    });
  });
});
