/**
 * One command to run the POC: builds every app, starts each fragment's origin and the host's SSR
 * server, and waits until they answer.
 *
 * Host    → http://localhost:4500  Angular SSR + the Braid gateway in front of it
 * billing → http://localhost:4501  Angular SPA          (compat adapter)
 * reviews → http://localhost:4502  React 19 app         (compat adapter)
 * rating  → http://localhost:4503  a custom element     (contract custom-element adapter)
 * contract→ http://localhost:4506  a contract fragment  (no gateway route — mounted from markup)
 * notifs  → http://localhost:4505  Angular SSR app      (unbound — its own server, its own render)
 *
 * The registry console is served by the host itself at /__braid/console — same origin as the
 * gateway, so it reads the live registry and writes to the registry API with no CORS to arrange.
 */
import { execSync, spawn } from 'node:child_process';

const WORKSPACE = new URL('../../', import.meta.url).pathname;

// The gateway compiles pierce patterns with URLPattern, a global only from Node 23.8. Checking up
// front costs nothing and beats what it prevents: a build that dies partway through reporting every
// valid pierce pattern as invalid syntax.
if (typeof URLPattern === 'undefined') {
  console.error(
    `This demo needs Node 24 or newer — running Node ${process.versions.node}, which has no global URLPattern.` +
      `\n  nvm use 24   (or install it first: nvm install 24)`,
  );
  process.exit(1);
}

const HOST_PORT = 4500;
const NOTIFICATIONS_PORT = 4505;
const FRAGMENTS = [
  { label: 'billing', dir: 'dist/apps/braid-poc-remote/browser', port: 4501, spa: true },
  { label: 'reviews', dir: 'dist/apps/braid-poc-react-remote', port: 4502, spa: true },
  { label: 'rating', dir: 'dist/apps/braid-poc-widget', port: 4503, spa: false },
  /**
   * The contract fragment. `cors` rather than `spa`, and that difference is the whole point: it is
   * the only fragment the browser fetches *directly* instead of through the gateway, so it is the
   * only one that needs the header. No registry entry, no `/__braid/frag/` route.
   */
  { label: 'contract', dir: 'dist/apps/braid-poc-contract', port: 4506, cors: true },
];

// Clean up any stale processes from earlier runs holding our ports
for (const port of [HOST_PORT, NOTIFICATIONS_PORT, ...FRAGMENTS.map((f) => f.port)]) {
  try {
    const pids = execSync(`lsof -t -i :${port}`, { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        if (pid) {
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {}
        }
      }
    }
  } catch {}
}

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: WORKSPACE, stdio: 'inherit', shell: false, ...options });
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    run(command, args).on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

/**
 * Children get their port explicitly. Inheriting `PORT` from whatever launched this script would
 * silently point two servers at the same port — the second dies, and the survivor answers for
 * both, which looks like a Braid bug and is not one.
 */
function runServer(script, args, port) {
  return run('node', [script, ...args], { env: { ...process.env, PORT: String(port) } });
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetch(url);
      console.log(`✔ ${label} ready at ${url}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${label} never came up at ${url}`);
}

console.log('building the host and every fragment…');
await runToCompletion('npx', [
  'nx',
  'run-many',
  '-t',
  'build',
  '-p',
  'braid-poc-remote',
  'braid-poc-react-remote',
  'braid-poc-widget',
  'braid-poc-notifications',
  'braid-poc-host',
]);

// The console is a separate build target: a static bundle, not an Nx library output.
await runToCompletion('npx', ['nx', 'build-app', 'braid-console']);

const children = FRAGMENTS.map((fragment) =>
  runServer(
    'tools/braid-poc/serve-static.mjs',
    [fragment.dir, String(fragment.port), ...(fragment.spa ? ['--spa'] : []), ...(fragment.cors ? ['--cors'] : [])],
    fragment.port,
  ),
);
// Not a static directory like the others: this fragment renders on its own server, per request,
// which is the entire claim POC 2 makes.
children.push(runServer('dist/apps/braid-poc-notifications/server/server.mjs', [], NOTIFICATIONS_PORT));
children.push(runServer('dist/apps/braid-poc-host/server/server.mjs', [], HOST_PORT));

const shutdown = () => children.forEach((child) => child.kill());
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

for (const fragment of FRAGMENTS) {
  await waitFor(`http://localhost:${fragment.port}/`, `${fragment.label} (fragment origin)`);
}
await waitFor(`http://localhost:${NOTIFICATIONS_PORT}/panel`, 'notifications (SSR fragment origin)');
await waitFor(`http://localhost:${HOST_PORT}/`, 'host (SSR + gateway)');

console.log(
  `\nOpen http://localhost:${HOST_PORT}/billing/invoices — Angular, React and a web component on one page,` +
    `\n  with the server-rendered notifications widget in the header of every one of them.` +
    `\nRegistry console: http://localhost:${HOST_PORT}/__braid/console/` +
    `\n  Snapshots are written to .braid/registry. This gateway serves its inline manifests, so a` +
    `\n  published snapshot takes effect when a deploy pins its id — configuration changes are deploys.\n`,
);
