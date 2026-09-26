/**
 * Finds promises that are produced but never resolved.
 *
 * ## Why this exists
 *
 * `bun:sqlite` is synchronous, so every query call site used to be synchronous.
 * Generalising the data layer to Postgres and MySQL turned those calls into
 * promises. The type checker does not catch the resulting mistakes: Drizzle's
 * builders are awaitable, so `const row = await db.select()...` type-checks, and
 * Elysia's handler signatures are permissive, so a handler that forgets to await
 * type-checks too.
 *
 * Two distinct failures result, and both are silent at 200-OK:
 *
 * 1. **Discarded.** A bare `recordTelemetry(...)` statement. Under SQLite the
 *    write had already happened; now it is a promise nobody awaits.
 *
 * 2. **Nested.** `{ logs: getRecentLogs() }`. Elysia awaits the *handler's*
 *    return value, so a bare `return getAsync()` is fine, and a synchronous
 *    handler returning a promise is also fine. But a promise stored inside an
 *    object or array is serialised by `JSON.stringify` as `{}`. The endpoint
 *    answers 200 with an empty body and no error anywhere.
 *
 * The second failure is the reason this script does not simply grep for
 * `await`. `scripts/e2e-smoke.ts` asserts on response *shape* for exactly this
 * reason: a status-code check cannot see `{}`.
 *
 * ## What is deliberately not reported
 *
 * - `void asyncFn()` — the convention for intentional fire-and-forget.
 * - `Promise.all([...])` and friends — a promise in a value position is the
 *   whole point.
 * - `return asyncFn()` from any function — forwarding a promise is correct as
 *   long as the receiver is a promise, and deciding that from the call site
 *   alone would require whole-program effect analysis.
 *
 *   bun run scripts/audit-missing-await.ts
 */
import ts from "typescript";
import { relative } from "path";

const configPath = ts.findConfigFile(
  process.cwd(),
  ts.sys.fileExists,
  "tsconfig.json",
);
if (!configPath) {
  console.error("tsconfig.json not found");
  process.exit(2);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ".");

const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

const normalise = (file: string): string => file.replace(/\\/g, "/");
const rel = (file: string): string => normalise(relative(process.cwd(), file));

/** `src/web` is excluded: a separately-bundled frontend with no database
 *  access. This script is excluded so it does not match its own helpers. */
const AUDITED = parsed.fileNames.filter((file) => {
  const path = normalise(file);
  return (
    path.startsWith("src/") &&
    !path.startsWith("src/web/") &&
    !path.endsWith("audit-missing-await.ts")
  );
});

/** `Promise.all` and friends genuinely want a promise in a value position. */
const PROMISE_COMBINATORS = new Set([
  "all",
  "allSettled",
  "race",
  "any",
  "resolve",
  "reject",
]);

/** Methods that consume the promise they are called on. */
const CHAIN_METHODS = new Set(["then", "catch", "finally"]);

const isAsyncDeclaration = (node: ts.Node): boolean => {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isArrowFunction(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return false;
  }
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
};

const describe = (node: ts.Node): string => {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name)
    return `#${node.name.getText()}`;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)))
      return node.name.text;
  }
  return "<anonymous>";
};

/** Resolves a call's callee to its declaration, following import aliases. */
const asyncCalleeOf = (call: ts.CallExpression): ts.Declaration | null => {
  if (!ts.isIdentifier(call.expression)) return null;
  const symbol = checker.getSymbolAtLocation(call.expression);
  if (!symbol) return null;

  // At a use site the symbol is an *alias* whose declaration is the
  // ImportSpecifier, not the function. Without this hop the audit silently
  // matches nothing, which is worse than no audit at all.
  const resolved =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const decl = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!decl) return null;
  return isAsyncDeclaration(decl) ? decl : null;
};

/** True when `call` is wrapped in `void`, so its result is explicitly dropped. */
const isVoided = (call: ts.CallExpression): boolean =>
  ts.isVoidExpression(call.parent) ||
  (ts.isExpressionStatement(call.parent) &&
    call.parent.parent !== undefined &&
    ts.isVoidExpression(call.parent.parent));

/** True when `node` is `Promise.<combinator>(...)` with `node` in the argument list. */
const isCombinatorCall = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "Promise" &&
  PROMISE_COMBINATORS.has(node.expression.name.text);

/** Strips redundant parentheses only. `await` is deliberately not stripped:
 *  an awaited promise is resolved by definition, and losing that fact would make
 *  `const x = await fn()` look like an un-awaited assignment. */
const stripParens = (node: ts.Node): ts.Node => {
  let current = node;
  while (ts.isParenthesizedExpression(current) && current.parent) {
    current = current.parent;
  }
  return current;
};

/**
 * True when the expression's result flows somewhere that will resolve it, so
 * holding a promise there is the intent rather than a bug.
 */
const isPromiseConsumer = (node: ts.Node): boolean => {
  const parent = stripParens(node).parent;
  if (!parent) return false;

  if (ts.isArrayLiteralExpression(parent)) {
    // The call is one element of an array literal. That array is a legitimate
    // position only when it is the argument list of a promise combinator, so the
    // decision has to be made on the array's own parent, not the call's.
    return isCombinatorCall(parent.parent);
  }

  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === stripParens(node)
  ) {
    // `fn().catch(...)`, `fn().then(...)`, `fn().finally(...)` consume the
    // promise. Reading some *other* property off a promise does not, which is
    // exactly the bug, so the member name is what separates the two cases.
    if (CHAIN_METHODS.has(parent.name.text)) return true;
  }

  return false;
};

/**
 * Classifies where a call's result flows. Returns null when the position is
 * safe (statement position handled separately, or a consumer).
 */
const valuePositionKind = (
  call: ts.CallExpression,
): "nested" | "assigned" | "argument" | "property" | null => {
  if (isVoided(call)) return null;

  const parent = stripParens(call).parent;
  if (!parent) return null;

  // `await fn()` and `(fn())` inside an await both resolve before the value is
  // used, so neither is a value position.
  if (ts.isAwaitExpression(parent)) return null;
  if (isPromiseConsumer(call)) return null;

  // A bare `return asyncFn()` forwards the promise to the caller, which may be a
  // promise consumer. Not reportable from the call site alone.
  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return null;

  if (ts.isPropertyAssignment(parent)) return "nested";
  if (ts.isShorthandPropertyAssignment(parent)) return "nested";
  if (ts.isArrayLiteralExpression(parent)) return "nested";
  if (ts.isVariableDeclaration(parent)) return "assigned";
  if (ts.isCallExpression(parent) && parent.arguments.includes(call))
    return "argument";
  if (ts.isPropertyAccessExpression(parent) && parent.expression === call)
    return "property";
  if (ts.isBinaryExpression(parent)) return "property";
  return null;
};

interface Finding {
  kind: string;
  file: string;
  line: number;
  call: string;
  callee: string;
  calleeFile: string;
  enclosing: string;
  enclosingLine: number;
}

const findings: Finding[] = [];

for (const fileName of AUDITED) {
  const source = program.getSourceFile(fileName);
  if (!source) continue;

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node, enclosing: ts.Node | null): void => {
    const isFunctionNode =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node);

    const nextEnclosing = isFunctionNode ? node : enclosing;

    if (ts.isCallExpression(node)) {
      const decl = asyncCalleeOf(node);
      if (decl) {
        // Check 1: discarded entirely.
        const discarded =
          ts.isExpressionStatement(node.parent) && !isVoided(node);
        const kind = discarded ? "discarded" : valuePositionKind(node);
        if (kind) {
          findings.push({
            kind,
            file: fileName,
            line: lineOf(node),
            call: node.getText(source).slice(0, 70).replace(/\s+/g, " "),
            callee: describe(decl),
            calleeFile: decl.getSourceFile().fileName,
            enclosing: enclosing ? describe(enclosing) : "<module>",
            enclosingLine: enclosing ? lineOf(enclosing) : 0,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, nextEnclosing));
  };

  visit(source, null);
}

if (findings.length === 0) {
  console.log("ok  no unresolved promises");
  process.exit(0);
}

const ORDER = ["nested", "discarded", "assigned", "argument", "property"];
const describeKind = (kind: string): string => {
  switch (kind) {
    case "nested":
      return "nested in a value  -> serialised as {} in the response";
    case "discarded":
      return "discarded         -> the effect no longer happens";
    case "assigned":
      return "assigned          -> a promise is bound where a value is used";
    case "argument":
      return "passed as argument -> a promise is passed where a value is expected";
    default:
      return "used as a value    -> a promise is read as a value";
  }
};

const byKind = new Map<string, Finding[]>();
for (const finding of findings) {
  byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
}

console.log(`FAIL: ${findings.length} unresolved promise(s)\n`);
for (const kind of ORDER) {
  const group = byKind.get(kind);
  if (!group) continue;
  console.log(`--- ${describeKind(kind)} (${group.length}) ---`);
  for (const finding of group) {
    console.log(
      `  ${rel(finding.file)}:${finding.line}  in ${finding.enclosing} (${finding.enclosingLine})`,
    );
    console.log(`    ${finding.call}`);
    console.log(
      `      -> async ${finding.callee} in ${rel(finding.calleeFile)}`,
    );
  }
  console.log("");
}
process.exit(1);
