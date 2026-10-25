import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { amplifyHeaders, PARAMETERS, SiteStack } from './stack';

const workspace = resolve(import.meta.dirname, '../../..');
let template: Template;

beforeAll(() => {
  const app = new App();
  const stack = new SiteStack(app, 'Test', {
    env: { account: '111111111111', region: 'us-east-1' },
    contactTo: 'team@braid.example',
    githubRepo: 'braidjs/braid',
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
  it('proxies /api/contact to the contact function, so the form stays same-origin', () => {
    template.hasResourceProperties('AWS::Amplify::App', {
      CustomRules: [{ Source: '/api/contact', Status: '200', Target: { 'Fn::Join': ['', [Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['FunctionUrl']) }), 'api/contact']] } }],
    });
  });

  it('runs the function on Node 24 with the configuration the adapter reads', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Environment: {
        Variables: Match.objectLike({
          CONTACT_TO: 'team@braid.example',
          SITE_ORIGIN_PARAMETER: PARAMETERS.siteOrigin,
          TURNSTILE_SECRET_PARAMETER: PARAMETERS.turnstileSecret,
          TRUSTED_PROXY_HOPS: '1',
        }),
      },
    });
  });

  it('gives the function only what it needs: one table action, two parameters, SES send', () => {
    const policies = template.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp('^Contact') } });
    const actions = Object.values(policies).flatMap((p) =>
      (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument.Statement.flatMap((s) => s.Action),
    );
    expect(actions.sort()).toEqual(['dynamodb:UpdateItem', 'ses:SendEmail', 'ses:SendRawEmail', 'ssm:GetParameter']);
  });

  it('lets only braidjs/braid on main assume the deploy role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:braidjs/braid:ref:refs/heads/main',
              },
            },
          }),
        ],
      },
    });
  });

  it('limits the deploy role to the CDK bootstrap roles and this app’s main-branch deployments', () => {
    const policies = template.findResources('AWS::IAM::Policy', { Properties: { PolicyName: Match.stringLikeRegexp('^DeployRole') } });
    const actions = Object.values(policies).flatMap((p) =>
      (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties.PolicyDocument.Statement.flatMap((s) => s.Action),
    );
    expect(actions.sort()).toEqual(['amplify:CreateDeployment', 'amplify:GetJob', 'amplify:StartDeployment', 'sts:AssumeRole']);
  });

  it('expires rate-limit counters on their own', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', { TimeToLiveSpecification: { AttributeName: 'expires', Enabled: true } });
  });
});

describe('amplifyHeaders', () => {
  it('applies every header to every path, quoting values safely for YAML', () => {
    const yaml = amplifyHeaders([["Content-Security-Policy", "default-src 'self'"]]);
    expect(yaml).toContain("pattern: '**'");
    expect(yaml).toContain("key: 'Content-Security-Policy'");
    expect(yaml).toContain("value: 'default-src ''self'''");
  });
});
