#!/usr/bin/env node

/**
 * The `braid` binary.
 *
 * **Every command is loaded lazily, and that is a correctness property rather than a startup
 * optimisation.** `@braidlabs/gateway` and `@braidlabs/registry` are *peer* dependencies, so a
 * workspace can legitimately have one and not the other — and with static imports at the top of this
 * file, `braid detangle` crashed with `ERR_MODULE_NOT_FOUND: @braidlabs/gateway` in a workspace that
 * had no gateway installed, despite detangle never touching it. The failure named a package the user
 * had no reason to think they needed, from a file they had never heard of (`dev-server.js`).
 *
 * So each command imports its own module when it is chosen:
 *
 * | command | what it actually needs |
 * | --- | --- |
 * | `dev` | `@braidlabs/gateway` |
 * | `registry` | `@braidlabs/registry`, and gateway's types |
 * | `init`, `add`, `detangle` | nothing beyond node |
 */

const USAGE = `braid — compose independently deployed frontends

  braid dev [--config <path>]     run the composed app locally, live reload intact
  braid init [--force]            write a starter braid.config.json
  braid add <id> [options]        register a fragment
      --endpoint <url>              where the fragment is served
      --port <n>                    dev port (implies http://localhost:<n>)
      --pierce <pattern>            page routes to server-render it into (repeatable)
  braid detangle [options]        convert a Module Federation workspace to Braid
      --shell <project>             the host to convert (inferred when unambiguous)
      --cwd <path>                  workspace root (defaults to the current directory)
      --diff                        show what --write would change
      --write                       apply it (refuses on a dirty tree or a blocking finding)
      --force                       override those refusals
      --remove-mf                   check whether the federation config can be stripped
  braid registry <subcommand>     validate, diff, or publish the registry
      validate                      check the local registry for conflicts
      diff --against <ref>          compare local config to a published snapshot
      publish --to <dir>            mint an immutable snapshot from local config
`;

type Command = (argv: string[]) => Promise<number>;

const commands: Record<string, () => Promise<Command>> = {
  dev: async () => (await import('./lib/commands.js')).dev,
  init: async () => (await import('./lib/commands.js')).init,
  add: async () => (await import('./lib/commands.js')).add,
  detangle: async () => (await import('./lib/detangle/index.js')).detangle,
  registry: async () => (await import('./lib/registry-commands.js')).registry,
};

const [command, ...argv] = process.argv.slice(2);
const load = command ? commands[command] : undefined;

if (!load) {
  process.stdout.write(USAGE);
  process.exit(command && command !== '--help' && command !== '-h' ? 1 : 0);
}

load()
  .then((run) => run(argv))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    /**
     * A missing peer is reported as a missing peer.
     *
     * Node's own message names the importing file, which for a peer dependency is an internal module
     * the user has never seen. Naming the package and the install command instead is the difference
     * between a two-minute fix and a bug report.
     */
    const missingPeer = /Cannot find package '(@braidlabs\/[\w-]+)'/.exec(message)?.[1];
    if (missingPeer) {
      process.stderr.write(
        `braid ${command}: this command needs ${missingPeer}, which is not installed.\n` +
          `  npm install ${missingPeer}\n`,
      );
      process.exit(1);
    }

    process.stderr.write(`braid: ${message}\n`);
    process.exit(1);
  });
