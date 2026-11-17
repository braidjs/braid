#!/usr/bin/env node
/**
 * Fails when a server-driven UI state has a name and no specification.
 *
 * `libs/sdui/src/lib/states.ts` lists every state a session, a screen, a node and an action can be
 * in. A name there is a promise that the state has been thought through: when it happens and what
 * the user sees. The vectors in `libs/sdui/conformance/states/` are where that promise is kept —
 * facts in, state out — and they are what a client in another language is tested against.
 *
 * So the two must agree in both directions:
 *
 *   - every state has at least one vector (a state nobody specified), and
 *   - every vector names a state that exists (a specification for a state that was renamed away).
 *
 * The lists are only the whole truth if nothing else can produce a state, so this also holds the
 * file to a shape in which the compiler guarantees that: each state type is exactly its list, each
 * resolver is declared as returning exactly its state type, and the file has none of the things
 * that tell the compiler to take a value's type on trust — a cast, `any`, a type predicate, a
 * `declare`, a `@ts-` directive.
 *
 * It reads the file with the TypeScript parser, so it sees what the compiler sees: a declaration
 * in a comment or a string is not one. It reads that one file. A state invented in another is
 * outside its view, and so is a value typed `any` by a library, as `JSON.parse` gives. It is a
 * guard against mistakes, not against someone set on getting round it.
 *
 * It reads the source rather than importing the built package, so it runs before a build and
 * cannot be satisfied by a stale `dist/`.
 *
 *   node tools/sdui/check-state-matrix.mjs [--states <states.ts>] [--vectors <dir>]
 *
 * Exits 1 listing every gap, not just the first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(new URL('../../', import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? resolve(args[index + 1]) : fallback;
};
const statesPath = flag('states', join(root, 'libs/sdui/src/lib/states.ts'));
const vectorsDir = flag('vectors', join(root, 'libs/sdui/conformance/states'));

/** Each list, the level it describes, its type, and the resolver that returns that type. */
const LISTS = {
  SESSION_STATES: {
    level: 'session',
    type: 'SessionState',
    resolver: 'resolveSessionState',
    returns: '{state:SessionState;source:UiSource;}',
  },
  SCREEN_STATES: {
    level: 'screen',
    type: 'ScreenState',
    resolver: 'resolveScreenState',
    returns: '{state:ScreenState;source:UiSource;}',
  },
  NODE_STATES: {
    level: 'node',
    type: 'NodeState',
    resolver: 'resolveNodeStates',
    returns: 'NodeState[]',
  },
  ACTION_STATES: {
    level: 'action',
    type: 'ActionState',
    resolver: 'resolveActionState',
    returns: 'ActionState',
  },
};
const failures = [];
const finish = () => {
  if (failures.length > 0) {
    process.stderr.write(
      `state matrix: ${failures.length} problem${failures.length === 1 ? '' : 's'}\n${failures.map((failure) => `  - ${failure}\n`).join('')}`,
    );
    process.exit(1);
  }
};

const raw = readFileSync(statesPath, 'utf8');
// A states file is a few hundred lines. One far beyond that is not one, and is not parsed.
if (raw.length > 500_000) {
  failures.push(
    `${statesPath} is ${raw.length} characters — too large to be a list of states`,
  );
  finish();
}
let file;
try {
  file = ts.createSourceFile(
    statesPath,
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
} catch (error) {
  failures.push(`${statesPath} could not be parsed (${error.message})`);
  finish();
}
if (file.parseDiagnostics.length > 0) {
  failures.push(
    `${statesPath} does not parse: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, ' ')}`,
  );
  finish();
}
if (/@ts-(?:ignore|expect-error|nocheck)/.test(raw))
  failures.push(
    `a "@ts-" directive in ${statesPath} — it tells the compiler not to check a line, and this check relies on the compiler`,
  );

const text = (node) => node.getText(file).replace(/\s+/g, ' ');
const squeezed = (node) => node.getText(file).replace(/\s+/g, '');
const exportedAtTopLevel = (statement) =>
  statement.parent === file &&
  (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
const isConst = (type) =>
  ts.isTypeReferenceNode(type) && type.typeName.getText(file) === 'const';

// One walk of the whole tree, however a declaration is nested: everything that is named like a
// list, a state type or a resolver, and everything that takes a type on trust.
const TYPE_NAMES = new Set(Object.values(LISTS).map((list) => list.type));
const RESOLVERS = new Set(Object.values(LISTS).map((list) => list.resolver));
const lists = new Map(); // constant → its declarations
const types = new Map(); // type name → whatever declares that name
const resolvers = new Map(); // function name → its declarations
const note = (map, key, node) => map.set(key, [...(map.get(key) ?? []), node]);
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.name.text.endsWith('_STATES')) note(lists, node.name.text, node);
    if (RESOLVERS.has(node.name.text)) note(resolvers, node.name.text, node);
  }
  if (
    (ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isModuleDeclaration(node)) &&
    node.name &&
    TYPE_NAMES.has(node.name.text)
  )
    note(types, node.name.text, node);
  if (
    ts.isFunctionDeclaration(node) &&
    node.name &&
    RESOLVERS.has(node.name.text)
  )
    note(resolvers, node.name.text, node);
  if (ts.isAsExpression(node) && !isConst(node.type))
    failures.push(
      `a cast ("as ${text(node.type)}") in ${statesPath} — a value cast to a state need not be in a list; find it in the list instead`,
    );
  if (ts.isTypeAssertionExpression(node))
    failures.push(
      `a cast ("<${text(node.type)}>") in ${statesPath} — a value cast to a state need not be in a list; find it in the list instead`,
    );
  if (node.kind === ts.SyntaxKind.AnyKeyword)
    failures.push(
      `the type "any" in ${statesPath} — a value typed "any" can be returned as a state without being one`,
    );
  if (ts.isTypePredicateNode(node))
    failures.push(
      `a type predicate ("${text(node)}") in ${statesPath} — it tells the compiler a value is a state on the function's say-so`,
    );
  if (node.kind === ts.SyntaxKind.DeclareKeyword)
    failures.push(
      `a "declare" in ${statesPath} — it gives a value a type with nothing behind it`,
    );
  ts.forEachChild(node, visit);
};
try {
  visit(file);
} catch (error) {
  failures.push(`${statesPath} could not be read (${error.message})`);
  finish();
}

const declared = new Map(); // level → the names in its list
for (const [constant, declarations] of lists) {
  const known = LISTS[constant];
  if (!known) {
    failures.push(
      `${constant} is a state list this check does not know — add its level to LISTS in tools/sdui/check-state-matrix.mjs`,
    );
    continue;
  }
  if (declarations.length > 1) {
    failures.push(`${constant} is declared more than once`);
    continue;
  }
  const declaration = declarations[0];
  const statement = declaration.parent.parent;
  if (
    !ts.isVariableStatement(statement) ||
    !exportedAtTopLevel(statement) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  ) {
    failures.push(
      `${constant} must be an "export const" at the top of the file`,
    );
    continue;
  }
  // Exactly `[…] as const`, with no annotation: anything else could give the list a type that
  // admits a state it does not hold.
  const initializer = declaration.initializer;
  if (
    declaration.type ||
    !initializer ||
    !ts.isAsExpression(initializer) ||
    !isConst(initializer.type) ||
    !ts.isArrayLiteralExpression(initializer.expression)
  ) {
    failures.push(
      `${constant} must end with "] as const;" and nothing else — an annotation or a cast there can add states this check cannot see`,
    );
    continue;
  }
  const names = new Set();
  for (const element of initializer.expression.elements) {
    // Any quote style: a state written as "x" or `x` is still a state.
    if (
      !ts.isStringLiteral(element) &&
      !ts.isNoSubstitutionTemplateLiteral(element)
    ) {
      failures.push(
        `${constant} holds something other than string literals ("${text(element).slice(0, 30)}") — list every state by name`,
      );
      continue;
    }
    if (names.has(element.text))
      failures.push(
        `${known.level}: "${element.text}" is listed twice in ${constant}`,
      );
    names.add(element.text);
  }
  declared.set(known.level, names);
}

for (const [constant, known] of Object.entries(LISTS)) {
  if (!lists.has(constant))
    failures.push(`${constant} was not found in ${statesPath}`);

  // The type is exactly the list, and nothing else in the file goes by its name.
  const named = types.get(known.type) ?? [];
  const exact = `(typeof${constant})[number]`;
  if (named.length === 0)
    failures.push(
      `type ${known.type} is not declared in ${statesPath} — it must be exactly (typeof ${constant})[number]`,
    );
  else if (named.length > 1)
    failures.push(`type ${known.type} is declared more than once`);
  else if (
    !ts.isTypeAliasDeclaration(named[0]) ||
    !exportedAtTopLevel(named[0]) ||
    named[0].typeParameters ||
    squeezed(named[0].type) !== exact
  )
    failures.push(
      `type ${known.type} is not exactly (typeof ${constant})[number] — every state must be in the ${constant} list, where this check can see it`,
    );

  // The resolver says it returns exactly that type, so the compiler holds it to the list.
  const functions = resolvers.get(known.resolver) ?? [];
  const only = functions.length === 1 ? functions[0] : undefined;
  const returns =
    only && ts.isFunctionDeclaration(only) && only.type
      ? squeezed(only.type)
      : undefined;
  if (
    !only ||
    !ts.isFunctionDeclaration(only) ||
    !exportedAtTopLevel(only) ||
    only.typeParameters ||
    returns !== known.returns
  )
    failures.push(
      `${known.resolver} must be declared as returning exactly ${known.returns} — ${
        functions.length === 0
          ? 'it was not found'
          : functions.length > 1
            ? 'it is declared more than once'
            : returns === undefined
              ? 'it is not a plain exported function with a return type'
              : `it returns ${returns}`
      }`,
    );
}

let stateCount = 0;
let vectorCount = 0;
for (const [level, states] of declared) {
  const file = join(vectorsDir, `${level}.json`);
  if (!existsSync(file)) {
    failures.push(`${level}: no vector file at ${file}`);
    continue;
  }
  let vectors;
  try {
    vectors = JSON.parse(readFileSync(file, 'utf8')).vectors;
  } catch (error) {
    failures.push(`${level}: ${file} is not valid JSON (${error.message})`);
    continue;
  }
  if (!Array.isArray(vectors)) {
    failures.push(`${level}: ${file} has no "vectors" array`);
    continue;
  }
  stateCount += states.size;
  vectorCount += vectors.length;

  const specified = new Set();
  vectors.forEach((vector, index) => {
    if (
      typeof vector?.state !== 'string' ||
      typeof vector.given !== 'object' ||
      vector.given === null
    ) {
      failures.push(`${level}: vector ${index} needs a "state" and a "given"`);
      return;
    }
    specified.add(vector.state);
    if (!states.has(vector.state))
      failures.push(
        `${level}: vector ${index} is for "${vector.state}", which is not a ${level} state`,
      );
  });
  for (const state of states) {
    if (!specified.has(state))
      failures.push(
        `${level}: "${state}" has no conformance vector — say when it happens and what the user sees, in ${file}`,
      );
  }
}

finish();
process.stdout.write(
  `state matrix: ${stateCount} states, ${vectorCount} vectors, every state specified\n`,
);
