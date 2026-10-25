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
- **`/api/contact`** is an Amplify rewrite to a secret path on a **Lambda** Function URL
  (`aws/lambda.ts`), so the form posts to its own origin and a direct call to the Function URL gets a
  404. The Lambda runs the same handler as local dev (`api/contact.ts`), emails through **SES**,
  rate-limits with a **DynamoDB** counter, and checks **Turnstile**.

Two kinds of change, two paths:

- **Site content** (any change under `apps/site/src`, the fragments, the styles) publishes itself: a
  push to `main` runs `.github/workflows/site.yml`. Its publish job assumes a role, through GitHub's
  OIDC token, that can do nothing but publish to this Amplify app. There are no AWS keys in GitHub.
- **Infrastructure** (`infra/`, `aws/`, `api/`) is deployed by a person with
  `npx nx run site:infra-deploy`, signed in as an admin. CI deliberately can't change it: anything
  CI runs, every npm package included, could otherwise reach the whole account.

Anyone who can merge to `main` can publish the site, so protect `main` with required reviews.

## One-time setup

Do these once, in order, signed in as a non-root administrator. Replace `<account-id>` with yours.

1. **Stop using the root user.** In IAM Identity Center, create a user with the `AdministratorAccess`
   permission set, then sign the CLI in with it:
   ```bash
   aws configure sso
   ```
   `aws sts get-caller-identity` should now show an `AWSReservedSSO_…` role, not `:root`.
2. **Verify the inbox in SES** (us-east-1): *Amazon SES → Identities → Create identity → Email
   address*, then click the link in the email. Enquiries are sent to this address, and from it too
   unless you set `CONTACT_FROM`, which must be verified as well.
3. **Get Turnstile keys** from a free Cloudflare account (*Turnstile → Add widget*). You'll add the
   site's hostname to the widget after step 6.
4. **Store the two secrets** in SSM, in us-east-1:
   ```bash
   aws ssm put-parameter --region us-east-1 --name /braid-site/turnstile-secret --type SecureString --value '<turnstile secret>'
   aws ssm put-parameter --region us-east-1 --name /braid-site/proxy-secret --type String --value "$(openssl rand -hex 32)"
   ```
5. **Bootstrap CDK** in the account (creates the roles and bucket CDK deploys through):
   ```bash
   npx cdk bootstrap aws://<account-id>/us-east-1
   ```
6. **Deploy the stack:**
   ```bash
   CONTACT_TO=<inbox> npx nx run site:infra-deploy
   ```
   If the account already has a GitHub OIDC provider, add `GITHUB_OIDC_PROVIDER_ARN=<its ARN>`. If
   the deploy fails because the account can't reserve Lambda concurrency (new accounts sometimes
   can't), add `CONTACT_RESERVED_CONCURRENCY=none`. The outputs are in
   `apps/site/infra/cdk.out/outputs.json`. Add the `SiteUrl` hostname to the Turnstile widget.
7. **Point the domain at Amplify.** The site's hostname is set in `infra/app.ts`
   (`oss.braidcloud.com`). The stack attaches that hostname, and only that hostname, to the Amplify
   app. Its DNS zone is in another account (braid-cloud-prod), so Amplify can't add the records
   itself. Read the two CNAMEs it wants, one to validate the certificate and one for the site:
   ```bash
   aws amplify get-domain-association --app-id <app-id> --domain-name oss.braidcloud.com --query 'domainAssociation.{status:domainStatus,cert:certificateVerificationDNSRecord,site:subDomains[0].dnsRecord}'
   ```
   Add both to the `braidcloud.com` zone with `aws route53 change-resource-record-sets --profile
   braid-prod` (UPSERT, CNAME, TTL 300). Do it right away: Amplify stops waiting after a while.
   The site is live once the status is `AVAILABLE`.
   `main.<app-id>.amplifyapp.com` keeps serving the site, but its contact form returns 403, because
   the form accepts posts only from the hostname. To undo all of this, revert the change, redeploy,
   and delete the two records.
8. **In GitHub**, create the environment `site-production` (*Settings → Environments*), limited to
   the `main` branch. Then set three repository variables (*Settings → Secrets and variables →
   Actions → Variables*): `AWS_PUBLISH_ROLE_ARN` and `AMPLIFY_APP_ID` from the stack's outputs, and
   `TURNSTILE_SITEKEY` from step 3.
9. **Publish the first build** by running the *Site* workflow from the Actions tab. After that,
   every push to `main` that touches the site publishes it.

## Checks for the first deploy

- **The visitor's IP.** The rate limit keys on the visitor's IP, found by counting
  `TRUSTED_PROXY_HOPS` (1) proxies in from the right of `X-Forwarded-For`. Submit the form once, then
  check in the Lambda's logs or with a temporary log line that the address it saw is yours. If it's
  an AWS address instead, Amplify adds a proxy hop: raise `TRUSTED_PROXY_HOPS` in `infra/stack.ts`.
- **The rewrite.** A plain form post (JavaScript off) and a normal submission should both arrive.

Later infrastructure changes: `CONTACT_TO=<inbox> npx nx run site:infra-diff`, then `infra-deploy`.
