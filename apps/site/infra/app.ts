import { App } from 'aws-cdk-lib';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SiteStack } from './stack';

/**
 * The CDK app. Run through the CDK CLI, never directly:
 *   npx nx run site:infra-synth | infra-diff | infra-deploy
 *
 * Configured from the environment:
 *   CONTACT_TO       (required) the SES-verified inbox enquiries go to
 *   CONTACT_FROM     (optional) the sender; defaults to CONTACT_TO
 *   SITE_HOSTNAME    (optional) a custom domain, once there is one
 *   GITHUB_OIDC_PROVIDER_ARN (optional) reuse an existing GitHub OIDC provider in the account
 */

const workspace = resolve(process.env['BRAID_WORKSPACE'] ?? process.cwd());
const site = join(workspace, 'apps/site');

const contactTo = process.env['CONTACT_TO'];
if (!contactTo) throw new Error('Set CONTACT_TO to the SES-verified inbox that should receive enquiries.');

/** The site's security headers, from the same file the static build ships, so they can't drift. */
function readHeaders(): Array<[string, string]> {
  return readFileSync(join(site, 'src/static/_headers'), 'utf8')
    .split('\n')
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as [string, string];
    });
}

const app = new App();
new SiteStack(app, 'BraidSite', {
  env: { account: process.env['CDK_DEFAULT_ACCOUNT'], region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1' },
  description: 'The public Braid site: Amplify hosting, the contact form Lambda, and its deploy role.',
  contactTo,
  ...(process.env['CONTACT_FROM'] ? { contactFrom: process.env['CONTACT_FROM'] } : {}),
  ...(process.env['SITE_HOSTNAME'] ? { siteHostname: process.env['SITE_HOSTNAME'] } : {}),
  ...(process.env['GITHUB_OIDC_PROVIDER_ARN'] ? { githubOidcProviderArn: process.env['GITHUB_OIDC_PROVIDER_ARN'] } : {}),
  githubRepo: 'braidjs/braid',
  headers: readHeaders(),
  paths: {
    lambdaEntry: join(site, 'aws/lambda.ts'),
    projectRoot: workspace,
    lockFile: join(workspace, 'package-lock.json'),
    tsconfig: join(workspace, 'tsconfig.base.json'),
  },
});
