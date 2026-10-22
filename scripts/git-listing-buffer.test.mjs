import assert from "node:assert/strict";
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
    if (!fnScopes.has(fn)) fnScopes.set(fn, makeScope(parent, fn.body));
    return fnScopes.get(fn);
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
      return left.node ? left : resolve(node.right, scope, depth + 1);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const base = resolve(node.expression, scope, depth + 1);
      if (base.node && ts.isObjectLiteralExpression(base.node)) {
        const prop = base.node.properties.find((p) => !ts.isSpreadAssignment(p) && propertyName(p) === node.name.text);
        if (prop && ts.isPropertyAssignment(prop)) return resolve(prop.initializer, base.scope, depth + 1);
      }
      return { node: undefined, scope: base.scope, depth, exceeded: false };
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
    if (r.exceeded) return undefined;
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
    if (r.exceeded) return { status: "ambiguous", reason: "unresolved-options" };
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
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        const spread = resolve(p.expression, r.scope, depth + 1);
        if (!spread.node) {
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
          else ambiguous = true;
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
      if (ts.isIdentifier(v.node) && v.node.text === "GIT_LISTING_MAX_BUFFER")
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
    return conditionalAmbiguous
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
    const next = { parent: calleeScope.parent, bindings: new Map(calleeScope.bindings) };
    fn.parameters.forEach((p, i) => {
      const arg = args[i];
      if (ts.isIdentifier(p.name))
        next.bindings.set(p.name.text, { node: arg ?? p.initializer, scope: arg ? callerScope : calleeScope });
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
              scope: prop ? callerScope : calleeScope,
            });
          }
    });
    return next;
  };
  const inspect = (node, scope, kind, hops = 0) => {
    if (!node) return;
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
          hops > 1
            ? { status: "ambiguous", reason: "wrapper-depth" }
            : optionsStatus(node.arguments[2], scope),
        );
      } else if (!spawner && !fn && ts.isIdentifier(node.expression)) {
        const unresolvedTokens = [node.arguments[0], node.arguments[1], node.arguments[2]].flatMap(
          (arg) => tokenValue(arg, scope).nodes ?? [],
        );
        const calleeBinding = binding(node.expression, scope);
        if (unresolvedTokens.length && calleeBinding) {
          if (calleeBinding.import || ["execGit", "readGit", "runGit"].includes(node.expression.text))
            for (const token of unresolvedTokens) accounted.add(token);
          if (calleeBinding.import && !["execGit", "readGit", "runGit"].includes(node.expression.text))
            addRow(node, kind, { status: "ambiguous", reason: "unresolved-executor" });
        }
      }
      if (fn && !active.has(fn)) {
        active.add(fn);
        const calleeScope = fnScope(fn, scope);
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
    if (!active.has(fn)) {
      const scope = fnScope(fn, globalScope);
      inspect(
        fn.body,
        buildParams(fn, [], scope, scope),
        fn.parameters.some((p) => p.initializer) ? "injected-default" : "direct",
      );
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
    if (!accounted.has(token) && !exempt(token) && !relativePath.includes(".test."))
      addRow(token, "direct", { status: "ambiguous", reason: "unaccounted-token" });
  return [...rows.values()];
}

export function listingSiteInventory({ root = repoRoot, sources } = {}) {
  const tracked =
    sources ??
    execFileSync("git", ["-C", root, "ls-files", "-z", "--", "scripts"], gitListingOptions({ encoding: "utf8" }))
      .split("\0")
      .filter((f) => f.startsWith("scripts/") && extensions.test(f) && f !== "scripts/git-listing-buffer.test.mjs");
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
    expect(inventory.filter((site) => site.status === "noncompliant")).toEqual([]);
  }, 60_000);
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
            kind: name === "const-name-collision" ? "wrapper" : kind,
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
              kind: name === "const-name-collision" ? "wrapper" : kind,
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
      assert.throws(() => execFileSync("git", ["ls-files", "-z"], { cwd: root }), /ENOBUFS|maxBuffer/i);
      const listing = execFileSync("git", ["ls-files", "-z"], gitListingOptions({ cwd: root }));
      expect(listing.toString("utf8").split("\0").filter(Boolean)).toEqual(names);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
