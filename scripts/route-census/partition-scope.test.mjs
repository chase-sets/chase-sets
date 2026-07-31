import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const expectedProductionModules = [
  "scripts/route-census/artifact.mts",
  "scripts/route-census/capture.mts",
  "scripts/route-census/collision-path.mts",
  "scripts/route-census/comparison.mts",
  "scripts/route-census/errors.mts",
  "scripts/route-census/evaluate-child.mts",
  "scripts/route-census/model.mts",
  "scripts/route-census/run.mts",
  "scripts/route-census/runner.mts",
  "scripts/route-census/strict-json.mts",
  "scripts/route-census/target-authority.mts",
];

function normalizeRepoPath(file) {
  return path.posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function decodeCachedIndex(indexBytes) {
  return indexBytes.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath).sort();
}

function encodeCachedIndex(files) {
  return Buffer.from(`${files.join("\0")}\0`, "utf8");
}

function deriveRawRouteCensusModules(indexBytes) {
  return decodeCachedIndex(indexBytes).filter(
    (file) => file.startsWith("scripts/route-census/") && /\.(?:ts|mts)$/.test(file),
  );
}

function deriveCanonicalModules(indexBytes) {
  return decodeCachedIndex(indexBytes)
    .filter((file) => /\.(?:ts|mts)$/.test(file))
    .filter((file) => !/\.(?:test|spec|d)\.(?:ts|mts)$/.test(file))
    .filter((file) => !/(^|\/)(?:__tests__|e2e|fixtures|tests)(\/|$)/.test(file));
}

function deriveTrackedRouteCensusTests(indexBytes) {
  return decodeCachedIndex(indexBytes).filter(
    (file) => file.startsWith("scripts/route-census/") && file.endsWith(".test.mjs"),
  );
}

function rootIdentifier(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootIdentifier(expression.expression);
  if (ts.isCallExpression(expression)) return rootIdentifier(expression.expression);
  return null;
}

function objectHasTimeout(objectLiteral) {
  return objectLiteral.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "timeout";
  });
}

function scanTestPolicy(testSources) {
  let disabledCases = 0;
  let timeoutOverrides = 0;
  const testRoots = new Set(["describe", "it", "suite", "test"]);
  const disabledMembers = new Set(["skip", "todo", "skipIf", "todoIf"]);

  for (const [file, source] of testSources) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(sourceFile.parseDiagnostics.length, 0, `${file} must parse as JavaScript`);

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const root = rootIdentifier(node.expression);
        if (root && testRoots.has(root)) {
          const member = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
          if (member && disabledMembers.has(member)) disabledCases += 1;
          if (member === "timeout") timeoutOverrides += 1;
          if (node.arguments.length >= 3) timeoutOverrides += 1;
          timeoutOverrides += node.arguments.filter(ts.isObjectLiteralExpression).filter(objectHasTimeout).length;
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return { disabledCases, timeoutOverrides };
}

function loadTrackedTestSources(indexBytes) {
  return new Map(
    deriveTrackedRouteCensusTests(indexBytes).map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]),
  );
}

function routeEntries(partition, category) {
  return partition[category].filter((file) => file.startsWith("scripts/route-census/"));
}

function verifyScope({ indexBytes, partition, testSources }) {
  const rawModules = deriveRawRouteCensusModules(indexBytes);
  const filteredModules = deriveCanonicalModules(indexBytes).filter((file) => file.startsWith("scripts/route-census/"));
  assert.deepEqual(rawModules, expectedProductionModules, "raw route-census TypeScript set drifted");
  assert.deepEqual(filteredModules, expectedProductionModules, "canonical route-census module set drifted");
  assert.deepEqual(routeEntries(partition, "sqlExecuting"), [], "route-census module classified as SQL-executing");
  assert.deepEqual(routeEntries(partition, "unprovableForm"), [], "route-census module classified as unprovable");
  assert.deepEqual(
    routeEntries(partition, "notSql"),
    expectedProductionModules,
    "route-census not-SQL partition drifted",
  );
  assert.deepEqual(
    [...testSources.keys()].sort(),
    deriveTrackedRouteCensusTests(indexBytes),
    "route-census test-source inventory drifted",
  );
  const policy = scanTestPolicy(testSources);
  assert.deepEqual(policy, { disabledCases: 0, timeoutOverrides: 0 }, "route-census suite policy drifted");
  return { rawModules, filteredModules, policy };
}

function withIndexMutation(indexBytes, mutate) {
  const files = decodeCachedIndex(indexBytes);
  mutate(files);
  return encodeCachedIndex(files.sort());
}

function withTestMutation(testSources, sourceSuffix) {
  const mutated = new Map(testSources);
  const firstFile = [...mutated.keys()].sort()[0];
  mutated.set(firstFile, `${mutated.get(firstFile)}\n${sourceSuffix}\n`);
  return mutated;
}

describe("route-census tracked structural partition", () => {
  const indexBytes = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: repoRoot });
  const partition = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/check-structure/sql-execution-surface-partition.json"), "utf8"),
  );
  const testSources = loadTrackedTestSources(indexBytes);

  it("reconciles the raw and canonical cached-index sets with the generated not-SQL partition", () => {
    const result = verifyScope({ indexBytes, partition, testSources });
    expect(result.rawModules).toEqual(expectedProductionModules);
    expect(result.filteredModules).toEqual(expectedProductionModules);
    expect(result.policy).toEqual({ disabledCases: 0, timeoutOverrides: 0 });
  });

  it.each([
    ["one missing production member", (files) => files.splice(files.indexOf(expectedProductionModules[0]), 1)],
    ["one extra ordinary TypeScript member", (files) => files.push("scripts/route-census/hidden.ts")],
    ["one TypeScript member hidden under fixtures", (files) => files.push("scripts/route-census/fixtures/hidden.mts")],
    ["one test-named TypeScript member", (files) => files.push("scripts/route-census/hidden.test.mts")],
  ])("rejects cached-index bypass: %s", (_name, mutate) => {
    const mutantIndex = withIndexMutation(indexBytes, mutate);
    expect(() => verifyScope({ indexBytes: mutantIndex, partition, testSources })).toThrow();
  });

  it("rejects reclassification outside notSql", () => {
    const mutant = structuredClone(partition);
    const moved = mutant.notSql.splice(mutant.notSql.indexOf(expectedProductionModules[0]), 1)[0];
    mutant.sqlExecuting.push(moved);
    mutant.sqlExecuting.sort();
    expect(() => verifyScope({ indexBytes, partition: mutant, testSources })).toThrow();
  });

  it.each([
    [".skip", `it.${"skip"}("disabled", () => {});`],
    [".todo", `it.${"todo"}("disabled");`],
    ["skipIf", `it.${["skip", "If"].join("")}(true)("disabled", () => {});`],
    ["todoIf", `it.${["todo", "If"].join("")}(true)("disabled", () => {});`],
  ])("rejects disabled route-census case: %s", (_name, sourceSuffix) => {
    const mutantSources = withTestMutation(testSources, sourceSuffix);
    expect(() => verifyScope({ indexBytes, partition, testSources: mutantSources })).toThrow();
  });

  it.each([
    ["per-test timeout", `it("slow", () => {}, ${10_000});`],
    ["suite timeout", `describe("slow", { ${["time", "out"].join("")}: ${10_000} }, () => {});`],
  ])("rejects route-census timeout override: %s", (_name, sourceSuffix) => {
    const mutantSources = withTestMutation(testSources, sourceSuffix);
    expect(() => verifyScope({ indexBytes, partition, testSources: mutantSources })).toThrow();
  });
});
