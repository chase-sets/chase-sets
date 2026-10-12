import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

// Bounded syntactic guard against tests that assert real elapsed time under an
// upper bound: such assertions fail on a busy host with no code change. An
// elapsed quantity is any expression containing a binary `-` whose left operand
// is a real-clock read, directly or through same-file const/let initializers
// and plain assignments resolved by lexical scope. Values that reach the
// assertion through property access, destructuring or helper return values are
// a stated limit: they are not followed.

const testFileExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const clockTokenPattern = /\b(?:performance|Date)\s*\.\s*now\b|\bprocess\s*\.\s*hrtime\b|\.\s*(?:getTime|valueOf)\s*\(/;
const globalObjectNames = new Set(["globalThis", "window", "self", "global"]);
const lessThanMatchers = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const greaterThanMatchers = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual"]);
const testModifiers = new Set(["only", "skip", "todo", "fails", "fail", "fixme", "slow", "concurrent", "sequential"]);
const testFactories = new Set(["each", "for", "runIf", "skipIf"]);
const knownLimit =
  "real-clock elapsed bounds: values reaching an assertion through property access, destructuring or helper return values are not followed.";

export async function validateRealClockElapsedBounds({
  repoRoot,
  allowlistPath = "scripts/check-structure/real-clock-elapsed-bounds-allowlist.json",
}) {
  const allowlist = JSON.parse(readFileSync(path.join(repoRoot, allowlistPath), "utf8"));
  const allowed = new Set(allowlist.map((entry) => entry.id));
  const testFiles = trackedTestFiles(repoRoot);
  const rows = [];
  let scanned = 0;
  for (const file of testFiles) {
    let source;
    try {
      source = readFileSync(path.join(repoRoot, file), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!clockTokenPattern.test(source)) continue;
    scanned += 1;
    for (const site of findElapsedUpperBounds(file, source)) {
      rows.push({ ...site, classification: allowed.has(site.id) ? "allowlisted" : "violation" });
    }
  }

  const violations = rows
    .filter((row) => row.classification === "violation")
    .map(
      (row) =>
        `${row.id}: real-clock elapsed upper bound (line ${row.line}); assert operation counts, ordering or settled state instead, or add a justified allowlist entry.`,
    );
  const discovered = new Set(rows.map((row) => row.id));
  const listed = new Set();
  for (const entry of allowlist) {
    if (listed.has(entry.id)) violations.push(`${allowlistPath}: duplicate allowlist entry '${entry.id}'.`);
    else if (!discovered.has(entry.id)) violations.push(`${allowlistPath}: stale allowlist entry '${entry.id}'.`);
    listed.add(entry.id);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
      violations.push(`${allowlistPath}: '${entry.id}' needs a one-line justification of at least 20 characters.`);
  }

  const allowlisted = rows.filter((row) => row.classification === "allowlisted").length;
  console.log(
    `real-clock elapsed bounds: ${scanned}/${testFiles.length} test files scanned, ${allowlisted} allowlisted`,
  );
  console.log(knownLimit);
  return { violations, rows, scanned, total: testFiles.length, allowlisted };
}

function trackedTestFiles(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((file) => {
      const name = path.posix.basename(file);
      return /\.(?:test|spec)\./.test(name) && testFileExtensions.has(path.posix.extname(name));
    });
}

function scriptKind(file) {
  const extension = path.posix.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function findElapsedUpperBounds(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    true,
    scriptKind(file),
  );
  const { resolve } = bindScopes(sourceFile);

  function isClockValued(node, seen) {
    const expression = unwrap(node);
    if (isClockRead(expression)) return true;
    if (!ts.isIdentifier(expression)) return false;
    const binding = resolve(expression);
    if (!binding?.tracked || seen.has(binding)) return false;
    seen.add(binding);
    return binding.values.some((value) => isClockValued(value, seen));
  }

  function isElapsed(node, seen = new Set()) {
    if (
      ts.isTypeNode(node) ||
      isFunctionNode(node) ||
      ts.isClassLike(node) ||
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isMetaProperty(node)
    )
      return false;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.MinusToken &&
      isClockValued(node.left, new Set())
    )
      return true;
    if (ts.isIdentifier(node)) {
      const binding = resolve(node);
      if (!binding?.tracked || seen.has(binding)) return false;
      seen.add(binding);
      return binding.values.some((value) => isElapsed(value, seen));
    }
    if (ts.isPropertyAccessExpression(node)) return isElapsed(node.expression, seen);
    if (ts.isJsxAttribute(node)) return node.initializer ? isElapsed(node.initializer, seen) : false;
    return Boolean(ts.forEachChild(node, (child) => isElapsed(child, seen) || undefined));
  }

  function isUpperBound(call) {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const matcher = callee.name.text;
      if (lessThanMatchers.has(matcher) || greaterThanMatchers.has(matcher)) {
        let target = callee.expression;
        let negated = false;
        if (ts.isPropertyAccessExpression(target) && target.name.text === "not") {
          negated = true;
          target = target.expression;
        }
        if (!isExpectCall(target)) return false;
        const boundsSubject = lessThanMatchers.has(matcher) !== negated;
        const elapsed = boundsSubject ? target.arguments[0] : call.arguments[0];
        return elapsed !== undefined && isElapsed(elapsed);
      }
    }
    if (!isAssertCallee(callee) || call.arguments.length === 0) return false;
    const comparison = unwrap(call.arguments[0]);
    if (!ts.isBinaryExpression(comparison)) return false;
    switch (comparison.operatorToken.kind) {
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
        return isElapsed(comparison.left);
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return isElapsed(comparison.right);
      default:
        return false;
    }
  }

  const occurrences = new Map();
  const scopeKeys = new Map([[sourceFile, "module:::1"]]);
  const scopeOrdinals = new Map();
  const sites = [];
  const visit = (node, insideTest) => {
    const testCall = ts.isCallExpression(node) && isTestCall(node);
    let scopeKey;
    if (testCall) {
      scopeKey = `test:${testTitle(node.arguments[0], sourceFile)}`;
    } else if (!insideTest && functionName(node, sourceFile) !== undefined) {
      scopeKey = `function:${functionName(node, sourceFile)}`;
    }
    if (scopeKey !== undefined) {
      const occurrence = (occurrences.get(scopeKey) ?? 0) + 1;
      occurrences.set(scopeKey, occurrence);
      scopeKeys.set(node, `${scopeKey}::${occurrence}`);
    }
    if (ts.isCallExpression(node) && isUpperBound(node)) {
      const scope = enclosingScope(node, sourceFile);
      const ordinal = (scopeOrdinals.get(scope) ?? 0) + 1;
      scopeOrdinals.set(scope, ordinal);
      sites.push({
        id: `${file}::${scopeKeys.get(scope)}::${ordinal}`,
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, (child) =>
      visit(child, insideTest || (testCall && isFunctionNode(child) && node.arguments.includes(child))),
    );
  };
  visit(sourceFile, false);
  return sites;
}

function bindScopes(sourceFile) {
  const scopes = new Map();
  const assignments = [];
  const createScope = (node, parent, isFunction) => {
    const scope = { parent, isFunction, names: new Map() };
    scopes.set(node, scope);
    return scope;
  };
  const declare = (scope, name, binding = { tracked: false, values: [] }) => {
    if (ts.isIdentifier(name)) scope.names.set(name.text, binding);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const element of name.elements) if (ts.isBindingElement(element)) declare(scope, element.name);
  };
  const functionScope = (scope) => {
    let current = scope;
    while (!current.isFunction) current = current.parent;
    return current;
  };

  const visit = (node, scope) => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    let inner = scope;
    if (isFunctionNode(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) declare(scope, node.name);
      inner = createScope(node, scope, true);
      if (ts.isFunctionExpression(node) && node.name) declare(inner, node.name);
      for (const parameter of node.parameters) declare(inner, parameter.name);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (ts.isClassDeclaration(node) && node.name) declare(scope, node.name);
      inner = createScope(node, scope, false);
      if (ts.isClassExpression(node) && node.name) declare(inner, node.name);
    } else if (
      ts.isBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      inner = createScope(node, scope, false);
    } else if (ts.isCatchClause(node)) {
      inner = createScope(node, scope, false);
      if (node.variableDeclaration) declare(inner, node.variableDeclaration.name);
    } else if (ts.isVariableDeclarationList(node)) {
      const blockScoped = (node.flags & ts.NodeFlags.BlockScoped) !== 0;
      const tracked = blockScoped && (node.flags & ts.NodeFlags.Using) === 0;
      for (const declaration of node.declarations) {
        const target = blockScoped ? scope : functionScope(scope);
        if (tracked && ts.isIdentifier(declaration.name))
          declare(target, declaration.name, {
            tracked: true,
            values: declaration.initializer ? [declaration.initializer] : [],
          });
        else declare(target, declaration.name);
      }
    } else if (ts.isImportClause(node) && node.name) {
      declare(scope, node.name);
    } else if (ts.isNamespaceImport(node) || ts.isImportSpecifier(node) || ts.isImportEqualsDeclaration(node)) {
      declare(scope, node.name);
    } else if (ts.isEnumDeclaration(node)) {
      declare(scope, node.name);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrap(node.left))
    ) {
      assignments.push({ identifier: unwrap(node.left), value: node.right });
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };

  visit(sourceFile, createScope(sourceFile, null, true));

  const resolve = (identifier) => {
    let node = identifier.parent;
    while (node && !scopes.has(node)) node = node.parent;
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      const binding = scope.names.get(identifier.text);
      if (binding) return binding;
    }
    return null;
  };
  for (const { identifier, value } of assignments) {
    const binding = resolve(identifier);
    if (binding?.tracked) binding.values.push(value);
  }
  return { resolve };
}

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = current.expression;
  return current;
}

function isFunctionNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isGlobal(node, name) {
  const expression = unwrap(node);
  if (ts.isIdentifier(expression)) return expression.text === name;
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === name &&
    ts.isIdentifier(expression.expression) &&
    globalObjectNames.has(expression.expression.text)
  );
}

function isClockRead(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  const target = unwrap(node.expression.expression);
  switch (method) {
    case "now":
      return isGlobal(target, "performance") || isGlobal(target, "Date");
    case "hrtime":
      return isGlobal(target, "process");
    case "bigint":
      return (
        ts.isPropertyAccessExpression(target) && target.name.text === "hrtime" && isGlobal(target.expression, "process")
      );
    case "getTime":
    case "valueOf":
      return ts.isNewExpression(target) && isGlobal(target.expression, "Date") && !target.arguments?.length;
    default:
      return false;
  }
}

function isExpectCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    (ts.isIdentifier(callee) && callee.text === "expect") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "soft" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "expect")
  );
}

function isAssertCallee(callee) {
  return (
    (ts.isIdentifier(callee) && callee.text === "assert") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "ok" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "assert")
  );
}

function isTestCallee(node) {
  if (ts.isIdentifier(node)) return node.text === "it" || node.text === "test";
  if (ts.isPropertyAccessExpression(node))
    return (testModifiers.has(node.name.text) || testFactories.has(node.name.text)) && isTestCallee(node.expression);
  if (ts.isCallExpression(node))
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      testFactories.has(node.expression.name.text) &&
      isTestCallee(node.expression.expression)
    );
  if (ts.isTaggedTemplateExpression(node)) return isTestCallee(node.tag);
  return false;
}

function isTestCall(call) {
  return call.arguments.length > 0 && call.arguments.some(isFunctionNode) && isTestCallee(call.expression);
}

function testTitle(title, sourceFile) {
  if (isFunctionNode(title)) return "";
  if (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) return title.text;
  if (ts.isTemplateExpression(title)) return title.getText(sourceFile).slice(1, -1);
  return title.getText(sourceFile);
}

function functionName(node, sourceFile) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
    return ts.isComputedPropertyName(node.name) ? node.name.getText(sourceFile) : node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const owner = node.parent;
    if (
      (ts.isVariableDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isPropertyDeclaration(owner)) &&
      owner.initializer === node &&
      !ts.isComputedPropertyName(owner.name) &&
      !ts.isObjectBindingPattern(owner.name) &&
      !ts.isArrayBindingPattern(owner.name)
    )
      return owner.name.text;
  }
  return undefined;
}

function enclosingScope(node, sourceFile) {
  let namedFunction;
  for (let child = node, current = node.parent; current; child = current, current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      isFunctionNode(child) &&
      current.arguments.includes(child) &&
      isTestCall(current)
    )
      return current;
    if (namedFunction === undefined && functionName(current, sourceFile) !== undefined) namedFunction = current;
  }
  return namedFunction ?? sourceFile;
}

if (process.argv[1]?.endsWith("real-clock-elapsed-bounds.mjs")) {
  const result = await validateRealClockElapsedBounds({ repoRoot: process.cwd() });
  if (process.argv.includes("--inventory")) console.log(JSON.stringify(result.rows, null, 2));
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
}
