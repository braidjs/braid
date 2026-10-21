import { createRoot } from 'react-dom/client';
import { ConsoleApp } from './console-app.js';
import type { ConsoleApi } from '../lib/client.js';
import type { AuthConfig } from './auth.js';
import { ensureStyles } from '../lib/styles.js';

/**
 * Standalone entry — the deployable form.
 *
 * Configuration comes from the DOM rather than a build-time constant, so one bundle serves every
 * environment: the same artifact staging tested is the artifact production runs, pointed
 * elsewhere. Drop a `<script type="application/json" id="braid-console-config">` next to the mount
 * point, or leave it out and the console reads the origin it was served from.
 */
const mount = document.getElementById('root');
if (!mount) throw new Error('braid-console: no #root element to mount into');

const config = readConfig();

const root = createRoot(mount);
const { auth, edit, ...api } = config;

// Read-only unless the deployment says otherwise. Editing needs a write API the gateway may not
// have mounted, and defaulting to an editor that cannot save is a worse first impression than a
// listing that works — so `edit` adds a tab rather than replacing the console with one.
//
// With `auth`, nothing renders until there is a session: every request would otherwise go out
// anonymous and come back 401, which is noise, not information. The sign-in code is loaded only
// in this branch.
if (auth) {
  // Something to see while the sign-in code loads and the issuer answers, instead of a blank page.
  ensureStyles();
  root.render(
    <div className="braid-console">
      <p className="braid-console__empty" role="status">
        Signing in…
      </p>
    </div>,
  );
  import('./auth.js')
    .then(({ signIn }) => signIn(auth))
    .then(
      (session) => root.render(<ConsoleApp api={{ ...api, headers: session.headers }} edit={edit === true} session={session} />),
      (error: unknown) => {
        ensureStyles();
        root.render(<SignInFailed error={error} />);
      },
    );
} else {
  root.render(<ConsoleApp api={api} edit={edit === true} />);
}

function SignInFailed({ error }: { error: unknown }) {
  return (
    <div className="braid-console">
      <div className="braid-console__error" role="alert">
        <h3>Could not sign in</h3>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        <button className="braid-console__retry" type="button" onClick={() => location.assign(location.pathname)}>
          Try again
        </button>
      </div>
    </div>
  );
}

type Config = Pick<ConsoleApi, 'baseUrl' | 'discoveryPath' | 'apiPath'> & { edit?: boolean; auth?: AuthConfig };

function readConfig(): Config {
  const element = document.getElementById('braid-console-config');
  if (!element?.textContent) return {};
  try {
    return JSON.parse(element.textContent) as Config;
  } catch {
    console.warn('braid-console: #braid-console-config is not valid JSON; using defaults');
    return {};
  }
}
