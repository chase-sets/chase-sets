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

function sourceRows(sf) {
  const spawners = new Map();
  const namespaces = new Set();
  const functions = new Map();
  const values = new Map();
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node) && childProcessModule(literalValue(node.moduleSpecifier))) {
      const clause = node.importClause;
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        namespaces.add(clause.namedBindings.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const e of clause.namedBindings.elements) {
          const imported = e.propertyName?.text ?? e.name.text;
          if (spawnerNames.has(imported)) spawners.set(e.name.text, imported);
        }
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        functions.set(node.name.text, node.initializer);
      else values.set(node.name.text, node.initializer);
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "promisify"
      ) {
        const target = node.initializer.arguments[0];
        if (ts.isIdentifier(target) && spawners.has(target.text))
          spawners.set(node.name.text, spawners.get(target.text));
      }
    }
  });
  const resolve = (node, env, depth = 0) => {
    if (!node || depth > 6) return node;
    if (ts.isIdentifier(node)) {
      if (env.has(node.text)) return resolve(env.get(node.text), env, depth + 1);
      if (values.has(node.text)) return resolve(values.get(node.text), env, depth + 1);
    }
    return node;
  };
  const stringValue = (node, env, depth = 0) => {
    const n = resolve(node, env, depth);
    const value = literalValue(n);
    if (value !== undefined) return value;
    if (ts.isConditionalExpression(n)) {
      const a = stringValue(n.whenTrue, env, depth + 1);
      const b = stringValue(n.whenFalse, env, depth + 1);
      return a === b ? a : undefined;
    }
    return undefined;
  };
  const hasToken = (node, env, depth = 0) => {
    if (!node || depth > 6) return false;
    const n = resolve(node, env, depth);
    const value = literalValue(n);
    if (!n) return false;
    if (value === "ls-files" || value === "ls-tree") return true;
    if (ts.isArrayLiteralExpression(n)) return n.elements.some((e) => hasToken(e, env, depth + 1));
    if (ts.isSpreadElement(n)) return hasToken(n.expression, env, depth + 1);
    if (ts.isConditionalExpression(n))
      return hasToken(n.whenTrue, env, depth + 1) || hasToken(n.whenFalse, env, depth + 1);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return `${stringValue(n.left, env)}${stringValue(n.right, env)}`.match(/^ls-(?:files|tree)$/) !== null;
    return false;
  };
  const numberValue = (node, env, depth = 0) => {
    const n = resolve(node, env, depth);
    if (n.kind === ts.SyntaxKind.NumericLiteral) return Number(n.text);
    if (ts.isParenthesizedExpression(n)) return numberValue(n.expression, env, depth + 1);
    if (ts.isBinaryExpression(n)) {
      const a = numberValue(n.left, env, depth + 1);
      const b = numberValue(n.right, env, depth + 1);
      if (a === undefined || b === undefined) return undefined;
      if (n.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return a * b;
      if (n.operatorToken.kind === ts.SyntaxKind.PlusToken) return a + b;
    }
    return undefined;
  };
  const optionsStatus = (node, env, depth = 0) => {
    if (!node) return { status: "noncompliant", reason: "missing-options" };
    const n = resolve(node, env, depth);
    const maxBufferBinding = env.get("maxBuffer");
    if (
      n?.getText?.().includes("maxBuffer") &&
      maxBufferBinding &&
      ts.isIdentifier(resolve(maxBufferBinding, env)) &&
      resolve(maxBufferBinding, env).text === "GIT_LISTING_MAX_BUFFER"
    )
      return { status: "compliant", reason: "forwarded-capacity" };
    if (ts.isConditionalExpression(n)) {
      const branches = [optionsStatus(n.whenTrue, env, depth + 1), optionsStatus(n.whenFalse, env, depth + 1)];
      if (branches.some((branch) => branch.status === "compliant"))
        return { status: "compliant", reason: "conditional-listing-capacity" };
      if (branches.some((branch) => branch.status === "ambiguous"))
        return { status: "ambiguous", reason: "unresolved-options" };
      return branches[0];
    }
    if (ts.isIdentifier(n) && n.text === "GIT_LISTING_MAX_BUFFER") return { status: "compliant", reason: "constant" };
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "gitListingOptions")
      return { status: "compliant", reason: "gitListingOptions" };
    if (!ts.isObjectLiteralExpression(n)) return { status: "ambiguous", reason: "unresolved-options" };
    let result;
    let ambiguous = false;
    for (const p of n.properties) {
      if (ts.isSpreadAssignment(p)) {
        const spreadExpression = resolve(p.expression, env, depth + 1);
        if (spreadExpression.getText?.().includes("maxBuffer: GIT_LISTING_MAX_BUFFER"))
          result = { status: "compliant", reason: "conditional-listing-capacity" };
        if (ts.isConditionalExpression(spreadExpression)) {
          const branches = [spreadExpression.whenTrue, spreadExpression.whenFalse];
          if (
            branches.some(
              (branch) =>
                ts.isObjectLiteralExpression(branch) &&
                branch.properties.some(
                  (q) =>
                    ts.isPropertyAssignment(q) &&
                    propertyName(q) === "maxBuffer" &&
                    ((ts.isIdentifier(q.initializer) && q.initializer.text === "GIT_LISTING_MAX_BUFFER") ||
                      (ts.isCallExpression(q.initializer) &&
                        ts.isIdentifier(q.initializer.expression) &&
                        q.initializer.expression.text === "gitListingOptions")),
                ),
            )
          )
            result = { status: "compliant", reason: "conditional-listing-capacity" };
        }
        const spread = optionsStatus(spreadExpression, env, depth + 1);
        if (spread.status === "compliant") result = spread;
        else if (spread.status === "ambiguous") ambiguous = true;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === "maxBuffer") {
        result = optionsStatus(p.name, env, depth + 1);
        continue;
      }
      if (!ts.isPropertyAssignment(p) || propertyName(p) !== "maxBuffer") continue;
      const v = resolve(p.initializer, env, depth + 1);
      if (ts.isIdentifier(v) && v.text === "GIT_LISTING_MAX_BUFFER")
        result = { status: "compliant", reason: "constant" };
      else if (ts.isCallExpression(v) && ts.isIdentifier(v.expression) && v.expression.text === "gitListingOptions")
        result = { status: "compliant", reason: "gitListingOptions" };
      else {
        const number = numberValue(v, env, depth + 1);
        result =
          number !== undefined && number >= 8 * 1024 * 1024
            ? { status: "compliant", reason: "numeric-capacity" }
            : number !== undefined
              ? { status: "noncompliant", reason: "small-capacity" }
              : { status: "ambiguous", reason: "unresolved-options" };
      }
    }
    return (
      result ??
      (ambiguous
        ? { status: "ambiguous", reason: "unresolved-options" }
        : { status: "noncompliant", reason: "missing-maxBuffer" })
    );
  };
  const calleeSpawner = (node, env) => {
    if (ts.isIdentifier(node)) {
      const n = resolve(node, env);
      if (n && ts.isIdentifier(n) && spawners.has(n.text)) return spawners.get(n.text);
      if (spawners.has(node.text)) return spawners.get(node.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      spawnerNames.has(node.name.text)
    )
      return node.name.text;
    return undefined;
  };
  const rows = new Map();
  const active = new Set();
  function parameters(fn, args, parent) {
    const env = new Map(parent);
    fn.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) env.set(p.name.text, args[i] ?? p.initializer);
      else if (ts.isObjectBindingPattern(p.name)) {
        const object = args[i] ? resolve(args[i], parent) : undefined;
        for (const e of p.name.elements)
          if (ts.isBindingElement(e) && ts.isIdentifier(e.name)) {
            const found =
              object && ts.isObjectLiteralExpression(object)
                ? object.properties.find(
                    (x) => !ts.isSpreadAssignment(x) && propertyName(x) === (e.propertyName?.text ?? e.name.text),
                  )
                : undefined;
            env.set(e.name.text, found && ts.isPropertyAssignment(found) ? found.initializer : e.initializer);
          }
      } else if (ts.isArrayBindingPattern(p.name))
        p.name.elements.forEach((e, j) => {
          if (ts.isBindingElement(e) && ts.isIdentifier(e.name)) env.set(e.name.text, args[j]);
        });
    });
    return env;
  }
  function invoke(fn, args, env, kind) {
    if (!fn || active.has(fn)) return;
    active.add(fn);
    const next = parameters(fn, args, env);
    const hasExecutorDefault = fn.parameters.some((p) => p.initializer);
    inspect(fn.body, next, hasExecutorDefault ? "injected-default" : kind);
    active.delete(fn);
  }
  function inspect(node, env, kind) {
    if (!node) return;
    if (ts.isCallExpression(node)) {
      const spawner = calleeSpawner(node.expression, env);
      if (spawner && stringValue(node.arguments[0], env) === "git" && hasToken(node.arguments[1], env)) {
        const options = optionsStatus(node.arguments[2], env);
        const key = node.getStart(sf);
        const row = { file: sf.fileName, line: lineOf(sf, node), kind, status: options.status, reason: options.reason };
        const old = rows.get(key);
        if (
          !old ||
          old.status === "ambiguous" ||
          (old.status === "noncompliant" && row.status === "compliant") ||
          (row.kind === "injected-default" && old.kind !== "injected-default")
        )
          rows.set(key, row);
      }
      const callee = node.expression;
      let fn;
      if (ts.isIdentifier(callee)) {
        const target = resolve(callee, env);
        if (target && ts.isIdentifier(target)) fn = functions.get(target.text);
        else if (target && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) fn = target;
        if (!fn) fn = functions.get(callee.text);
      }
      if (fn) invoke(fn, [...node.arguments], env, kind === "direct" ? "wrapper" : kind);
    }
    ts.forEachChild(node, (child) => inspect(child, env, kind));
  }
  inspect(sf, new Map(), "direct");
  return [...rows.values()];
}

export function listingSiteInventory({ root = repoRoot, sources } = {}) {
  const tracked =
    sources ??
    execFileSync("git", ["-C", root, "ls-files", "-z", "--", "scripts"], gitListingOptions({ encoding: "utf8" }))
      .split("\0")
      .filter((f) => f.startsWith("scripts/") && extensions.test(f) && f !== "scripts/git-listing-buffer.test.mjs");
  return tracked.flatMap((relativePath) => {
    const file = path.join(root, relativePath);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return [{ file: relativePath, line: 1, kind: "direct", status: "ambiguous", reason: "unreadable" }];
    }
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
    if (sf.parseDiagnostics?.length)
      return [{ file: relativePath, line: 1, kind: "direct", status: "ambiguous", reason: "parse" }];
    return sourceRows(sf);
  });
}

function plant(name, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cs-git-listing-plant-"));
  const relative = `scripts/q7x/${name}.mjs`;
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, source);
  return { root, relative };
}

describe("Git listing buffer contract", () => {
  it("derives a complete tracked scripts inventory with no ambiguous rows", () => {
    const inventory = listingSiteInventory();
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.filter((site) => site.status !== "compliant")).toEqual([]);
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
    expect(listingSiteInventory({ root: repoRoot, sources: ["scripts/q7x/missing.mjs"] })).toEqual([
      { file: "scripts/q7x/missing.mjs", line: 1, kind: "direct", status: "ambiguous", reason: "unreadable" },
    ]);
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
