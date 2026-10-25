# The Braid site

The public website, built into plain static files. Each homepage section is a contract fragment,
booted from a `blob:` realm. The page itself needs no server, and every section is prerendered so it
reads fine before JavaScript runs.

| Command | What it does |
| --- | --- |
| `npx nx build site` | builds `dist/apps/site` |
| `npx nx run site:serve` | serves the build at <http://localhost:4600> |
| `npx nx run site:dev` | the same, plus a working contact form at <http://localhost:8787> (emails are printed, not sent) |
| `npx nx test site` | build output, the contact handler, the Lambda adapter, the form script and the AWS stack |
| `npx nx run site:infra-synth` / `infra-diff` / `infra-deploy` | the AWS stack (needs `CONTACT_TO`; see below) |

## How it's hosted

On AWS, in one CDK stack (`infra/stack.ts`):

- **Amplify Hosting** serves the static files. GitHub Actions builds them and publishes each build as
  an Amplify deployment; Amplify never builds or reads the repository.
- **`/api/contact`** is an Amplify rewrite to a **Lambda** (`aws/lambda.ts`), so the form posts to its
  own origin. The Lambda runs the same handler as local dev (`api/contact.ts`), emails through **SES**,
  rate-limits with a **DynamoDB** counter, and checks **Turnstile**.
- Pushes to `main` deploy through `.github/workflows/site.yml`, which assumes a deploy role through
  GitHub's OIDC token. There are no AWS keys in GitHub.

## One-time setup

Do these once, in order. Steps 1–5 are in the AWS and Cloudflare consoles; after that it's commands.

1. **Stop using the root user.** In IAM Identity Center, create a user with the `AdministratorAccess`
   permission set, then sign the CLI in with it:
   ```bash
   aws configure sso
   ```
   Check you're not root: `aws sts get-caller-identity` should show an `AWSReservedSSO_…` role, not
   `:root`.
2. **Verify the inbox in SES** (us-east-1): *Amazon SES → Identities → Create identity → Email
   address*, then click the link in the email. Enquiries are sent to, and from, this address.
3. **Get Turnstile keys** from a free Cloudflare account: *Turnstile → Add widget*, with your site's
   hostname. You can add the `amplifyapp.com` hostname after step 7.
4. **Store the Turnstile secret** in SSM as a SecureString:
   ```bash
   aws ssm put-parameter --region us-east-1 --name /braid-site/turnstile-secret --type SecureString --value '<secret>'
   ```
5. **Bootstrap CDK** in the account (creates the roles and bucket CDK deploys through):
   ```bash
   npx cdk bootstrap aws://706240877791/us-east-1
   ```
6. **Deploy the stack once by hand.** This also creates the role CI uses:
   ```bash
   CONTACT_TO=<inbox> SITE_TURNSTILE_SITEKEY=<site key> npx nx run site:infra-deploy
   ```
   If the account already has a GitHub OIDC provider, add `GITHUB_OIDC_PROVIDER_ARN=<its ARN>`.
7. **Set the repository variables** from the stack's outputs (`apps/site/infra/cdk.out/outputs.json`),
   under *Settings → Secrets and variables → Actions → Variables*: `AWS_DEPLOY_ROLE_ARN`,
   `CONTACT_TO` and `TURNSTILE_SITEKEY`. Add the `SiteUrl` hostname to the Turnstile widget.

From then on, every push to `main` that touches the site deploys it. To publish the first build
without waiting for a push, run the *Site* workflow from the Actions tab.
