import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import { GIT_LISTING_MAX_BUFFER, gitListingOptions } from "./lib/git-listing.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const extensions = /\.(?:mjs|js|cjs|ts|mts|cts)$/;
const spawnerNames = new Set(["execFileSync", "execFile", "spawnSync", "spawn"]);

function scriptKind(file) {
  if (/\.(?:tsx?|mts|cts)$/.test(file)) return /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  if (/\.jsx?$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}
function literalValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function propertyName(node) {
  return node?.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
}
function childProcessModule(name) {
  return name === "node:child_process" || name === "child_process";
}

function sourceRows(sf, relativePath) {
  const imported = new Map();
  const declarations = new Map();
  const functionNodes = new Set();
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      declarations.set(node.name.text, node);
      functionNodes.add(node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node);
      if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
        functionNodes.add(node.initializer);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) functionNodes.add(node);
    if (ts.isImportDeclaration(node) && node.importClause) {
      const module = literalValue(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause.name) imported.set(clause.name.text, { module, name: "default", decl: clause });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        imported.set(clause.namedBindings.name.text, { module, name: "*", decl: clause.namedBindings });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          imported.set(element.name.text, {
            module,
            name: element.propertyName?.text ?? element.name.text,
            decl: element,
          });
    }
  });
  const makeScope = (parent, body) => {
    const scope = { parent, bindings: new Map() };
    const collect = (node) => {
      if (!node) return;
      if (
        (ts.isFunctionDeclaration(node) && node !== body) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)
      )
        return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        scope.bindings.set(node.name.text, { node: node.initializer, scope });
      if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, { node, scope });
      ts.forEachChild(node, collect);
    };
    collect(body);
    return scope;
  };
  const globalScope = makeScope(undefined, sf);
  const fnScopes = new Map();
  const fnScope = (fn, parent) => {
    let byParent = fnScopes.get(fn);
    if (!byParent) fnScopes.set(fn, (byParent = new Map()));
    if (!byParent.has(parent)) {
      const params = { parent, bindings: new Map() };
      const scope = makeScope(params, fn.body);
      scope.fn = fn;
      for (const parameter of fn.parameters) {
        if (ts.isIdentifier(parameter.name))
          params.bindings.set(parameter.name.text, { node: parameter.initializer, scope: params });
        else if (ts.isObjectBindingPattern(parameter.name))
          for (const element of parameter.name.elements)
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name))
              params.bindings.set(element.name.text, { node: element.initializer, scope: params });
      }
      byParent.set(parent, scope);
    }
    return byParent.get(parent);
  };
  const lexicalParent = (fn, scope) => {
    let outer = fn.parent;
    while (outer && !ts.isFunctionLike(outer)) outer = outer.parent;
    if (!outer) return globalScope;
    for (let current = scope; current; current = current.parent) if (current.fn === outer) return current;
    return fnScope(outer, lexicalParent(outer, globalScope));
  };
  const binding = (id, scope) => {
    for (let current = scope; current; current = current.parent)
      if (current.bindings.has(id.text)) return current.bindings.get(id.text);
    const info = imported.get(id.text);
    return info ? { import: info, scope } : undefined;
  };
  const resolve = (value, scope, depth = 0) => {
    if (!value) return { node: value, scope, depth, exceeded: false };
    if (depth > 6) return { node: value, scope, depth, exceeded: true };
    const node = ts.isParenthesizedExpression(value) ? value.expression : value;
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      const left = resolve(node.left, scope, depth + 1);
      return { ...(left.node ? left : resolve(node.right, scope, depth + 1)), fallback: true };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const base = resolve(node.expression, scope, depth + 1);
      if (base.node && ts.isObjectLiteralExpression(base.node)) {
        const prop = base.node.properties.find((p) => !ts.isSpreadAssignment(p) && propertyName(p) === node.name.text);
        if (prop && ts.isPropertyAssignment(prop)) {
          const r = resolve(prop.initializer, base.scope, depth + 1);
          return base.fallback ? { ...r, fallback: true } : r;
        }
      }
      return { node: undefined, scope: base.scope, depth, exceeded: false, fallback: base.fallback };
    }
    if (!ts.isIdentifier(node)) return { node, scope, depth, exceeded: false };
    const b = binding(node, scope);
    if (!b || b.import) return { node, scope, depth, import: b?.import };
    return resolve(b.node, b.scope, depth + 1);
  };
  const literal = (value, scope, depth = 0) => {
    const r = resolve(value, scope, depth);
    const text = literalValue(r.node);
    return { value: text, ...r };
  };
  const numberValue = (value, scope, depth = 0) => {
    const r = resolve(value, scope, depth);
    if (r.exceeded || r.fallback || !r.node) return undefined;
    if (ts.isNumericLiteral(r.node)) return Number(r.node.text);
    if (ts.isBinaryExpression(r.node)) {
      const a = numberValue(r.node.left, r.scope, depth + 1),
        b = numberValue(r.node.right, r.scope, depth + 1);
      if (a === undefined || b === undefined) return undefined;
      if (r.node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
      if (r.node.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    }
    return undefined;
  };
  const tokenNodes = new Set();
  walk(sf, (node) => {
    const text = literalValue(node);
    if (text === "ls-files" || text === "ls-tree") tokenNodes.add(node);
  });
  const accounted = new Set();
  const tokenValue = (value, scope, depth = 0) => {
    const r = resolve(value, scope, depth);
    if (r.exceeded) return { found: false, depth: true };
    if (!r.node) return { found: false, depth: false };
    const text = literalValue(r.node);
    if (text === "ls-files" || text === "ls-tree") return { found: true, nodes: [r.node] };
    if (ts.isArrayLiteralExpression(r.node)) {
      const found = r.node.elements.flatMap((e) => tokenValue(e, r.scope, depth + 1));
      return {
        found: found.some((x) => x.found),
        depth: found.some((x) => x.depth),
        nodes: found.flatMap((x) => x.nodes ?? []),
      };
    }
    if (ts.isSpreadElement(r.node)) return tokenValue(r.node.expression, r.scope, depth + 1);
    if (ts.isConditionalExpression(r.node)) {
      const a = tokenValue(r.node.whenTrue, r.scope, depth + 1),
        b = tokenValue(r.node.whenFalse, r.scope, depth + 1);
      return { found: a.found || b.found, depth: a.depth || b.depth, nodes: [...(a.nodes ?? []), ...(b.nodes ?? [])] };
    }
    return { found: false, depth: false };
  };
  const statusRank = { compliant: 0, ambiguous: 1, noncompliant: 2 };
  const gitListingOptionsStatus = (call, scope, depth) => {
    if (call.arguments.length !== 1) return { status: "ambiguous", reason: "unresolved-options" };
    const argument = resolve(call.arguments[0], scope, depth + 1);
    if (argument.exceeded || !argument.node || !ts.isObjectLiteralExpression(argument.node))
      return { status: "ambiguous", reason: "unresolved-options" };
    return { status: "compliant", reason: "gitListingOptions" };
  };
  const optionsStatus = (value, scope, depth = 0) => {
    if (!value) return { status: "noncompliant", reason: "missing-options" };
    const r = resolve(value, scope, depth);
    if (r.exceeded || r.fallback) return { status: "ambiguous", reason: "unresolved-options" };
    const n = r.node;
    if (!n) return { status: "noncompliant", reason: "missing-options" };
    if (ts.isIdentifier(n) && n.text === "GIT_LISTING_MAX_BUFFER") return { status: "compliant", reason: "constant" };
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "gitListingOptions")
      return gitListingOptionsStatus(n, r.scope, depth);
    if (ts.isConditionalExpression(n)) {
      const branches = [optionsStatus(n.whenTrue, r.scope, depth + 1), optionsStatus(n.whenFalse, r.scope, depth + 1)];
      const both = branches.every((x) => x.status === "compliant");
      return both
        ? branches[0]
        : branches.some((x) => x.status === "noncompliant")
          ? { status: "noncompliant", reason: "missing-maxBuffer" }
          : { status: "ambiguous", reason: "unresolved-options" };
    }
    if (!ts.isObjectLiteralExpression(n)) return { status: "ambiguous", reason: "unresolved-options" };
    let found;
    let ambiguous = false;
    let conditionalAmbiguous = false;
    let laterSpread = false;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        if (found) laterSpread = true;
        const spread = resolve(p.expression, r.scope, depth + 1);
        if (!spread.node || spread.fallback) {
          ambiguous = true;
          continue;
        }
        if (ts.isConditionalExpression(spread.node)) {
          ambiguous = true;
          conditionalAmbiguous = true;
        } else {
          const result = optionsStatus(spread.node, spread.scope, depth + 1);
          if (result.status === "compliant") found = result;
          else if (result.status === "noncompliant") found = result;
          else {
            ambiguous = true;
          }
        }
        continue;
      }
      const name = ts.isShorthandPropertyAssignment(p)
        ? p.name.text
        : ts.isPropertyAssignment(p)
          ? propertyName(p)
          : undefined;
      if (name !== "maxBuffer") continue;
      const initializer = ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer;
      const v = resolve(initializer, r.scope, depth + 1);
      if (v.fallback) found = { status: "ambiguous", reason: "unresolved-options" };
      else if (!v.node) found = { status: "ambiguous", reason: "unresolved-options" };
      else if (ts.isIdentifier(v.node) && v.node.text === "GIT_LISTING_MAX_BUFFER")
        found = { status: "compliant", reason: "constant" };
      else if (
        ts.isCallExpression(v.node) &&
        ts.isIdentifier(v.node.expression) &&
        v.node.expression.text === "gitListingOptions"
      )
        found = gitListingOptionsStatus(v.node, v.scope, depth + 1);
      else {
        const number = numberValue(v.node, v.scope, depth + 1);
        found =
          number === undefined
            ? { status: "ambiguous", reason: "unresolved-options" }
            : number >= 8 * 1024 * 1024
              ? { status: "compliant", reason: "numeric-capacity" }
              : { status: "noncompliant", reason: "small-capacity" };
      }
    }
    return conditionalAmbiguous || laterSpread
      ? { status: "ambiguous", reason: "unresolved-options" }
      : (found ??
          (ambiguous
            ? { status: "ambiguous", reason: "unresolved-options" }
            : { status: "noncompliant", reason: "missing-maxBuffer" }));
  };
  const spawnerFor = (node, scope) => {
    if (ts.isIdentifier(node)) {
      const b = binding(node, scope);
      if (b?.import && childProcessModule(b.import.module) && spawnerNames.has(b.import.name)) return b.import.name;
      if (b?.spawner) return b.spawner;
      const bNode = b && !b.import ? b.node : undefined;
      const unwrapped = bNode && ts.isParenthesizedExpression(bNode) ? bNode.expression : bNode;
      if (
        unwrapped &&
        ts.isBinaryExpression(unwrapped) &&
        (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        const fallback = spawnerFor(unwrapped.right, b.scope);
        if (fallback) return fallback;
      }
      const r = resolve(node, scope);
      if (r.import && childProcessModule(r.import.module) && spawnerNames.has(r.import.name)) return r.import.name;
      if (
        r.node &&
        ts.isCallExpression(r.node) &&
        ((ts.isPropertyAccessExpression(r.node.expression) && r.node.expression.name.text === "promisify") ||
          (ts.isIdentifier(r.node.expression) && r.node.expression.text === "promisify"))
      ) {
        const target = r.node.arguments[0];
        const targetBinding = ts.isIdentifier(target) ? binding(target, r.scope) : undefined;
        if (
          targetBinding?.import &&
          childProcessModule(targetBinding.import.module) &&
          targetBinding.import.name === "execFile"
        )
          return "execFile";
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const b = binding(node.expression, scope);
      if (
        b?.import &&
        childProcessModule(b.import.module) &&
        (b.import.name === "*" || b.import.name === "default") &&
        spawnerNames.has(node.name.text)
      )
        return node.name.text;
    }
    return undefined;
  };
  const rows = new Map();
  const active = new Set();
  const seenFunctions = new Set();
  const addRow = (node, kind, result, reason = result.reason) => {
    const key = node.getStart(sf);
    let rowKind = kind;
    if (kind === "wrapper") {
      let parent = node.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      if (parent && parent.parameters.length === 0) rowKind = "direct";
    }
    const row = { file: relativePath, line: lineOf(sf, node), kind: rowKind, status: result.status, reason };
    const old = rows.get(key);
    if (
      !old ||
      statusRank[row.status] > statusRank[old.status] ||
      (statusRank[row.status] === statusRank[old.status] && kind === "injected-default")
    )
      rows.set(key, row);
  };
  const functionFor = (callee, scope) => {
    if (!ts.isIdentifier(callee)) return undefined;
    const r = resolve(callee, scope);
    if (r.node && (ts.isFunctionDeclaration(r.node) || ts.isArrowFunction(r.node) || ts.isFunctionExpression(r.node)))
      return r.node;
    if (r.node && ts.isIdentifier(r.node)) {
      const d = declarations.get(r.node.text);
      if (d && ts.isFunctionDeclaration(d)) return d;
      if (
        d &&
        ts.isVariableDeclaration(d) &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      )
        return d.initializer;
    }
    return undefined;
  };
  const buildParams = (fn, args, callerScope, calleeScope) => {
    const next = { parent: calleeScope.parent.parent, bindings: new Map() };
    fn.parameters.forEach((p, i) => {
      const arg = args[i];
      if (ts.isIdentifier(p.name))
        next.bindings.set(p.name.text, { node: arg ?? p.initializer, scope: arg ? callerScope : calleeScope.parent });
      else if (ts.isObjectBindingPattern(p.name))
        for (const e of p.name.elements)
          if (ts.isBindingElement(e) && ts.isIdentifier(e.name)) {
            const obj = arg ? resolve(arg, callerScope).node : undefined;
            const key = e.propertyName?.text ?? e.name.text;
            const prop =
              obj && ts.isObjectLiteralExpression(obj)
                ? obj.properties.find((x) => !ts.isSpreadAssignment(x) && propertyName(x) === key)
                : undefined;
            next.bindings.set(e.name.text, {
              node: prop && ts.isPropertyAssignment(prop) ? prop.initializer : e.initializer,
              scope: prop ? callerScope : calleeScope.parent,
            });
          }
    });
    const body = makeScope(next, fn.body);
    body.fn = fn;
    return body;
  };
  const inspect = (node, scope, kind, hops = 0) => {
    if (!node) return;
    if (ts.isFunctionLike(node)) {
      seenFunctions.add(node);
      const childScope = fnScope(node, scope);
      const functionKind = node.parameters.some((parameter) => parameter.initializer) ? "injected-default" : kind;
      for (const parameter of node.parameters) inspect(parameter, childScope.parent, functionKind, hops);
      inspect(node.body, childScope, functionKind, hops);
      return;
    }
    if (ts.isCallExpression(node)) {
      const spawner = spawnerFor(node.expression, scope);
      const first = literal(node.arguments[0], scope);
      const tokens = tokenValue(node.arguments[1], scope);
      const fn = functionFor(node.expression, scope);
      if (spawner && first.value === "git" && tokens.found) {
        for (const token of tokens.nodes ?? []) accounted.add(token);
        addRow(
          node,
          kind,
          hops > 1 ? { status: "ambiguous", reason: "wrapper-depth" } : optionsStatus(node.arguments[2], scope),
        );
      } else if (!spawner && !fn && ts.isIdentifier(node.expression)) {
        const unresolvedTokens = [node.arguments[0], node.arguments[1], node.arguments[2]].flatMap(
          (arg) => tokenValue(arg, scope).nodes ?? [],
        );
        const calleeBinding = binding(node.expression, scope);
        if (unresolvedTokens.length && calleeBinding) {
          if (calleeBinding.import) for (const token of unresolvedTokens) accounted.add(token);
          if (calleeBinding.import) addRow(node, kind, { status: "ambiguous", reason: "unresolved-executor" });
        }
      }
      if (fn && !active.has(fn)) {
        active.add(fn);
        const calleeScope = fnScope(fn, lexicalParent(fn, scope));
        const carriesListing = node.arguments.some((argument) => tokenValue(argument, scope).found);
        inspect(
          fn.body,
          buildParams(fn, [...node.arguments], scope, calleeScope),
          kind === "direct" ? "wrapper" : kind,
          carriesListing ? hops + 1 : 0,
        );
        active.delete(fn);
      }
    }
    ts.forEachChild(node, (child) => inspect(child, scope, kind, hops));
  };
  inspect(sf, globalScope, "direct");
  for (const fn of functionNodes)
    if (!seenFunctions.has(fn)) {
      const scope = fnScope(fn, lexicalParent(fn, globalScope));
      inspect(fn.body, scope, fn.parameters.some((p) => p.initializer) ? "injected-default" : "direct");
    }
  const exempt = (token) => {
    let parent = token.parent;
    while (parent) {
      if (
        ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsToken,
        ].includes(parent.operatorToken.kind)
      )
        return true;
      if (ts.isCaseClause(parent)) return true;
      if (ts.isCallExpression(parent)) {
        const callee = parent.expression;
        if (ts.isIdentifier(callee) && ["expect", "assert"].includes(callee.text)) return true;
        if (ts.isPropertyAccessExpression(callee)) {
          let root = callee.expression;
          while (ts.isPropertyAccessExpression(root)) root = root.expression;
          if (ts.isCallExpression(root) && ts.isIdentifier(root.expression) && root.expression.text === "expect")
            return true;
          if (ts.isIdentifier(root) && root.text === "assert") return true;
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          ["startsWith", "endsWith", "includes", "indexOf"].includes(callee.name.text)
        )
          return true;
        return false;
      }
      parent = parent.parent;
    }
    return false;
  };
  for (const token of tokenNodes)
    if (!accounted.has(token) && !exempt(token))
      addRow(token, "direct", { status: "ambiguous", reason: "unaccounted-token" });
  return [...rows.values()];
}

export function listingSiteInventory({ root = repoRoot, sources } = {}) {
  const tracked =
    sources ??
    execFileSync("git", ["-C", root, "ls-files", "-z", "--", "scripts"], gitListingOptions({ encoding: "utf8" }))
      .split("\0")
      .filter((f) => f.startsWith("scripts/") && extensions.test(f));
  const unreadable = [];
  const files = tracked.flatMap((relativePath) => {
    const file = path.join(root, relativePath);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      unreadable.push({ file: relativePath, line: 1, kind: "direct", status: "ambiguous", reason: "unreadable" });
      return [];
    }
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
    if (sf.parseDiagnostics?.length) {
      unreadable.push({ file: relativePath, line: 1, kind: "direct", status: "ambiguous", reason: "parse" });
      return [];
    }
    return [file];
  });
  const program = ts.createProgram({
    rootNames: files,
    options: { allowJs: true, noResolve: true, noLib: true, noEmit: true, types: [] },
  });
  program.getTypeChecker();
  return [
    ...unreadable,
    ...tracked.flatMap((relativePath) => {
      const file = path.join(root, relativePath);
      const sourceFile = program.getSourceFile(file);
      return sourceFile ? sourceRows(sourceFile, relativePath) : [];
    }),
  ];
}

function plant(name, source, relativePath = `scripts/q7x/${name}.mjs`) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-git-listing-plant-"));
  const relative = relativePath;
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  return { root, relative };
}

describe("Git listing buffer contract", () => {
  it("derives a complete tracked scripts inventory without noncompliant rows", () => {
    const inventory = listingSiteInventory();
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.filter((site) => site.status !== "compliant")).toEqual([]);
  }, 60_000);
  it("classifies Git listing invocations by their behavior rather than names or paths", () => {
    const injected = (parameter) =>
      `export function list(${parameter}) {\n  return ${parameter}(["ls-files", "-z", "--others"]);\n}\n`;
    const cases = [
      ["name-keyed", "scripts/arbitrary/injected-name.mjs", injected("execGit"), "row"],
      ["parameter-renamed", "scripts/arbitrary/injected-other.mjs", injected("run"), "row"],
      [
        "readGit-conditional",
        "scripts/arbitrary/injected-read-git.mjs",
        'export function list(readGit, fallback) { return readGit ? readGit(["ls-files", "-z", "--others"]) : fallback(); }\n',
        "row",
      ],
      [
        "readGit-conditional-small-executor",
        "scripts/arbitrary/injected-read-git-small.mjs",
        'import { execFileSync } from "node:child_process"; function list(readGit, fallback) { const read = () => (readGit ? readGit(["ls-files", "-z", "--others"]) : fallback()); return read(); } const out = list((args) => execFileSync("git", args, { maxBuffer: 1024 }), () => "");\n',
        "row",
      ],
      [
        "run-conditional",
        "scripts/arbitrary/injected-run.mjs",
        'export function list(run, fallback) { return run ? run(["ls-files", "-z", "--others"]) : fallback(); }\n',
        "row",
      ],
      [
        "run-conditional-small-executor",
        "scripts/arbitrary/injected-run-small.mjs",
        'import { execFileSync } from "node:child_process"; function list(run, fallback) { const read = () => (run ? run(["ls-files", "-z", "--others"]) : fallback()); return read(); } const out = list((args) => execFileSync("git", args, { maxBuffer: 1024 }), () => "");\n',
        "row",
      ],
      ["test-path", "scripts/arbitrary/injected-other.test.mjs", injected("run"), "row"],
      [
        "unresolved-factory-test-path",
        "scripts/arbitrary/factory.test.mjs",
        'import { makeRunner } from "./runner.mjs";\nconst run = makeRunner();\nrun("git", ["ls-files", "-z", "--others"]);\n',
        "row",
      ],
      [
        "unresolved-factory-production-path",
        "scripts/arbitrary/factory.mjs",
        'import { makeRunner } from "./runner.mjs";\nconst run = makeRunner();\nrun("git", ["ls-files", "-z", "--others"]);\n',
        "row",
      ],
      [
        "comparison-operand",
        "scripts/arbitrary/comparison.mjs",
        'export const isList = (args) => args[0] === "ls-files";\n',
        "none",
      ],
      [
        "expect-operand",
        "scripts/arbitrary/expect.mjs",
        'import { expect } from "vitest";\nexport const check = (calls) => expect(calls).toEqual([["ls-tree", "HEAD"]]);\n',
        "none",
      ],
      [
        "includes-operand",
        "scripts/arbitrary/includes.mjs",
        'export const isList = (args) => args.includes("ls-files");\n',
        "none",
      ],
    ];
    const observations = [];
    for (const [name, relative, source, expected] of cases) {
      const { root } = plant(name, source, relative);
      try {
        const rows = listingSiteInventory({ root, sources: [relative] });
        observations.push({
          name,
          rows: rows.map(({ kind, status, reason }) => ({ kind, status, reason })),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      expect(expected).toMatch(/^(?:row|none)$/);
    }
    expect(observations).toEqual([
      { name: "name-keyed", rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }] },
      { name: "parameter-renamed", rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }] },
      { name: "readGit-conditional", rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }] },
      {
        name: "readGit-conditional-small-executor",
        rows: [{ kind: "wrapper", status: "noncompliant", reason: "small-capacity" }],
      },
      { name: "run-conditional", rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }] },
      {
        name: "run-conditional-small-executor",
        rows: [{ kind: "wrapper", status: "noncompliant", reason: "small-capacity" }],
      },
      { name: "test-path", rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }] },
      {
        name: "unresolved-factory-test-path",
        rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }],
      },
      {
        name: "unresolved-factory-production-path",
        rows: [{ kind: "direct", status: "ambiguous", reason: "unaccounted-token" }],
      },
      { name: "comparison-operand", rows: [] },
      { name: "expect-operand", rows: [] },
      { name: "includes-operand", rows: [] },
    ]);
  });
  it("proves the four AC3 mutation controls and two neutral shifts on temporary copies", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cs-git-listing-controls-"));
    const copy = (relative, source) => {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, source);
      return relative;
    };
    const removeLine = (source, expected, occurrence = 0) => {
      const lines = source.split(/\r?\n/);
      let seen = -1;
      const index = lines.findIndex((line) => line.includes(expected) && ++seen === occurrence);
      if (index < 0) throw new Error(`missing mutation target ${expected} occurrence ${occurrence}`);
      lines.splice(index, 1);
      return lines.join("\n");
    };
    const neutralShift = (source) => {
      const lines = source.split(/\r?\n/);
      let lastImport = -1;
      lines.forEach((line, index) => {
        if (/^import\b/.test(line) || (lastImport >= 0 && index === lastImport + 1 && /^\s/.test(line)))
          lastImport = index;
      });
      while (lastImport + 1 < lines.length && !/;\s*$/.test(lines[lastImport])) lastImport += 1;
      lines.splice(lastImport + 1, 0, "// neutral shift control");
      return lines.join("\n");
    };
    const source = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
    const controls = [
      {
        label: "doks-ingress",
        relative: "scripts/check-structure/doks-ingress-chart-version.mjs",
        text: removeLine(
          source("scripts/check-structure/doks-ingress-chart-version.mjs"),
          "maxBuffer: GIT_LISTING_MAX_BUFFER",
        ),
        expected: "red",
      },
      {
        label: "managed-postgres",
        relative: "scripts/managed-postgres-authority-sources.mjs",
        text: removeLine(source("scripts/managed-postgres-authority-sources.mjs"), "maxBuffer: 10 * 1024 * 1024"),
        expected: "red",
      },
      {
        label: "brand-foil-default-buffer",
        relative: "scripts/check-structure/brand-foil-sites.mjs",
        text: removeLine(
          source("scripts/check-structure/brand-foil-sites.mjs"),
          "maxBuffer: 32 * 1024 * 1024",
        ).replaceAll("gitListingOptions({ ...options })", "{ ...options }"),
        expected: "red",
      },
      {
        label: "consent-tracked-files",
        relative: "scripts/check-structure/consent-authorization-sites.test.mjs",
        text: removeLine(
          source("scripts/check-structure/consent-authorization-sites.test.mjs"),
          "maxBuffer: GIT_LISTING_MAX_BUFFER",
          0,
        ),
        expected: "red",
      },
      {
        label: "consent-counted-child-process",
        relative: "scripts/check-structure/consent-authorization-sites.test.mjs",
        text: removeLine(
          source("scripts/check-structure/consent-authorization-sites.test.mjs"),
          "maxBuffer: GIT_LISTING_MAX_BUFFER",
          1,
        ),
        expected: "red",
      },
      {
        label: "neutral-catalog-localization",
        relative: "scripts/check-structure/catalog-localization-keyset-tripwire.mjs",
        text: neutralShift(source("scripts/check-structure/catalog-localization-keyset-tripwire.mjs")),
        expected: "green",
      },
      {
        label: "neutral-policy-value",
        relative: "scripts/check-structure/policy-value-discriminant-chokepoint.mjs",
        text: neutralShift(source("scripts/check-structure/policy-value-discriminant-chokepoint.mjs")),
        expected: "green",
      },
    ];
    try {
      const observations = controls.map(({ label, relative, text: mutated, expected }) => {
        copy(relative, mutated);
        const rows = listingSiteInventory({ root, sources: [relative] });
        const nonCompliant = rows.filter((row) => row.status !== "compliant");
        return { label, observed: nonCompliant.length > 0 ? "red" : "green", expected, nonCompliant };
      });
      expect(observations.map(({ label, observed, expected }) => ({ label, observed, expected }))).toEqual([
        { label: "doks-ingress", observed: "red", expected: "red" },
        { label: "managed-postgres", observed: "red", expected: "red" },
        { label: "brand-foil-default-buffer", observed: "red", expected: "red" },
        { label: "consent-tracked-files", observed: "red", expected: "red" },
        { label: "consent-counted-child-process", observed: "red", expected: "red" },
        { label: "neutral-catalog-localization", observed: "green", expected: "green" },
        { label: "neutral-policy-value", observed: "green", expected: "green" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails closed for direct and wrapper/default planted violations", () => {
    const cases = [
      [
        "direct-default",
        'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });',
        "direct",
        "noncompliant",
      ],
      [
        "small-literal",
        'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"], { maxBuffer: 2 * 1024 * 1024 });',
        "direct",
        "noncompliant",
      ],
      [
        "small-literal-1024",
        'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"], { maxBuffer: 1024 });',
        "direct",
        "noncompliant",
      ],
      [
        "direct-after-apostrophe",
        '// don\'t\nimport { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"], { encoding: "utf8" });',
        "direct",
        "noncompliant",
      ],
      [
        "direct-no-options",
        'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"]);',
        "direct",
        "noncompliant",
      ],
      [
        "spawn-default",
        'import { spawnSync } from "node:child_process"; spawnSync("git", ["ls-tree", "-r", "HEAD"], { encoding: "utf8" });',
        "direct",
        "noncompliant",
      ],
      [
        "generic-wrapper",
        'import { execFileSync } from "node:child_process"; function run(file, argv, options) { return execFileSync(file, argv, options); } run("git", ["ls-files"], { encoding: "utf8" });',
        "wrapper",
        "noncompliant",
      ],
      [
        "injected-default",
        'import { execFileSync } from "node:child_process"; export function list({ exec = (gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" }) } = {}) { return exec(["ls-files", "-z"]); } list();',
        "injected-default",
        "noncompliant",
      ],
      [
        "variable-options",
        'import { execFileSync } from "node:child_process"; const options = { encoding: "utf8" }; execFileSync("git", ["ls-files"], options);',
        "direct",
        "noncompliant",
      ],
      [
        "imported-options",
        'import { execFileSync } from "node:child_process"; import { options } from "./elsewhere.mjs"; execFileSync("git", ["ls-files"], options);',
        "direct",
        "ambiguous",
      ],
    ];
    for (const [name, source, kind, status] of cases) {
      const { root, relative } = plant(name, source);
      try {
        const rows = listingSiteInventory({ root, sources: [relative] });
        expect(rows).toEqual([
          expect.objectContaining({
            kind,
            status,
            ...(status === "ambiguous" ? { reason: "unresolved-options" } : {}),
          }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const failClosedPlants = [
      [
        "same-name-arg",
        'import { execFileSync } from "node:child_process"; function run(file, args, options) { return execFileSync(file, args, options); } function list() { const args = ["ls-files"]; return run("git", args, { encoding: "utf8" }); } list();',
        "wrapper",
        "noncompliant",
      ],
      [
        "const-name-collision",
        'import { execFileSync } from "node:child_process"; function a() { const argv = ["ls-files"]; return execFileSync("git", argv, { encoding: "utf8" }); } function b() { const argv = ["status"]; return argv; } a(); b();',
        "direct",
        "noncompliant",
      ],
      [
        "default-import",
        'import cp from "node:child_process"; cp.execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });',
        "direct",
        "noncompliant",
      ],
      [
        "util-promisify",
        'import util from "node:util"; import { execFile } from "node:child_process"; const run = util.promisify(execFile); await run("git", ["ls-files"], { encoding: "utf8" });',
        "direct",
        "noncompliant",
      ],
      [
        "bare-promisify",
        'import { promisify } from "node:util"; import { execFile } from "node:child_process"; const run = promisify(execFile); await run("git", ["ls-files"]);',
        "direct",
        "noncompliant",
      ],
      [
        "imported-executor",
        'import { git } from "./elsewhere.mjs"; git(["ls-files", "-z"]);',
        "direct",
        "ambiguous",
        "unresolved-executor",
      ],
      [
        "param-executor-no-caller",
        'import { execFileSync } from "node:child_process"; export function list(exec) { return exec(["ls-files", "-z"]); }',
        "direct",
        "ambiguous",
        "unaccounted-token",
      ],
      [
        "method-executor",
        'import { execFileSync } from "node:child_process"; const g = { run: (a) => execFileSync("git", a, { encoding: "utf8" }) }; g.run(["ls-files"]);',
        "direct",
        "ambiguous",
        "unaccounted-token",
      ],
      [
        "require-cjs",
        'const { execFileSync } = require("node:child_process"); execFileSync("git", ["ls-files"], { encoding: "utf8" });',
        "direct",
        "ambiguous",
        "unaccounted-token",
      ],
      [
        "exported-args-const",
        'export const LISTING_ARGS = ["ls-files", "-z"];',
        "direct",
        "ambiguous",
        "unaccounted-token",
      ],
      [
        "depth-7",
        'import { execFileSync } from "node:child_process"; const a1 = ["ls-files"]; const a2 = a1; const a3 = a2; const a4 = a3; const a5 = a4; const a6 = a5; const a7 = a6; const a8 = a7; execFileSync("git", a8, { encoding: "utf8" });',
        "direct",
        "ambiguous",
        "depth",
      ],
      [
        "unrelated-conditional-spread",
        'import { execFileSync } from "node:child_process"; const unrelated = true ? { encoding: "utf8" } : { maxBuffer: 8 * 1024 * 1024 }; execFileSync("git", ["ls-files"], { ...unrelated });',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "callback-parameter-shadow",
        'import { execFileSync } from "node:child_process"; const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; [1].forEach((opts) => execFileSync("git", ["ls-files"], opts));',
        "direct",
        "noncompliant",
      ],
      [
        "wrapper-default-small-override",
        'import { execFileSync } from "node:child_process"; function list(roots, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { return roots.map((root) => execFileSync("git", ["ls-files", "-z"], { cwd: root, ...opts })); } list(["."], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
      ],
      [
        "wrapper-default-small-direct",
        'import { execFileSync } from "node:child_process"; function list(roots, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { return roots.map((root) => execFileSync("git", ["ls-files", "-z"], opts)); } list(["."], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
      ],
      [
        "call-order-shadow",
        'import { execFileSync } from "node:child_process"; function outer() { const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; return list(); } const opts = { cwd: "." }; function list() { return execFileSync("git", ["ls-files"], opts); } export { outer, list };',
        "direct",
        "noncompliant",
      ],
      [
        "nested-neutrality-read-readTree",
        'import { execFileSync } from "node:child_process"; function neutrality(readTree) { const read = (sha) => () => readTree(["ls-tree", "-r", "-z", "--name-only", sha]); return [read("a"), read("b")]; } export const out = neutrality((args) => execFileSync("git", args, { cwd: "." }));',
        "wrapper",
        "noncompliant",
        "missing-maxBuffer",
      ],
      [
        "method-local-shadow",
        'import { execFileSync } from "node:child_process"; const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; export const lister = { list(root) { const opts = { cwd: root }; return execFileSync("git", ["ls-files"], opts); } };',
        "direct",
        "noncompliant",
        "missing-maxBuffer",
      ],
      [
        "parameter-initializer-shadow",
        'import { execFileSync } from "node:child_process"; function list(o = opts) { const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; return execFileSync("git", ["ls-files"], o); } const opts = { cwd: "." }; list();',
        "injected-default",
        "noncompliant",
      ],
      [
        "property-fallback",
        'import { execFileSync } from "node:child_process"; function listTracked(root, options = {}) { const config = { capacity: options.maxBuffer ?? GIT_LISTING_MAX_BUFFER }; return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: config.capacity }); } listTracked(".");',
        "injected-default",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "property-small-fallback",
        'import { execFileSync } from "node:child_process"; function listTracked(root, options = {}) { const config = { capacity: options.maxBuffer ?? 16 * 1024 * 1024 }; return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: config.capacity }); } listTracked(".");',
        "injected-default",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "parameter-options-fallback",
        'import { execFileSync } from "node:child_process"; function listTracked(root, options) { const presets = { listing: options ?? { maxBuffer: GIT_LISTING_MAX_BUFFER } }; return execFileSync("git", ["ls-files", "-z"], presets.listing); } listTracked(".");',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "wrapper-body-alias-callback",
        'import { execFileSync } from "node:child_process"; function list(roots, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { const o = opts; return roots.map((root) => execFileSync("git", ["ls-files", "-z"], o)); } list(["."], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "wrapper-body-spread-alias",
        'import { execFileSync } from "node:child_process"; function list(root, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { const o = { cwd: root, ...opts }; return execFileSync("git", ["ls-files"], o); } list(".", { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "wrapper-body-helper-default-alias",
        'import { execFileSync } from "node:child_process"; function run(args, options = gitListingOptions({ encoding: "utf8" })) { const o = options; return execFileSync("git", args, o); } run(["ls-files"], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "wrapper-body-options-alias",
        'import { execFileSync } from "node:child_process"; function run(args, options = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { const o = options; return execFileSync("git", args, o); } run(["ls-files"], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "wrapper-body-destructured-alias",
        'import { execFileSync } from "node:child_process"; function run(args, { maxBuffer = GIT_LISTING_MAX_BUFFER } = {}) { const capacity = maxBuffer; return execFileSync("git", args, { maxBuffer: capacity }); } run(["ls-files"], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "wrapper-body-args-alias",
        'import { execFileSync } from "node:child_process"; function run(args, options = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { const a = args; return execFileSync("git", a, options); } run(["ls-files"], { maxBuffer: 1024 });',
        "wrapper",
        "noncompliant",
        "small-capacity",
      ],
      [
        "spread-fallback-small-caller",
        'import { execFileSync } from "node:child_process"; function list(root, options) { const o = options ?? { maxBuffer: GIT_LISTING_MAX_BUFFER }; return execFileSync("git", ["ls-files", "-z"], { ...o, cwd: root }); } list(".", { maxBuffer: 1024 });',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "parameter-capacity-without-default",
        'import { execFileSync } from "node:child_process"; export function list(cap) { return execFileSync("git", ["ls-files"], { maxBuffer: cap }); }',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "parameter-shorthand-capacity-without-default",
        'import { execFileSync } from "node:child_process"; export function list(maxBuffer) { return execFileSync("git", ["ls-files"], { maxBuffer }); }',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "parameter-options-capacity-without-default",
        'import { execFileSync } from "node:child_process"; export function list(cap, o = { maxBuffer: cap }) { return execFileSync("git", ["ls-files"], o); }',
        "injected-default",
        "ambiguous",
        "unresolved-options",
      ],
      [
        "parameter-capacity-product-without-default",
        'import { execFileSync } from "node:child_process"; export function list(cap) { return execFileSync("git", ["ls-files"], { maxBuffer: cap * 1024 }); }',
        "direct",
        "ambiguous",
        "unresolved-options",
      ],
    ];
    for (const [name, source, kind, status, reason] of failClosedPlants) {
      const { root, relative } = plant(name, source);
      try {
        const rows = listingSiteInventory({ root, sources: [relative] });
        if (name === "depth-7") {
          expect(rows).toHaveLength(1);
          expect(rows.map((row) => row.reason)).toEqual(["unaccounted-token"]);
          expect(rows.every((row) => row.kind === kind && row.status === status)).toBe(true);
        } else
          expect(rows).toEqual([
            expect.objectContaining({
              file: relative,
              line: expect.any(Number),
              kind,
              status,
              ...(reason ? { reason } : {}),
            }),
          ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(listingSiteInventory({ root: repoRoot, sources: ["scripts/q7x/missing.mjs"] })).toEqual([
      { file: "scripts/q7x/missing.mjs", line: 1, kind: "direct", status: "ambiguous", reason: "unreadable" },
    ]);
  });
  it("preserves the complete expected-compliant proof-shape and lexical control matrix", () => {
    const prefix =
      'import { execFileSync, execFile, spawnSync, spawn } from "node:child_process"; import { GIT_LISTING_MAX_BUFFER, gitListingOptions } from "../lib/git-listing.mjs";\n';
    const cases = [
      [
        "direct-constant",
        'execFileSync("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      ["async-exec", 'execFile("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });', "direct", "constant"],
      [
        "sync-spawn",
        'spawnSync("git", ["ls-tree", "HEAD"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "async-spawn",
        'spawn("git", ["ls-tree", "HEAD"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "numeric-capacity",
        'execFileSync("git", ["ls-files"], { maxBuffer: 8 * 1024 * 1024 });',
        "direct",
        "numeric-capacity",
      ],
      [
        "bound-options-array",
        'const args = ["ls-files", "-z", "--others"]; const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; execFileSync("git", args, opts);',
        "direct",
        "constant",
      ],
      [
        "conditional-array",
        'const args = flag ? ["ls-files", "-z"] : ["ls-tree", "HEAD"]; execFileSync("git", args, { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "helper-object-literal",
        'execFileSync("git", ["ls-files"], gitListingOptions({ encoding: "utf8" }));',
        "direct",
        "gitListingOptions",
      ],
      [
        "leading-parameter-spread",
        'export function list(root, overrides) { return execFileSync("git", ["ls-files", "-z"], { cwd: root, ...overrides, maxBuffer: GIT_LISTING_MAX_BUFFER }); }',
        "direct",
        "constant",
      ],
      [
        "leading-known-spread",
        'const options = { encoding: "utf8" }; execFileSync("git", ["ls-files"], { ...options, maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "one-hop-wrapper",
        'function run(args, options) { return execFileSync("git", args, options); } run(["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "wrapper",
        "constant",
      ],
      [
        "wrapper-body-options-alias-constant",
        'function run(args, options = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { const o = options; return execFileSync("git", args, o); } run(["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "wrapper",
        "constant",
      ],
      [
        "wrapper-body-options-alias-no-default",
        'function run(args, options) { const o = options; return execFileSync("git", args, o); } run(["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "wrapper",
        "constant",
      ],
      [
        "leading-fallback-spread",
        'export function list(root, options) { return execFileSync("git", ["ls-files"], { ...(options ?? {}), cwd: root, maxBuffer: GIT_LISTING_MAX_BUFFER }); }',
        "direct",
        "constant",
      ],
      [
        "wrapper-default-callback",
        'function list(roots, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { return roots.map((root) => execFileSync("git", ["ls-files", "-z"], { cwd: root, ...opts })); } list(["."], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "injected-default",
        "constant",
      ],
      [
        "wrapper-default-direct",
        'function list(roots, opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }) { return roots.map((root) => execFileSync("git", ["ls-files", "-z"], opts)); } list(["."], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "injected-default",
        "constant",
      ],
      [
        "lexical-call-order",
        'function outer() { const opts = { cwd: "." }; return list(); } const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; function list() { return execFileSync("git", ["ls-files"], opts); } export { outer, list };',
        "direct",
        "constant",
      ],
      [
        "lexical-parameter-initializer",
        'function list(o = opts) { const opts = { cwd: "." }; return execFileSync("git", ["ls-files"], o); } const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; list();',
        "injected-default",
        "constant",
      ],
      [
        "nested-neutrality-executor",
        'function neutrality(readTree) { const read = (sha) => () => readTree(["ls-tree", "-r", "-z", "--name-only", sha]); return [read("a"), read("b")]; } export const out = neutrality((args) => execFileSync("git", args, { maxBuffer: GIT_LISTING_MAX_BUFFER }));',
        "wrapper",
        "constant",
      ],
      [
        "callback-local",
        'const opts = { cwd: "." }; [1].forEach(() => { const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; execFileSync("git", ["ls-files"], opts); });',
        "direct",
        "constant",
      ],
      [
        "method-local",
        'const opts = { cwd: "." }; export const lister = { list(root) { const opts = { cwd: root, maxBuffer: GIT_LISTING_MAX_BUFFER }; return execFileSync("git", ["ls-files"], opts); } };',
        "direct",
        "constant",
      ],
      [
        "property-capacity",
        'const config = { capacity: GIT_LISTING_MAX_BUFFER }; execFileSync("git", ["ls-files"], { maxBuffer: config.capacity });',
        "direct",
        "constant",
      ],
      [
        "property-options",
        'const presets = { listing: { maxBuffer: GIT_LISTING_MAX_BUFFER } }; execFileSync("git", ["ls-files"], presets.listing);',
        "direct",
        "constant",
      ],
      [
        "bare-promisify",
        'import { promisify } from "node:util"; const run = promisify(execFile); run("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "util-promisify",
        'import util from "node:util"; const run = util.promisify(execFile); run("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER });',
        "direct",
        "constant",
      ],
      [
        "default-spawn-parameter",
        'export function list(run = execFileSync) { return run("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER }); }',
        "injected-default",
        "constant",
      ],
      [
        "destructured-spawn-default",
        'export function list({ run = execFileSync } = {}) { return run("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER }); }',
        "injected-default",
        "constant",
      ],
    ];
    for (const [name, source, kind, reason] of cases) {
      const { root, relative } = plant(name, prefix + source, `scripts/arbitrary/${name}.mjs`);
      try {
        expect(listingSiteInventory({ root, sources: [relative] }), name).toEqual([
          expect.objectContaining({ kind, status: "compliant", reason }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it("keeps conditional, multi-hop, and unresolved helper shapes fail-closed", () => {
    const cases = [
      [
        "two-hop",
        'import { execFileSync } from "node:child_process"; function inner(args, options) { return execFileSync("git", args, options); } function outer(args, options) { return inner(args, options); } outer(["ls-files"], { maxBuffer: 8 * 1024 * 1024 });',
        "ambiguous",
        "wrapper-depth",
        "scripts/arbitrary/two-hop.mjs",
      ],
      [
        "conditional-spread",
        'import { execFileSync } from "node:child_process"; const listing = true ? { maxBuffer: 8 * 1024 * 1024 } : {}; execFileSync("git", ["ls-files"], { ...listing });',
        "ambiguous",
        "unresolved-options",
      ],
      [
        "helper-no-argument",
        'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"], gitListingOptions());',
        "ambiguous",
        "unresolved-options",
      ],
      [
        "helper-dynamic-argument",
        'import { execFileSync } from "node:child_process"; const options = getOptions(); execFileSync("git", ["ls-files"], gitListingOptions(options));',
        "ambiguous",
        "unresolved-options",
      ],
    ];
    for (const [name, source, status, reason, relativePath] of cases) {
      const { root, relative } = plant(name, source, relativePath);
      try {
        expect(listingSiteInventory({ root, sources: [relative] })).toEqual([
          expect.objectContaining({ kind: name === "two-hop" ? "wrapper" : "direct", status, reason }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it("rejects capacities that a later spread or fallback can replace", () => {
    const cases = [
      [
        "later-spread-parameter",
        'import { execFileSync } from "node:child_process"; function list(overrides) { return execFileSync("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER, ...overrides }); } list({});',
        "ambiguous",
      ],
      [
        "capacity-fallback",
        'import { execFileSync } from "node:child_process"; const options = {}; execFileSync("git", ["ls-files"], { maxBuffer: options.maxBuffer ?? GIT_LISTING_MAX_BUFFER });',
        "ambiguous",
      ],
      [
        "spread-nullish-fallback",
        'import { execFileSync } from "node:child_process"; export function list(root, options) { return execFileSync("git", ["ls-files", "-z"], { cwd: root, ...(options ?? { maxBuffer: GIT_LISTING_MAX_BUFFER }) }); }',
        "ambiguous",
      ],
      [
        "spread-bound-nullish-fallback",
        'import { execFileSync } from "node:child_process"; export function list(root, options) { const o = options ?? { maxBuffer: GIT_LISTING_MAX_BUFFER }; return execFileSync("git", ["ls-files", "-z"], { ...o, cwd: root }); }',
        "ambiguous",
      ],
      [
        "spread-logical-fallback",
        'import { execFileSync } from "node:child_process"; export function list(root, options) { return execFileSync("git", ["ls-files", "-z"], { cwd: root, ...(options || { maxBuffer: GIT_LISTING_MAX_BUFFER }) }); }',
        "ambiguous",
      ],
      [
        "spread-property-fallback",
        'import { execFileSync } from "node:child_process"; export function list(root, options) { const presets = { listing: options ?? { maxBuffer: GIT_LISTING_MAX_BUFFER } }; return execFileSync("git", ["ls-files", "-z"], { ...presets.listing, cwd: root }); }',
        "ambiguous",
      ],
      [
        "parameter-capacity-fallback",
        'import { execFileSync } from "node:child_process"; export function listTracked(root, capacity) { return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: capacity ?? GIT_LISTING_MAX_BUFFER }); }',
        "ambiguous",
      ],
      [
        "default-parameter-property-capacity-fallback",
        'import { execFileSync } from "node:child_process"; export function listTracked(root, options = {}) { return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: options.maxBuffer ?? GIT_LISTING_MAX_BUFFER }); }',
        "ambiguous",
      ],
      [
        "imported-spread",
        'import { execFileSync } from "node:child_process"; import { overrides } from "./elsewhere.mjs"; execFileSync("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER, ...overrides });',
        "ambiguous",
      ],
      [
        "call-spread",
        'import { execFileSync } from "node:child_process"; import { loadOptions } from "./elsewhere.mjs"; execFileSync("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER, ...loadOptions() });',
        "ambiguous",
      ],
      [
        "module-imported-spread",
        'import { execFileSync } from "node:child_process"; import { overrides } from "./elsewhere.mjs"; function list() { return execFileSync("git", ["ls-files"], { maxBuffer: GIT_LISTING_MAX_BUFFER, ...overrides }); } list();',
        "ambiguous",
      ],
      [
        "consent-trailing-spread",
        'import { execFileSync } from "node:child_process"; function defaultExecGit(args, rootDir, options = {}) { return execFileSync("git", args, { cwd: rootDir, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, ...options }); } export function list(rootDir, options) { return defaultExecGit(["ls-files", "-z"], rootDir, options); }',
        "ambiguous",
      ],
    ];
    for (const [name, source, status] of cases) {
      const { root, relative } = plant(name, source);
      try {
        expect(listingSiteInventory({ root, sources: [relative] })).toEqual([
          expect.objectContaining({
            kind:
              name === "consent-trailing-spread"
                ? "wrapper"
                : name === "default-parameter-property-capacity-fallback"
                  ? "injected-default"
                  : "direct",
            status,
            reason: "unresolved-options",
          }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const { root, relative } = plant(
      "explicit-capacity-after-known-spread",
      'import { execFileSync } from "node:child_process"; execFileSync("git", ["ls-files"], { ...{ encoding: "utf8" }, maxBuffer: GIT_LISTING_MAX_BUFFER });',
    );
    try {
      expect(listingSiteInventory({ root, sources: [relative] })).toEqual([
        expect.objectContaining({ kind: "direct", status: "compliant", reason: "constant" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps inline callback bindings separate from outer same-named declarations", () => {
    const cases = [
      [
        "callback-shadowed-options",
        'import { execFileSync } from "node:child_process"; const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; [1].forEach(() => { const opts = { encoding: "utf8" }; execFileSync("git", ["ls-files"], opts); });',
        "noncompliant",
      ],
      [
        "callback-local-capacity",
        'import { execFileSync } from "node:child_process"; const opts = { maxBuffer: 8 * 1024 * 1024 }; [1].forEach(() => { const local = { maxBuffer: GIT_LISTING_MAX_BUFFER }; execFileSync("git", ["ls-files"], local); });',
        "compliant",
      ],
      [
        "callback-parameter-capacity",
        'import { execFileSync } from "node:child_process"; const opts = { maxBuffer: GIT_LISTING_MAX_BUFFER }; [1].forEach((opts) => execFileSync("git", ["ls-files"], opts));',
        "noncompliant",
      ],
    ];
    for (const [name, source, status] of cases) {
      const { root, relative } = plant(name, source);
      try {
        expect(listingSiteInventory({ root, sources: [relative] })).toEqual([
          expect.objectContaining({ kind: "direct", status }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it("recognizes only admitted nullish and logical spawn fallbacks", () => {
    const cases = [
      [
        "nullish-fallback",
        'import { execFileSync } from "node:child_process"; const run = missing ?? execFileSync; run("git", ["ls-files"], { maxBuffer: 8 * 1024 * 1024 });',
      ],
      [
        "logical-fallback",
        'import cp from "node:child_process"; const run = missing || cp.execFileSync; run("git", ["ls-files"], { maxBuffer: 8 * 1024 * 1024 });',
      ],
    ];
    for (const [name, source] of cases) {
      const { root, relative } = plant(name, source);
      try {
        expect(listingSiteInventory({ root, sources: [relative] })).toEqual([
          expect.objectContaining({ kind: "direct", status: "compliant", reason: "numeric-capacity" }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  it("preserves exact complete output above Node's default buffer", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cs-git-listing-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const names = Array.from(
        { length: 12_000 },
        (_, index) => `tracked-${String(index).padStart(5, "0")}-${"x".repeat(80)}.txt`,
      );
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "x\n" }).toString().trim();
      const indexInfo = names.map((name) => `100644 ${blob}\t${name}`).join("\n") + "\n";
      execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: indexInfo });
      const listing = execFileSync("git", ["ls-files", "-z"], gitListingOptions({ cwd: root }));
      expect(listing.length).toBeGreaterThan(1024 * 1024);
      expect(listing.toString("utf8").split("\0").filter(Boolean)).toEqual(names);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
