import { RegistryApiError } from './client.js';

/**
 * What to say when there is nothing to show — which is usually a setup step, not a failure.
 *
 * A 404 from the write API means it is not mounted, the common and safe case: the console is
 * read-only until someone decides otherwise. A 401 or 403 means the caller is not allowed, which
 * is the server doing its job. Neither deserves a red error box, and both deserve the next step.
 */
export type EmptyKind = 'missing-api' | 'signed-out' | 'forbidden' | 'empty';

export function emptyKindOf(error: unknown): EmptyKind | null {
  if (!(error instanceof RegistryApiError)) return null;
  if (error.status === 404) return 'missing-api';
  if (error.status === 401) return 'signed-out';
  if (error.status === 403) return 'forbidden';
  return null;
}

const MOUNT_SNIPPET = `import { createRegistryApi } from '@braidlabs/registry';
import { fileSnapshotStore } from '@braidlabs/registry/node';
import { createOidcAuthorizer } from '@braidlabs/registry/oidc';

const registryApi = createRegistryApi({
  store: fileSnapshotStore({ directory: '/var/braid/registry' }),
  ...createOidcAuthorizer({
    issuer: 'https://example.okta.com/oauth2/default',
    audience: 'api://braid-console',
  }),
});
// Beside the gateway: answer registryApi.handle(request) first — null means "not an API route".`;

export function EmptyState({
  kind,
  subject = 'shells',
  onCreate,
  onRetry,
}: {
  kind: EmptyKind;
  subject?: string;
  onCreate?: () => void;
  onRetry?: () => void;
}) {
  switch (kind) {
    case 'missing-api':
      return (
        <div className="braid-console__emptystate" role="status">
          <h3>The registry API is not mounted</h3>
          <p>
            Viewing works without it. Editing {subject} needs the write API, behind your identity provider. Until it
            is mounted this console is read-only, which is safe.
          </p>
          <pre className="braid-console__code">{MOUNT_SNIPPET}</pre>
          {onRetry && (
            <button type="button" className="braid-console__ghost" onClick={onRetry}>
              Check again
            </button>
          )}
        </div>
      );
    case 'signed-out':
      return (
        <div className="braid-console__emptystate" role="status">
          <h3>Sign in to see {subject}</h3>
          <p>The registry API needs a valid token. Your session may have expired. Sign in again to continue.</p>
          {onRetry && (
            <button type="button" className="braid-console__ghost" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      );
    case 'forbidden':
      return (
        <div className="braid-console__emptystate" role="status">
          <h3>Your role cannot read {subject}</h3>
          <p>
            You are signed in, but none of your groups or scopes grants <code>read</code>. Ask whoever runs the registry
            to add you to a group in its role map.
          </p>
        </div>
      );
    case 'empty':
      return (
        <div className="braid-console__emptystate" role="status">
          <h3>No {subject} yet</h3>
          <p>
            A shell is a page as data: its routes, a grid layout typed as ASCII art, and the fragment in each area.
            Publishing mints a new snapshot. The previous one stays, so you can always go back.
          </p>
          {onCreate && (
            <button type="button" className="braid-console__retry" onClick={onCreate}>
              Create your first shell
            </button>
          )}
        </div>
      );
  }
}
