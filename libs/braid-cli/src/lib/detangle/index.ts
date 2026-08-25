import { discoverProjects } from './discovery.js';
import { findRemoteMounts } from './routes.js';
import { DetanglePlan, Finding, buildPlan, toBraidConfig } from './plan.js';
import { DetangleRefusal, applyPlan, isGitRepository, previewWrite } from './write.js';
import { findMiddlewareInsertion, scaffoldGatewayApp } from './gateway.js';
import { detectFramework, planShellTransform } from './shell.js';
import { checkRemoveModuleFederation, findDeepImports, validateFragmentEndpoints } from './validate.js';

export { buildPlan, toBraidConfig } from './plan.js';
export type { DetanglePlan, PlannedFragment, Finding } from './plan.js';
export { parseModuleFederationConfig } from './mf-config.js';
export { discoverProjects, inferShell } from './discovery.js';
export { findRemoteMounts, scanSource, piercePatterns } from './routes.js';
export { applyPlan, previewWrite, dirtyFiles, DetangleRefusal } from './write.js';
export { scaffoldGatewayApp, findMiddlewareInsertion } from './gateway.js';
export type { GatewayScaffold, MiddlewareInsertion } from './gateway.js';
export { planShellTransform, detectFramework } from './shell.js';
export type { ShellTransform, ShellEdit } from './shell.js';
export { validateFragmentEndpoints, checkRemoveModuleFederation, findDeepImports } from './validate.js';

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/**
 * `braid detangle` — read a Module Federation workspace and report what Braid would do to it.
 *
 * **Phase 1 of the plan: it writes nothing.** `--write` is recognised and refused, deliberately, so
 * that the flag's absence is a stated fact rather than something a user discovers by having their
 * workspace half-converted.
 *
 * The command's default was always going to be a dry run; shipping discovery alone just makes the
 * default the only mode for now. It is the phase that de-risks the rest, because the transforms are
 * only worth writing once the topology they would act on is demonstrably right.
 */
export async function detangle(argv: string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const workspaceRoot = options.cwd ?? process.cwd();

  const projects = await discoverProjects(workspaceRoot);
  if (projects.length === 0) {
    process.stderr.write(
      `braid detangle: no project.json found under ${workspaceRoot}\n` +
        `  detangle reads an Nx workspace; run it from the workspace root.\n`,
    );
    return 1;
  }

  const shellGuess =
    projects.find((project) => project.name === options.shell) ??
    projects.find((project) => (project.mf?.remotes.length ?? 0) > 0);

  const mounts = shellGuess
    ? await findRemoteMounts(
        workspaceRoot,
        shellGuess.root,
        (shellGuess.mf?.remotes ?? []).map((remote) => remote.name),
      )
    : [];

  const plan = buildPlan({
    projects,
    mounts,
    ...(options.shell === undefined ? {} : { requestedShell: options.shell }),
  });

  /**
   * Checks that need the whole workspace, folded in before the report is rendered so that a
   * blocking one actually blocks `--write` rather than merely printing after the verdict line.
   */
  plan.findings.push(...validateFragmentEndpoints(plan, projects));
  if (options.removeMf) plan.findings.push(...checkRemoveModuleFederation(plan, projects));
  plan.findings.push(...(await deepImportFindings(workspaceRoot, plan, shellGuess)));
  plan.writable = !plan.findings.some((finding) => finding.level === 'block');

  process.stdout.write(render(plan, projects.length));

  /**
   * The remaining work, reported whether or not `--write` runs.
   *
   * These are the phase-3-to-5 pieces: what the shell needs, and where the gateway goes. They are
   * described rather than applied, which is the plan's rule for anything that edits code somebody
   * wrote — and it is why the report is the product.
   */
  let shellEdits: Awaited<ReturnType<typeof planShellTransform>> | undefined;
  if (plan.shell) {
    const framework = await detectFramework(workspaceRoot, plan.shell.root);
    shellEdits = await planShellTransform(workspaceRoot, plan, framework);
    const gateway =
      plan.gateway === 'existing-server'
        ? await findMiddlewareInsertion(workspaceRoot, plan.shell.root)
        : undefined;

    process.stdout.write(renderRemainingWork(shellEdits, gateway, plan, framework));
  }

  if (options.diff) {
    const preview = await previewWrite(workspaceRoot, plan, options.port);
    process.stdout.write(
      preview ? `${DIM}  braid.config.json${RESET}\n${preview}\n` : `${DIM}  braid.config.json is already up to date.${RESET}\n\n`,
    );
  }

  if (!options.write) {
    if (!options.diff) {
      process.stdout.write(`${DIM}  Re-run with --diff to see the config, or --write to apply it.${RESET}\n\n`);
    }
    return plan.writable ? 0 : 1;
  }

  if (!(await isGitRepository(workspaceRoot))) {
    process.stdout.write(
      `${DIM}  Not a git repository — the usual undo (git checkout) is not available here.${RESET}\n\n`,
    );
  }

  try {
    const result = await applyPlan({
      workspaceRoot,
      plan,
      force: options.force,
      ...(options.port === undefined ? {} : { port: options.port }),
      /**
       * Opt-in, and separately. `--write` alone stays the conservative thing it has always been:
       * one file nobody wrote. Scaffolding an app and editing a shell are each a step further from
       * that, so each is asked for by name rather than inherited from one flag.
       */
      gateway: options.gateway,
      shell: options.shellEdits,
      ...(shellEdits ? { shellEdits: shellEdits.edits } : {}),
    });

    for (const path of result.written) process.stdout.write(`  wrote  ${path}\n`);
    for (const skip of result.skipped) process.stdout.write(`  kept   ${skip.path}  ${DIM}${skip.reason}${RESET}\n`);
    process.stdout.write(`\n${DIM}  Next: braid dev${RESET}\n\n`);

    /**
     * What was *not* done is stated at the point a user would otherwise assume it was. A developer
     * who reads "wrote braid.config.json" and believes their shell's routes were converted has been
     * misled by omission, and the omission is the part they will not think to check.
     */
    const remaining: string[] = [];
    if (!options.gateway && plan.gateway === 'scaffold') remaining.push('the gateway app (--gateway)');
    if (!options.shellEdits) remaining.push("the shell's runtime import, hydration, and routes (--shell)");
    if (options.shellEdits) {
      const manual = (shellEdits?.edits ?? []).filter((edit) => edit.kind === 'manual').length;
      if (manual > 0) remaining.push(`${manual} shell edit${manual === 1 ? '' : 's'} left manual — see above`);
    }

    if (remaining.length > 0) {
      process.stdout.write(`${DIM}  Not done: ${remaining.join('; ')}.${RESET}\n\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof DetangleRefusal) {
      process.stderr.write(`\nbraid detangle: ${error.message}\n  ${error.fix}\n\n`);
      return 1;
    }
    throw error;
  }
}

const USAGE = `braid detangle — convert a Module Federation workspace to Braid

  braid detangle [options]

      --shell <project>   the host to convert (inferred when unambiguous)
      --cwd <path>        workspace root (defaults to the current directory)
      --port <n>          port for the composed app (default 4000)
      --diff              show the braid.config.json that --write would produce
      --write             write it. Refuses on a dirty git tree or a blocking finding
      --force             override those refusals, and replace an existing config
      --remove-mf         check whether the federation config can be stripped (reports only)
      --gateway           with --write, also scaffold the gateway app (new files only)
      --shell-edits       with --write, also apply the shell edits that can be applied safely

  The default writes nothing.
`;

interface Options {
  shell?: string;
  cwd?: string;
  port?: number;
  write: boolean;
  diff: boolean;
  force: boolean;
  removeMf: boolean;
  gateway: boolean;
  shellEdits: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { write: false, diff: false, force: false, removeMf: false, gateway: false, shellEdits: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shell') options.shell = argv[++i];
    else if (arg === '--cwd') options.cwd = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--write') options.write = true;
    else if (arg === '--diff') options.diff = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--remove-mf') options.removeMf = true;
    else if (arg === '--gateway') options.gateway = true;
    else if (arg === '--shell-edits') options.shellEdits = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

/**
 * The report — which the plan calls the product, so it is built from the plan data rather than
 * assembled inline as the discovery runs.
 *
 * Ordered so the two questions a reader actually has come first — *what did you find* and *what do
 * I have to decide* — and every finding carries its fix inline rather than in a legend at the
 * bottom. A report whose warnings need cross-referencing does not get read.
 */
export function render(plan: DetanglePlan, projectCount: number): string {
  const lines: string[] = [];
  const push = (...next: string[]) => lines.push(...(next.length === 0 ? [''] : next));

  push();
  if (!plan.shell) {
    push(`${BOLD}braid detangle${RESET} — nothing to convert`);
    push(`${DIM}  scanned ${projectCount} project${projectCount === 1 ? '' : 's'}${RESET}`);
    push();
    push(...plan.findings.map(finding));
    push();
    return lines.join('\n');
  }

  push(`${BOLD}braid detangle${RESET} — ${plan.shell.root}`);
  push(`${DIM}  scanned ${projectCount} project${projectCount === 1 ? '' : 's'}${RESET}`);
  push();

  const gateway =
    plan.gateway === 'existing-server'
      ? 'middleware into the existing server'
      : `NEW app (${plan.shell.name} has no server target)`;

  const slots = `${plan.fragments.length} slot${plan.fragments.length === 1 ? '' : 's'}`;
  push(`  Shell     ${pad(plan.shell.name, 16)} -> host, ${slots}`);
  push(`  Gateway   ${pad('', 16)} -> ${gateway}`);
  push();

  if (plan.fragments.length > 0) {
    push(`  ${BOLD}Fragments${RESET}`);
    for (const fragment of plan.fragments) {
      const hasPort = fragment.port !== undefined;
      const port = hasPort ? `:${fragment.port}` : 'no port';
      const where = fragment.pierce.length > 0 ? fragment.pierce.join(' ') : dim('pierce unknown');
      const from = fragment.from ? dim(`  from ${fragment.from}`) : '';
      const bound = fragment.bound ? 'bound' : 'unbound';
      const column = pad(port, 8);
      push(`    ${pad(fragment.id, 14)} ${hasPort ? column : dim(column)} ${pad(bound, 8)} ${where}${from}`);
    }
    push();
  }

  if (plan.findings.length > 0) {
    push(`  ${BOLD}Findings${RESET}`);
    push(...plan.findings.map(finding));
    push();
  }

  push(
    plan.writable
      ? `${DIM}  Nothing blocks a conversion.${RESET}`
      : `${DIM}  Resolve the blocking findings before converting.${RESET}`,
  );
  push();
  return lines.join('\n');
}

function finding(item: Finding): string {
  const mark = item.level === 'block' ? '✗' : item.level === 'warn' ? '⚠' : '·';
  const fix = item.fix ? `\n      ${DIM}${item.fix}${RESET}` : '';
  return `    ${mark}  ${item.message}${fix}`;
}

/**
 * Pads **plain** text, and is only ever given plain text.
 *
 * The first version padded the coloured string and stripped escapes to measure it. That works and
 * is the wrong shape: `padEnd` counts escape bytes, so every column silently shreds in a coloured
 * terminal unless the stripping is exactly right, and the stripping needs a control character in a
 * regex that lint correctly refuses. Colouring *after* padding removes the problem rather than
 * measuring around it.
 */
function pad(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

/** Wraps already-padded plain text in a colour, so width and colour never interact. */
function dim(value: string): string {
  return `${DIM}${value}${RESET}`;
}

/** Deep imports across a remote boundary, which have no Braid equivalent. */
async function deepImportFindings(
  workspaceRoot: string,
  plan: DetanglePlan,
  shell: { root: string; mf?: { remotes: Array<{ name: string }> } } | undefined,
): Promise<Finding[]> {
  if (!shell || !plan.shell) return [];
  const remoteNames = (shell.mf?.remotes ?? []).map((remote) => remote.name);
  if (remoteNames.length === 0) return [];

  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const findings: Finding[] = [];

  // Only the files a mount was already found in: a full re-walk to find imports would double the
  // scan cost for a check that is, in practice, about the same handful of files.
  const files = new Set(plan.fragments.map((fragment) => fragment.from).filter((file): file is string => Boolean(file)));
  for (const file of files) {
    try {
      findings.push(...findDeepImports(await readFile(join(workspaceRoot, file), 'utf-8'), file, remoteNames));
    } catch {
      // A file named in a mount that cannot be read is already reported elsewhere.
    }
  }
  return findings;
}

/**
 * The edits detangle would make to the shell, and where the gateway goes.
 *
 * Printed as a checklist rather than applied, because every item is an edit to a file a human wrote
 * and the plan's rule is that those are proposed. An item with `text` is one a later phase can
 * automate; an item without is one where locating the exact "before" is not reliable enough to try.
 */
function renderRemainingWork(
  shellWork: Awaited<ReturnType<typeof planShellTransform>>,
  gateway: Awaited<ReturnType<typeof findMiddlewareInsertion>>,
  plan: DetanglePlan,
  framework: string,
): string {
  const lines: string[] = [];

  if (shellWork.edits.length > 0) {
    lines.push(`  ${BOLD}Shell${RESET} ${DIM}(${framework})${RESET}`);
    for (const edit of shellWork.edits) {
      const where = edit.line === undefined ? edit.file : `${edit.file}:${edit.line}`;
      lines.push(`    ${edit.summary}`);
      lines.push(`      ${DIM}${where} — ${edit.why}${RESET}`);
    }
    lines.push('');
  }

  for (const followUp of shellWork.followUps) {
    lines.push(`    ${DIM}${followUp}${RESET}`);
  }
  if (shellWork.followUps.length > 0) lines.push('');

  lines.push(`  ${BOLD}Gateway${RESET}`);
  if (gateway) {
    const where = gateway.line === undefined ? gateway.file : `${gateway.file}:${gateway.line}`;
    lines.push(`    add the middleware in ${where}`);
    lines.push(`      ${DIM}${gateway.note}${RESET}`);
  } else {
    const scaffold = scaffoldGatewayApp(plan);
    lines.push(`    scaffold ${Object.keys(scaffold.files).length} files:`);
    for (const file of Object.keys(scaffold.files)) lines.push(`      ${DIM}${file}${RESET}`);
    for (const followUp of scaffold.followUps) lines.push(`      ${DIM}${followUp}${RESET}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** Exposed so a caller can see the config the plan would emit, without running the command. */
export function previewConfig(plan: DetanglePlan): string {
  return JSON.stringify(toBraidConfig(plan), null, 2);
}
