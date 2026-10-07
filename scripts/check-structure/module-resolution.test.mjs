import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseQualificationScopeRegistry } from "../release-qualification-scope.mjs";
import { enumerateTrackedRoots } from "./authoritative-stream-read-classification.mjs";
import {
  resolveModule,
  buildGuardImportCandidates,
  enumerateGuardImportCandidates,
  GUARD_IMPORT_EMISSION_TABLE,
  GUARD_IMPORT_SPECIFIER_FORMS,
  GUARD_IMPORT_DERIVATION_RULES,
  GUARD_IMPORT_CANDIDATE_SUFFIXES,
  GUARD_IMPORT_SPECULATIVE_ROOTS,
  GUARD_IMPORT_MAPPED_SUBPATH_FORMS,
  enumerateCanonicalModuleCandidates,
  buildModuleResolutionContextFixture,
  MODULE_RESOLUTION_CANONICAL_STATES,
  MODULE_RESOLUTION_DERIVATION_RULES,
  MODULE_RESOLUTION_CANDIDATE_SUFFIXES,
  MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY,
} from "./module-resolution.mjs";

const workspacePackages = new Map([
  [
    "@chase-sets/example",
    {
      root: "packages/example",
      exports: {
        ".": "./index.ts",
        "./exact": "./src/exact",
        "./*": "./src/*.ts",
      },
    },
  ],
]);

const existingPaths = new Set([
  "bounded-contexts/example/explicit.ts",
  "bounded-contexts/example/inferred.ts",
  "bounded-contexts/example/directory/index.ts",
  "bounded-contexts/example/module.mts",
  "packages/example/index.ts",
  "packages/example/src/exact/index.mts",
  "packages/example/src/wildcard.ts",
]);

function resolve(importerPath, specifierText) {
  return resolveModule({ importerPath, specifierText, workspacePackages, existingPaths });
}

describe("SQL execution module resolution", () => {
  it.each([
    ["relative with extension", "./explicit.ts", { kind: "repo", path: "bounded-contexts/example/explicit.ts" }],
    ["relative extension inferred", "./inferred", { kind: "repo", path: "bounded-contexts/example/inferred.ts" }],
    ["directory index inferred", "./directory", { kind: "repo", path: "bounded-contexts/example/directory/index.ts" }],
    ["mts candidate", "./module", { kind: "repo", path: "bounded-contexts/example/module.mts" }],
    ["bare workspace package", "@chase-sets/example", { kind: "repo", path: "packages/example/index.ts" }],
    [
      "exact package subpath",
      "@chase-sets/example/exact",
      { kind: "repo", path: "packages/example/src/exact/index.mts" },
    ],
    [
      "wildcard package subpath",
      "@chase-sets/example/wildcard",
      { kind: "repo", path: "packages/example/src/wildcard.ts" },
    ],
    ["non-workspace bare specifier", "hono", { kind: "external" }],
    ["node specifier", "node:path", { kind: "external" }],
  ])("%s", (_label, specifierText, expected) => {
    expect(resolve("bounded-contexts/example/source.ts", specifierText)).toEqual(expected);
  });

  it("rejects a relative path escaping above the repository root", () => {
    expect(resolve("source.ts", "../outside")).toEqual({ kind: "unresolved", reason: "path-escapes-repository" });
  });

  it("reports a missing candidate", () => {
    expect(resolve("bounded-contexts/example/source.ts", "./absent")).toEqual({
      kind: "unresolved",
      reason: "missing-file",
    });
  });

  it("reports an unmatched workspace subpath", () => {
    const packagesWithoutWildcard = new Map([
      ["@chase-sets/example", { root: "packages/example", exports: { ".": "./index.ts" } }],
    ]);
    expect(
      resolveModule({
        importerPath: "bounded-contexts/example/source.ts",
        specifierText: "@chase-sets/example/absent",
        workspacePackages: packagesWithoutWildcard,
        existingPaths,
      }),
    ).toEqual({ kind: "unresolved", reason: "workspace-export-not-found" });
  });
});

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const modulePath = fileURLToPath(new URL("./module-resolution.mjs", import.meta.url));
const footprint = Object.freeze([
  "scripts/check-structure/module-resolution.mjs",
  "scripts/check-structure/module-resolution.test.mjs",
  "scripts/check-structure/fixtures/guard-import-candidate-purity/loader-hook.mjs",
  "scripts/check-structure/fixtures/guard-import-candidate-purity/denied-fs.mjs",
  "scripts/check-structure/fixtures/guard-import-candidate-purity/ambient-probe.mjs",
  "scripts/check-structure/fixtures/guard-import-candidate-purity/child.mjs",
]);
const oracle = JSON.parse(
  readFileSync(new URL("./fixtures/guard-import-candidate-emission/emission-oracle.json", import.meta.url), "utf8"),
);
const input = { importerPath: "bounded-contexts/example/source.ts", specifierText: "./inferred" };
const inventories = [
  GUARD_IMPORT_SPECIFIER_FORMS,
  GUARD_IMPORT_DERIVATION_RULES,
  GUARD_IMPORT_CANDIDATE_SUFFIXES,
  GUARD_IMPORT_SPECULATIVE_ROOTS,
  GUARD_IMPORT_MAPPED_SUBPATH_FORMS,
];
const paths = (record) => record.candidates.map((candidate) => candidate.path);
const normalize = (value) => path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const emit = (label, value) => console.log(`${label} ${JSON.stringify(value)}`);
function assertSequence(actual, expected) {
  assert.deepEqual(actual, expected);
}
function assertDeepFrozen(value) {
  if (value && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => {
      value.syntheticMutation = true;
    }).toThrow(TypeError);
    for (const member of Object.values(value)) assertDeepFrozen(member);
  }
}
function duplicateTable(table = GUARD_IMPORT_EMISSION_TABLE) {
  const synthetic = structuredClone(table);
  synthetic[0].suffixes.splice(2, 0, ".ts");
  return synthetic;
}
function movedRows(enumerate) {
  return oracle.rows
    .filter((row) => {
      try {
        assertSequence(paths(enumerate(row)), row.candidates);
        return false;
      } catch {
        return true;
      }
    })
    .map(({ index, importerPath, specifierText }) => ({ index, importerPath, specifierText }));
}
function runPurity(target = pathToFileURL(modulePath).href) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/guard-import-candidate-purity/child.mjs", import.meta.url)), target],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
}

describe("raw guard import candidate emission", () => {
  it("AC1 closed deeply frozen record and candidate grammar", () => {
    for (const row of oracle.rows) {
      const record = enumerateGuardImportCandidates(row);
      expect(Reflect.ownKeys(record)).toEqual(["specifierForm", "candidates"]);
      expect(GUARD_IMPORT_SPECIFIER_FORMS).toContain(record.specifierForm);
      assertDeepFrozen(record);
      for (const candidate of record.candidates) {
        expect(Reflect.ownKeys(candidate)).toEqual(["path", "rule", "suffix", "speculativeRoot", "mappedSubpath"]);
        expect(GUARD_IMPORT_DERIVATION_RULES).toContain(candidate.rule);
        expect(GUARD_IMPORT_CANDIDATE_SUFFIXES).toContain(candidate.suffix);
        if (record.specifierForm !== "scoped-package-subpath") {
          expect(candidate.speculativeRoot).toBeNull();
          expect(candidate.mappedSubpath).toBeNull();
        } else {
          expect(GUARD_IMPORT_SPECULATIVE_ROOTS).toContain(candidate.speculativeRoot);
          expect(GUARD_IMPORT_MAPPED_SUBPATH_FORMS).toContain(candidate.mappedSubpath);
        }
      }
    }
  });

  it("AC2 inventories are exact ordered snapshots derived from the table", () => {
    expect(inventories).toEqual([
      ["INDETERMINATE", "dot-prefixed-relative", "scoped-package-subpath", "no-emission"],
      ["dot-prefixed-relative-target", "scoped-package-speculative-root"],
      ["", ".ts", ".tsx", ".mjs", "/index.ts"],
      ["bounded-contexts", "contracts", "infrastructure", "packages"],
      ["subpath", "support/subpath"],
    ]);
    for (const [index, member] of ["form", "rule", "suffixes", "roots", "mappedSubpaths"].entries()) {
      const derived = [...new Set(GUARD_IMPORT_EMISSION_TABLE.flatMap((branch) => branch[member] ?? []))];
      expect(inventories[index]).toEqual(index === 0 ? ["INDETERMINATE", ...derived] : derived);
      assertDeepFrozen(inventories[index]);
    }
  });

  it("AC3 recursively immutable single table and bound builder agree on 31 rows", () => {
    assertDeepFrozen(GUARD_IMPORT_EMISSION_TABLE);
    expect(GUARD_IMPORT_EMISSION_TABLE.map(({ form }) => form)).toEqual(GUARD_IMPORT_SPECIFIER_FORMS.slice(1));
    for (const row of oracle.rows) {
      expect(enumerateGuardImportCandidates(row)).toEqual(
        buildGuardImportCandidates({ ...row, emissionTable: GUARD_IMPORT_EMISSION_TABLE }),
      );
    }
    emit("AC3 compared", oracle.rows.length);
  });

  it("AC4 inherited oracle sequence-exact across every declared row", () => {
    expect(oracle.sourceCommit).toBe("f78143573af96c636d97696b987a82990df23904");
    expect(oracle.declarationSha256).toBe("0baa51a3f502e92ad62ecdcd4d1d225e04592d708d5a3cabec34c557a812a312");
    expect(oracle.rows).toHaveLength(31);
    expect(oracle.fixture).toHaveLength(31);
    const counts = {};
    let total = 0;
    for (const [index, row] of oracle.rows.entries()) {
      expect({ importerPath: row.importerPath, specifierText: row.specifierText }).toEqual(oracle.fixture[index]);
      const record = enumerateGuardImportCandidates(row);
      assertSequence(paths(record), row.candidates);
      counts[record.specifierForm] = (counts[record.specifierForm] ?? 0) + 1;
      total += record.candidates.length;
    }
    expect(counts).toEqual({ "dot-prefixed-relative": 18, "scoped-package-subpath": 7, "no-emission": 6 });
    expect(total).toBe(258);
    emit("AC4 scanned = 31 / declared = 31", {
      total,
      counts,
      sourceCommit: oracle.sourceCommit,
      declarationSha256: oracle.declarationSha256,
    });
  });

  it("AC4 comparator rejects order and multiplicity changes even when sets agree", () => {
    for (const changed of [
      ["b", "a"],
      ["a", "b", "b"],
    ]) {
      expect(new Set(changed)).toEqual(new Set(["a", "b"]));
      expect(() => assertSequence(changed, ["a", "b"])).toThrow();
      emit("AC4 comparator rejected", changed);
    }
  });

  it("AC5 synthetic duplicate suffix passes closed validation and preserves both positions", () => {
    const result = buildGuardImportCandidates({ ...input, emissionTable: duplicateTable() });
    expect(result.candidates).toHaveLength(6);
    expect(paths(result).slice(1, 3)).toEqual([
      "bounded-contexts/example/inferred.ts",
      "bounded-contexts/example/inferred.ts",
    ]);
    expect(result.candidates[1]).not.toBe(result.candidates[2]);
    expect(enumerateGuardImportCandidates(input).candidates).toHaveLength(5);
    emit("AC5 synthetic positions", paths(result));
  });

  it.each([
    [
      "form",
      (table) => {
        table[0].form = "invented";
      },
    ],
    [
      "rule",
      (table) => {
        table[0].rule = "invented";
      },
    ],
    [
      "suffix",
      (table) => {
        table[0].suffixes.push(".invented");
      },
    ],
    [
      "root",
      (table) => {
        table[1].roots.push("invented");
      },
    ],
    [
      "mapped subpath",
      (table) => {
        table[1].mappedSubpaths.push("invented");
      },
    ],
    [
      "extra key",
      (table) => {
        table[0].invented = true;
      },
    ],
    [
      "repeated branch",
      (table) => {
        table.push(table[0]);
      },
    ],
  ])("closed table refuses unknown %s", (_label, mutate) => {
    const table = structuredClone(GUARD_IMPORT_EMISSION_TABLE);
    mutate(table);
    expect(() => buildGuardImportCandidates({ ...input, emissionTable: table })).toThrow(TypeError);
  });

  it("AC6 literal U+005C survives in the specifier", () => {
    const result = enumerateGuardImportCandidates({ ...input, specifierText: ".\\inferred" });
    expect(result.specifierForm).toBe("dot-prefixed-relative");
    expect(paths(result)).toEqual([
      "bounded-contexts/example/.\\inferred",
      "bounded-contexts/example/.\\inferred.ts",
      "bounded-contexts/example/.\\inferred.tsx",
      "bounded-contexts/example/.\\inferred.mjs",
      "bounded-contexts/example/.\\inferred/index.ts",
    ]);
    expect(paths(result).every((value) => value.includes(String.fromCharCode(92)))).toBe(true);
    emit(
      "AC6 literal backslashes",
      paths(result).map((value) => ({
        value,
        positions: [...value].flatMap((character, index) => (character === String.fromCharCode(92) ? [index] : [])),
      })),
    );
  });

  it("AC6 raw backslash importer has the posix dot directory", () => {
    const importerPath = "bounded-contexts\\example\\source.ts";
    expect(path.posix.dirname(importerPath)).toBe(".");
    expect(paths(enumerateGuardImportCandidates({ ...input, importerPath }))).toEqual([
      "inferred",
      "inferred.ts",
      "inferred.tsx",
      "inferred.mjs",
      "inferred/index.ts",
    ]);
  });

  it("AC7 package dot segments retain root/mapping/suffix order", () => {
    const result = enumerateGuardImportCandidates({ ...input, specifierText: "@chase-sets/example/a/../b" });
    const values = paths(result);
    expect(values).toHaveLength(24);
    expect(values.every((value) => value.includes("/../"))).toBe(true);
    expect(values[0]).toBe("bounded-contexts/example/a/../b");
    expect(values.at(-1)).toBe("packages/example/support/a/../b/index.ts");
    const branch = GUARD_IMPORT_EMISSION_TABLE[1];
    expect(
      result.candidates.map(({ speculativeRoot, mappedSubpath, suffix }) => [speculativeRoot, mappedSubpath, suffix]),
    ).toEqual(
      branch.roots.flatMap((root) =>
        branch.mappedSubpaths.flatMap((mapped) => branch.suffixes.map((suffix) => [root, mapped, suffix])),
      ),
    );
    emit("AC7 ordered raw rows", values);
  });

  it("AC7 24 distinct raw strings have only 15 normalized identities", () => {
    const values = paths(
      enumerateGuardImportCandidates({ ...input, specifierText: "@chase-sets/example/../../packages/example/x" }),
    );
    expect(values).toHaveLength(24);
    expect(new Set(values).size).toBe(24);
    expect(new Set(values.map(normalize)).size).toBe(15);
    emit("AC7 distinct", { raw: 24, normalized: 15 });
  });

  it("AC8 only the frozen registry proves raw guard neutrality without a cardinality pin", () => {
    const patterns = releaseQualificationScopeRegistry.seedBootstrapImportReconciliationPatterns;
    expect(Object.isFrozen(patterns)).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((pattern) => pattern.test("infrastructure/bounded-context-runtime/seeding.ts"))).toBe(true);
    const counts = (members) =>
      [
        "@chase-sets/bounded-context-runtime/../../infrastructure/bounded-context-runtime/seeding.ts",
        "@chase-sets/example/../catalog/support/seed-support/x",
      ].map((specifierText) => {
        const values = paths(enumerateGuardImportCandidates({ ...input, specifierText }));
        expect(values).toHaveLength(24);
        const matches = (value) => members.some((pattern) => pattern.test(value));
        return [values.filter(matches).length, values.map(normalize).filter(matches).length];
      });
    expect(counts(patterns)).toEqual([
      [0, 4],
      [0, 3],
    ]);
    expect(counts([...patterns, /^synthetic-unrelated-pattern$/])).toEqual([
      [0, 4],
      [0, 3],
    ]);
    emit("AC8 patterns/raw/normalized", { patterns: patterns.length, counts: counts(patterns) });
  });

  it.each([
    "@chase-sets/example",
    "@chase-sets/example/",
    "@chase-sets/Example/bad",
    "node:fs",
    "typescript",
    "@vendor/example/looksalike",
  ])("AC9 zero-emission arm: %s", (specifierText) => {
    const result = enumerateGuardImportCandidates({ ...input, specifierText });
    expect(result).toEqual({ specifierForm: "no-emission", candidates: [] });
    assertDeepFrozen(result);
    emit("AC9 zero", { specifierText, ...result });
  });

  it("AC10 purity boundary and every labeled synthetic interception are live", () => {
    const child = runPurity();
    expect(child.status, child.stderr).toBe(0);
    const payload = JSON.parse(child.stdout);
    expect(payload.pinnedRecord).toEqual(enumerateGuardImportCandidates(input));
    expect(payload.environmentReads).toEqual({ import: 0, call: 0, synthetic: 1 });
    for (const key of [
      "stubsRestored",
      "globalNamesUnchanged",
      "inputUnchanged",
      "firstRecordUnchanged",
      "noAliasing",
      "deeplyFrozen",
    ])
      expect(payload[key]).toBe(true);
    expect(payload.caught).toEqual({
      filesystem: true,
      loadModuleResolutionContext: true,
      environment: true,
      dateNow: true,
      dateConstruction: true,
      dateApplication: true,
      randomness: true,
      performance: true,
      locale: true,
      cwd: true,
    });
    emit("AC10 purity", payload);
  });

  it("AC11 literal footprint contains no child gate or recursive test launch", () => {
    const forbidden =
      /(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)\s*\([^;]*(?:["'`]vitest["'`]|["'`](?:test:scripts|verify(?::[a-z-]+)?)["'`])/s;
    const matches = footprint.filter((file) => forbidden.test(readFileSync(path.join(repoRoot, file), "utf8")));
    expect(matches).toEqual([]);
    emit("AC11 gate-launch grep", matches);
  });

  it("AC12 standing pointer sweep permits exactly the registry import and no predecessor assertion", () => {
    const needle = ["release", "qualification", "scope"].join("-");
    const source = readFileSync(new URL("./module-resolution.test.mjs", import.meta.url), "utf8");
    const matches = source
      .split("\n")
      .flatMap((line, index) => (line.includes(needle) ? [{ line: index + 1, text: line.trim() }] : []));
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe(`import { releaseQualificationScopeRegistry } from "../${needle}.mjs";`);
    const uses = source.split("\n").filter((line) => line.includes("releaseQualification" + "ScopeRegistry"));
    expect(uses).toHaveLength(3);
    expect(uses[1].trim()).toBe(
      "const patterns = releaseQualification" + "ScopeRegistry.seedBootstrapImportReconciliationPatterns;",
    );
    for (const file of footprint.filter((file) => !file.endsWith(".test.mjs")))
      expect(readFileSync(path.join(repoRoot, file), "utf8")).not.toContain(needle);
    emit("AC12 pointer grep", matches);
    emit("AC8 registry-only assertion", uses[1].trim());
  });

  it("FOOTPRINT_OUTSIDE_GOVERNED_INVENTORIES", () => {
    const roots = new Set(enumerateTrackedRoots(repoRoot));
    for (const file of footprint) {
      expect(roots.has(file)).toBe(false);
      expect(file).not.toMatch(/\.(?:ts|mts)$/);
    }
    emit("AC13 literal footprint", footprint);
  });
});

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `unique mutation target: ${before}`);
  return source.replace(before, after);
}

// Verdicts measured at f78143573af96c636d97696b987a82990df23904; boundary rows at 55314342.
const canonicalFiles = [
  ...[
    "inferred.ts",
    "dual.ts",
    "dual.mts",
    "di/index.ts",
    "di/index.mts",
    "fi.mts",
    "fi/index.ts",
    "target",
    "target.ts",
    "t.tsx",
    "t.tsx.ts",
    "onlytsx.tsx",
    "onlymjs.mjs",
    "inferredm.mts",
  ].map((file) => `bounded-contexts/example/${file}`),
  "packages/example-2/nested/inferred.ts",
  "packages/example/src/exact/index.mts",
  "packages/wild/src/thing.ts",
  "packages/starjs/src/thing.ts",
  "packages/example-2/src/deep.ts",
];
const canonicalPackages = [
  [
    "@chase-sets/example",
    {
      root: "packages/example",
      exports: {
        ".": "./index.ts",
        "./exact": "./src/exact",
        "./refused": "",
        "./*": "./src/*.ts",
      },
    },
  ],
  ["@chase-sets/wild", { root: "packages/wild", exports: { "./*": "./src/*.ts" } }],
  ["@chase-sets/escaper", { root: "packages/escaper", exports: { "./out": "../../../outside.ts" } }],
  ["@chase-sets/arrayed", { root: "packages/arrayed", exports: ["./index.ts"] }],
  ["@chase-sets/starjs", { root: "packages/starjs", exports: { "./*": "./src/*.ts", "./*.js": "./src/*.js" } }],
  ["@chase-sets/example-2", { root: "packages/example-2", exports: { "./*": "./src/*.ts" } }],
];
const canonicalContext = buildModuleResolutionContextFixture({ files: canonicalFiles, packages: canonicalPackages });
const canonicalImporters = [
  "bounded-contexts/example/source.ts",
  "bounded-contexts\\example\\source.ts",
  "./bounded-contexts/example/source.ts",
  "packages/example-2/nested/source.ts",
];
const hit = (path) => ({ kind: "repo", path });
const refusal = (reason) => (reason === "external" ? { kind: "external" } : { kind: "unresolved", reason });
const canonicalRows = [
  [0, "./inferred", "bounded-contexts/example/inferred", "bounded-contexts/example/inferred.ts"],
  [1, "./inferred", "bounded-contexts/example/inferred", "bounded-contexts/example/inferred.ts"],
  [2, "./inferred", "bounded-contexts/example/inferred", "bounded-contexts/example/inferred.ts"],
  [3, "./inferred", "packages/example-2/nested/inferred", "packages/example-2/nested/inferred.ts"],
  [0, "./inferred.ts", "bounded-contexts/example/inferred.ts", "bounded-contexts/example/inferred.ts"],
  [0, "./dual", "bounded-contexts/example/dual", "bounded-contexts/example/dual.ts"],
  [0, "./di", "bounded-contexts/example/di", "bounded-contexts/example/di/index.ts"],
  [0, "./fi", "bounded-contexts/example/fi", "bounded-contexts/example/fi.mts"],
  [0, "./target", "bounded-contexts/example/target", "bounded-contexts/example/target.ts"],
  [0, "./t.tsx", "bounded-contexts/example/t.tsx", "bounded-contexts/example/t.tsx.ts"],
  [0, "./inferredm", "bounded-contexts/example/inferredm", "bounded-contexts/example/inferredm.mts"],
  [0, "./onlytsx", "bounded-contexts/example/onlytsx", "missing-file"],
  [0, "./onlymjs", "bounded-contexts/example/onlymjs", "missing-file"],
  [0, "./absent", "bounded-contexts/example/absent", "missing-file"],
  [0, "../sibling/mod", "bounded-contexts/sibling/mod", "missing-file"],
  [0, "../../../escape/mod", null, "path-escapes-repository"],
  [0, ".\\inferred", null, "external"],
  [0, ".hidden", null, "external"],
  [0, ".", null, "external"],
  [0, "..", null, "external"],
  [0, "@chase-sets/example", "packages/example/index.ts", "missing-file", "workspace-export-exact"],
  [
    0,
    "@chase-sets/example/exact",
    "packages/example/src/exact",
    "packages/example/src/exact/index.mts",
    "workspace-export-exact",
  ],
  [0, "@chase-sets/example/refused", null, "workspace-export-not-found"],
  [
    0,
    "@chase-sets/wild/thing",
    "packages/wild/src/thing.ts",
    "packages/wild/src/thing.ts",
    "workspace-export-wildcard",
  ],
  [0, "@chase-sets/wild/absent", "packages/wild/src/absent.ts", "missing-file", "workspace-export-wildcard"],
  [0, "@chase-sets/escaper/out", null, "path-escapes-repository"],
  [0, "@chase-sets/arrayed", null, "workspace-export-not-found"],
  [
    0,
    "@chase-sets/starjs/thing",
    "packages/starjs/src/thing.ts",
    "packages/starjs/src/thing.ts",
    "workspace-export-wildcard",
  ],
  [
    0,
    "@chase-sets/example-2/deep",
    "packages/example-2/src/deep.ts",
    "packages/example-2/src/deep.ts",
    "workspace-export-wildcard",
  ],
  [0, "@chase-sets/unknown/x", null, "external"],
  [0, "typescript", null, "external"],
].map(([importer, specifierText, target, verdict, rule = "relative-target"], index) => ({
  id: index + 1,
  importerPath: canonicalImporters[importer],
  specifierText,
  target,
  rule,
  expected: verdict.includes("/") ? hit(verdict) : refusal(verdict),
  ...canonicalContext,
}));
const boundaryGroups = [
  [
    "source.ts",
    "./.",
    null,
    ".",
    [
      [1, "index.ts", "missing-file"],
      [2, "./index.ts", "hit"],
      [40, ".", "missing-file"],
    ],
  ],
  [
    "source.ts",
    "./dir/",
    null,
    "dir/",
    [
      [3, "dir/index.ts", "missing-file"],
      [4, "dir//index.ts", "hit"],
      [5, "dir/.ts", "hit"],
      [41, "dir/", "missing-file"],
    ],
  ],
  [
    "source.ts",
    "./",
    null,
    "",
    [
      [6, "/index.ts", "hit"],
      [7, "index.ts", "missing-file"],
      [8, ".ts", "hit"],
      [39, "", "missing-file"],
    ],
  ],
  [
    "/source.ts",
    "./.",
    null,
    "/",
    [
      [9, "/index.ts", "missing-file"],
      [10, "//index.ts", "hit"],
    ],
  ],
  ["./source.ts", "././dir", null, "dir", [[21, "dir/index.ts", "hit"]]],
  ["source.ts", "./dir//", null, "dir/", [[22, "dir/index.ts", "missing-file"]]],
  ["dir/source.ts", "../.", null, ".", [[23, "index.ts", "missing-file"]]],
  ["dir/source.ts", "../", null, "", [[24, "/index.ts", "hit"]]],
  ["source.ts", "../.", null, null, [[25, "../index.ts", "path-escapes-repository"]]],
  ["source.ts", "../", null, null, [[26, "..//index.ts", "path-escapes-repository"]]],
  ["source.ts", "../dir/", null, null, [[27, "../dir//index.ts", "path-escapes-repository"]]],
  ["source.ts", "", null, null, [[28, ".ts", "external"]]],
  ["source.ts", ".", null, null, [[29, "index.ts", "external"]]],
  ["source.ts", "..", null, null, [[30, "../index.ts", "external"]]],
  ["source.ts", ".\\dir\\", null, null, [[31, "dir/index.ts", "external"]]],
  ["source.ts", "./dir\\", null, "dir/", [[32, "dir/index.ts", "missing-file"]]],
  ["source.ts", "./.\\", null, "", [[33, "/index.ts", "hit"]]],
  ["source.ts", "./dir/../file.ts", null, "file.ts", [[34, "file.ts", "hit"]]],
  ["source.ts", "././file.mts", null, "file.mts", [[35, "file.mts", "hit"]]],
  ["source.ts", "./file.ts/", null, "file.ts/", [[36, "file.ts//index.ts", "hit"]]],
  ["source.ts", "./dir/.", null, "dir", [[37, "dir/index.ts", "hit"]]],
  ["source.ts", "./dir/./", null, "dir/", [[38, "dir/index.ts", "missing-file"]]],
  [
    "source.ts",
    "@case/pkg",
    [".", { ".": "." }],
    ".",
    [
      [42, "index.ts", "missing-file"],
      [43, "./index.ts", "hit"],
    ],
  ],
  ["source.ts", "@case/pkg", [".", { ".": "./" }], "", [[44, "/index.ts", "hit"]]],
  ["source.ts", "@case/pkg", [".", { ".": "" }], null, [[45, ".ts", "workspace-export-not-found"]]],
  ["source.ts", "@case/pkg", ["", { ".": "." }], ".", [[46, "./index.ts", "hit"]]],
  [
    "source.ts",
    "@case/pkg",
    ["pkg", { ".": "./dir/" }],
    "pkg/dir/",
    [
      [47, "pkg/dir/index.ts", "missing-file"],
      [48, "pkg/dir//index.ts", "hit"],
    ],
  ],
  ["source.ts", "@case/pkg/x", ["pkg", { "./*": "./*/" }], "pkg/x/", [[49, "pkg/x//index.ts", "hit"]]],
  ["source.ts", "@case/pkg", [".", { ".": ".." }], null, [[50, "../index.ts", "path-escapes-repository"]]],
  ["source.ts", "@case/pkg", ["/", { ".": "." }], "/", [[51, "//index.ts", "hit"]]],
  ["source.ts", "@case/pkg", ["./pkg", { ".": "./dir" }], "pkg/dir", [[52, "pkg/dir/index.ts", "hit"]]],
];
const boundaryRows = boundaryGroups
  .flatMap(([importerPath, specifierText, pkg, target, cases]) =>
    cases.flatMap(([id, member, verdict]) => {
      const row = {
        id,
        importerPath,
        specifierText,
        target,
        rule: pkg ? (id === 49 ? "workspace-export-wildcard" : "workspace-export-exact") : "relative-target",
        workspacePackages: new Map(pkg ? [["@case/pkg", { root: pkg[0], exports: pkg[1] }]] : []),
        existingPaths: new Set([member]),
        expected: verdict === "hit" ? hit(member) : refusal(verdict),
      };
      if (id > 10) return [row];
      const twin = member.replace(/\.ts$/, ".mts");
      return [
        row,
        {
          ...row,
          id: id + 10,
          existingPaths: new Set([twin]),
          expected: verdict === "hit" ? hit(twin) : refusal(verdict),
        },
      ];
    }),
  )
  .sort((a, b) => a.id - b.id);
const canonicalPartition = (resolve) => {
  const counts = {};
  for (const row of canonicalRows) {
    const result = resolve(row);
    const key = result.reason ?? result.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};
const expectedPartition = {
  repo: 15,
  "missing-file": 6,
  "path-escapes-repository": 2,
  "workspace-export-not-found": 2,
  external: 6,
};
function assertCanonicalRecord(record, row) {
  assert.deepEqual(Reflect.ownKeys(record), ["canonicalState", "canonicalTarget", "candidates"]);
  assert.equal(record.canonicalTarget, row.target);
  const resolving = ["relative-inside-repository", "workspace-export-resolved"].includes(record.canonicalState);
  assert.equal(record.canonicalTarget !== null, resolving);
  assert.equal(record.candidates.length > 0, record.canonicalTarget !== null);
  const state =
    row.target === null
      ? (row.expected.reason ?? row.expected.kind)
      : row.rule === "relative-target"
        ? "relative-inside-repository"
        : "workspace-export-resolved";
  assert.equal(record.canonicalState, state);
  const suffixes =
    row.target === null ? [] : /\.(?:ts|mts)$/.test(row.target) ? [""] : ["", ".ts", ".mts", "/index.ts", "/index.mts"];
  assert.deepEqual(
    record.candidates,
    suffixes.map((suffix) => ({
      path: row.target + suffix,
      rule: row.rule,
      suffix,
      canonicalSelection: suffix !== "" || /\.(?:ts|mts)$/.test(row.target),
    })),
  );
  for (const candidate of record.candidates) {
    assert.deepEqual(Reflect.ownKeys(candidate), ["path", "rule", "suffix", "canonicalSelection"]);
    assert.equal(candidate.path, record.canonicalTarget + candidate.suffix);
  }
}
function assertSingleRule(record) {
  assert.ok(new Set(record.candidates.map(({ rule }) => rule)).size <= 1);
}
function assertDistinctPaths(record) {
  assert.equal(new Set(paths(record)).size, record.candidates.length);
}
function canonicalPurity(target = pathToFileURL(modulePath).href) {
  const hook = new URL("./fixtures/guard-import-candidate-purity/loader-hook.mjs", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { register } from "node:module";
    register(${JSON.stringify(hook)});
    const m = await import(${JSON.stringify(target)});
    const input = { importerPath: "odd-zone/entry.mts", specifierText: "./peer.mts",
      workspacePackages: new Map(), existingPaths: new Set(["odd-zone/peer.mts"]) };
    const record = m.enumerateCanonicalModuleCandidates(input);
    assert.deepEqual(record, { canonicalState: "relative-inside-repository", canonicalTarget: "odd-zone/peer.mts",
      candidates: [{ path: "odd-zone/peer.mts", rule: "relative-target", suffix: "", canonicalSelection: true }] });
    assert.deepEqual(m.resolveModule(input), { kind: "repo", path: "odd-zone/peer.mts" });
    assert.throws(() => m.loadModuleResolutionContext("synthetic-root"), /DENIED:filesystem/);
    console.log(JSON.stringify({ record, resolver: "pinned", loader: "DENIED:filesystem" }));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

describe("canonical module candidates", () => {
  it("AC1 AC3 closed frozen grammar and exact targets across both matrices", () => {
    for (const row of [...canonicalRows, ...boundaryRows]) {
      const record = enumerateCanonicalModuleCandidates(row);
      assertCanonicalRecord(record, row);
      assertDeepFrozen(record);
    }
    const absentRoot = canonicalRows[20];
    expect(enumerateCanonicalModuleCandidates(absentRoot).canonicalState).toBe("workspace-export-resolved");
    expect(resolveModule(absentRoot)).toEqual(refusal("missing-file"));
  });

  it("AC2 inventories are exact, frozen and derived from the tables actually read", async () => {
    const source = readFileSync(modulePath, "utf8");
    const m = await import(
      `data:text/javascript;base64,${Buffer.from(source + "\nexport { canonicalBranches };").toString("base64")}`
    );
    const inventories = [
      MODULE_RESOLUTION_CANONICAL_STATES,
      MODULE_RESOLUTION_DERIVATION_RULES,
      MODULE_RESOLUTION_CANDIDATE_SUFFIXES,
    ];
    expect(inventories).toEqual([
      [
        "INDETERMINATE",
        "relative-inside-repository",
        "workspace-export-resolved",
        "workspace-export-not-found",
        "path-escapes-repository",
        "external",
      ],
      ["relative-target", "workspace-export-exact", "workspace-export-wildcard"],
      ["", ".ts", ".mts", "/index.ts", "/index.mts"],
    ]);
    expect(MODULE_RESOLUTION_CANONICAL_STATES).toEqual(Object.keys(m.canonicalBranches));
    expect(MODULE_RESOLUTION_DERIVATION_RULES).toEqual([
      ...new Set(Object.values(m.canonicalBranches).flatMap(({ rules }) => rules)),
    ]);
    expect(MODULE_RESOLUTION_CANDIDATE_SUFFIXES).toEqual([
      ...new Set(MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY.map(({ suffix }) => suffix)),
    ]);
    for (const inventory of [...inventories, m.canonicalBranches, MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY])
      assertDeepFrozen(inventory);
  });

  it("AC4 six eligibility rows are exact and each is produced by the fixture", () => {
    expect(MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY).toEqual([
      { targetForm: "supported-explicit-extension", suffix: "", canonicalSelection: true },
      { targetForm: "other", suffix: "", canonicalSelection: false },
      { targetForm: "other", suffix: ".ts", canonicalSelection: true },
      { targetForm: "other", suffix: ".mts", canonicalSelection: true },
      { targetForm: "other", suffix: "/index.ts", canonicalSelection: true },
      { targetForm: "other", suffix: "/index.mts", canonicalSelection: true },
    ]);
    const covered = new Set();
    for (const row of canonicalRows) {
      const record = enumerateCanonicalModuleCandidates(row);
      for (const candidate of record.candidates) {
        const form = /\.(?:ts|mts)$/.test(record.canonicalTarget) ? "supported-explicit-extension" : "other";
        covered.add(`${form}:${candidate.suffix}:${candidate.canonicalSelection}`);
      }
    }
    for (const row of MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY) {
      expect(Reflect.ownKeys(row)).toEqual(["targetForm", "suffix", "canonicalSelection"]);
      expect(["supported-explicit-extension", "other"]).toContain(row.targetForm);
      expect(MODULE_RESOLUTION_CANDIDATE_SUFFIXES).toContain(row.suffix);
      expect(covered.has(`${row.targetForm}:${row.suffix}:${row.canonicalSelection}`)).toBe(true);
    }
    expect(covered.size).toBe(MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY.length);
    emit("canonical AC4 rows covered = 6 / rows declared = 6", MODULE_RESOLUTION_CANDIDATE_ELIGIBILITY);
  });

  it.each([5, 6, 7, 8, 9])("AC5 observed ordering row %s", (index) => {
    const row = canonicalRows[index];
    expect(resolveModule(row)).toEqual(row.expected);
    emit("canonical AC5 selection", { specifier: row.specifierText, result: resolveModule(row) });
  });

  it.each(["target", "onlytsx.tsx", "onlymjs.mjs"])("AC6 singleton %s is ineligible", (file) => {
    const specifierText = file === "target" ? "./target" : `./${file.split(".")[0]}`;
    const row = { ...canonicalRows[0], specifierText, existingPaths: new Set([`bounded-contexts/example/${file}`]) };
    expect(resolveModule(row)).toEqual(refusal("missing-file"));
    if (file === "target")
      expect(enumerateCanonicalModuleCandidates(row).candidates.filter(({ suffix }) => suffix === "")).toEqual([
        { path: "bounded-contexts/example/target", rule: "relative-target", suffix: "", canonicalSelection: false },
      ]);
    expect(MODULE_RESOLUTION_CANDIDATE_SUFFIXES).not.toContain(".tsx");
    expect(MODULE_RESOLUTION_CANDIDATE_SUFFIXES).not.toContain(".mjs");
    emit("canonical AC6 refusal", { file, result: resolveModule(row) });
  });

  it("AC7 exact-main pinned verdicts scanned = 31 / declared = 31", () => {
    expect(canonicalRows).toHaveLength(31);
    for (const row of canonicalRows) expect(resolveModule(row), `row ${row.id}`).toEqual(row.expected);
    expect(canonicalPartition(resolveModule)).toEqual(expectedPartition);
    emit("canonical AC7 scanned = 31 / declared = 31", canonicalPartition(resolveModule));
  });

  it("AC7 identity-boundary scanned = 52 / declared = 52", () => {
    expect(boundaryRows.map(({ id }) => id)).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
    for (const row of boundaryRows) {
      assertCanonicalRecord(enumerateCanonicalModuleCandidates(row), row);
      expect(resolveModule(row), `C${row.id}`).toEqual(row.expected);
    }
    emit("canonical AC7 identity-boundary scanned = 52 / declared = 52", { matched: 52 });
  });

  it("AC8 one rule and distinct paths across both matrices", () => {
    let maximum = 0;
    for (const row of [...canonicalRows, ...boundaryRows]) {
      const record = enumerateCanonicalModuleCandidates(row);
      assertSingleRule(record);
      assertDistinctPaths(record);
      maximum = Math.max(maximum, record.candidates.length);
    }
    expect(maximum).toBe(5);
    emit("canonical AC8 maximum candidate count", maximum);
  });

  it.each([21, 22, 23, 24, 25, 26, 27, 29])("AC9 workspace shape row %s", (index) => {
    const row = canonicalRows[index];
    const record = enumerateCanonicalModuleCandidates(row);
    assertCanonicalRecord(record, row);
    expect(resolveModule(row)).toEqual(row.expected);
    emit("canonical AC9 workspace", { specifier: row.specifierText, record, result: resolveModule(row) });
  });

  it.each([".\\inferred", ".hidden", ".", ".."])("AC10 canonical external and five raw rows: %s", (specifierText) => {
    const row = { ...canonicalRows[0], specifierText };
    expect(enumerateCanonicalModuleCandidates(row)).toEqual({
      canonicalState: "external",
      canonicalTarget: null,
      candidates: [],
    });
    expect(enumerateGuardImportCandidates(row).candidates).toHaveLength(5);
  });

  it("AC11 importer normalization stays canonical including outside-root importer", () => {
    for (const row of canonicalRows.slice(0, 4)) {
      expect(resolveModule(row)).toEqual(row.expected);
      emit("canonical AC11 importer", { importer: row.importerPath, result: resolveModule(row) });
    }
  });

  it("AC12 ESM filesystem denial is live for loader but enumeration and selection stay pure", () => {
    const child = canonicalPurity();
    expect(child.status, child.stderr).toBe(0);
    emit("canonical AC12 child", JSON.parse(child.stdout));
  });

  it("AC13 builder has exact runtime shapes, frozen values and declaration order", () => {
    const context = buildModuleResolutionContextFixture({
      files: ["./side\\peer.mts", "side/./peer.mts"],
      packages: canonicalPackages,
    });
    expect(Reflect.ownKeys(context)).toEqual(["workspacePackages", "existingPaths"]);
    expect(context.workspacePackages).toBeInstanceOf(Map);
    expect(context.existingPaths).toBeInstanceOf(Set);
    expect([...context.existingPaths]).toEqual(["side/peer.mts"]);
    expect([...context.workspacePackages.keys()]).toEqual(canonicalPackages.map(([name]) => name));
    for (const value of context.workspacePackages.values()) {
      expect(Reflect.ownKeys(value)).toEqual(["root", "exports"]);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("AC13 package declaration order decides ambiguous prefixes in both directions", () => {
    const packages = [
      ["@chase-sets/x", { root: "packages/outer", exports: { "./*": "./*.ts" } }],
      ["@chase-sets/x/y", { root: "packages/inner", exports: { "./*": "./*.ts" } }],
    ];
    const files = ["packages/outer/y/z.ts", "packages/inner/z.ts"];
    for (const [order, expected] of [
      [packages, files[0]],
      [[...packages].reverse(), files[1]],
    ]) {
      const context = buildModuleResolutionContextFixture({ files, packages: order });
      expect(
        resolveModule({ ...context, importerPath: "scratch/source.ts", specifierText: "@chase-sets/x/y/z" }),
      ).toEqual(hit(expected));
      emit("canonical AC13 prefix order", { names: [...context.workspacePackages.keys()], expected });
    }
    expect(resolveModule(canonicalRows[3])).toEqual(hit("packages/example-2/nested/inferred.ts"));
    expect(resolveModule(canonicalRows[28])).toEqual(hit("packages/example-2/src/deep.ts"));
  });

  it("eligibility sibling control uses different path syntax without fixture vocabulary", () => {
    const folder = ["odd-zone", "child"].join("/");
    const importerPath = [folder, "nested", "..", "entry.mts"].join("/");
    const specifierText = ["..", "child", "peer"].join("/");
    const context = {
      importerPath,
      specifierText,
      workspacePackages: new Map(),
      existingPaths: new Set([`${folder}/peer`]),
    };
    expect(resolveModule(context)).toEqual(refusal("missing-file"));
    context.existingPaths.add(`${folder}/peer.mts`);
    expect(resolveModule(context)).toEqual(hit(`${folder}/peer.mts`));
    const record = enumerateCanonicalModuleCandidates(context);
    expect(paths(record)).toContain(`${folder}/peer`);
    expect(record.candidates[0].canonicalSelection).toBe(false);
  });

  it("preserves shipped exports predicate for non-array objects and refusal shapes", () => {
    for (const exports of [Object.assign(new Date(0), { ".": "./peer.mts" }), Object.create({ ".": "./peer.mts" })]) {
      expect(
        resolveModule({
          importerPath: "entry.ts",
          specifierText: "@odd/kit",
          workspacePackages: new Map([["@odd/kit", { root: "odd-zone", exports }]]),
          existingPaths: new Set(["odd-zone/peer.mts"]),
        }),
      ).toEqual(hit("odd-zone/peer.mts"));
    }
    for (const exports of [null, false, "./peer.mts", [], { ".": { import: "./peer.mts" } }]) {
      expect(
        resolveModule({
          importerPath: "entry.ts",
          specifierText: "@odd/kit",
          workspacePackages: new Map([["@odd/kit", { root: "odd-zone", exports }]]),
          existingPaths: new Set(["odd-zone/peer.mts"]),
        }),
      ).toEqual(refusal("workspace-export-not-found"));
    }
  });
});

const mutationCases = [
  {
    name: "AC1 invented candidate rule",
    mutate: (source) => replaceOnce(source, "rule: branch.rule, suffix", 'rule: "invented", suffix'),
    check: (m) => assert.equal(m.enumerateGuardImportCandidates(input).candidates.length, 5),
    inspect: (m) => {
      assert.throws(() => m.enumerateGuardImportCandidates(input), /Unknown guard import candidate value/);
      return { refusedBeforeReturn: true };
    },
  },
  {
    name: "AC2 remove zero-emission branch",
    mutate: (source) => replaceOnce(source, '  { form: "no-emission" },\n', ""),
    check: (m) =>
      assert.equal(
        m.enumerateGuardImportCandidates({ ...input, specifierText: "node:fs" }).specifierForm,
        "no-emission",
      ),
    inspect: (m) => {
      const result = m.enumerateGuardImportCandidates({ ...input, specifierText: "node:fs" });
      assert.deepEqual(result, { specifierForm: "INDETERMINATE", candidates: [] });
      assert.ok(Object.isFrozen(result.candidates));
      assert.deepEqual(m.GUARD_IMPORT_SPECIFIER_FORMS, [
        "INDETERMINATE",
        "dot-prefixed-relative",
        "scoped-package-subpath",
      ]);
      return { result, forms: m.GUARD_IMPORT_SPECIFIER_FORMS };
    },
  },
  {
    name: "AC5 raw-string deduplication",
    mutate: (source) =>
      replaceOnce(
        source,
        "candidates: Object.freeze(candidates)",
        "candidates: Object.freeze(candidates.filter((candidate, index) => candidates.findIndex((other) => other.path === candidate.path) === index))",
      ),
    check: (m) =>
      assert.equal(
        m.buildGuardImportCandidates({ ...input, emissionTable: duplicateTable(m.GUARD_IMPORT_EMISSION_TABLE) })
          .candidates.length,
        6,
      ),
    inspect: (m) => {
      const moved = movedRows(m.enumerateGuardImportCandidates);
      assert.equal(moved.length, 0);
      const syntheticRows = m.buildGuardImportCandidates({
        ...input,
        emissionTable: duplicateTable(m.GUARD_IMPORT_EMISSION_TABLE),
      }).candidates.length;
      assert.equal(syntheticRows, 5);
      return { movedOracleRows: moved.length, syntheticRows };
    },
  },
  {
    name: "AC6 repository-path normalization policy",
    mutate: (source) =>
      replaceOnce(
        replaceOnce(source, "path.posix.dirname(importerPath)", "path.posix.dirname(normalizeRepoPath(importerPath))"),
        "path: `${resolved}${suffix}`",
        "path: normalizeRepoPath(`${resolved}${suffix}`)",
      ),
    check: (m) => assert.deepEqual(movedRows(m.enumerateGuardImportCandidates), []),
    inspect: (m) => {
      const backslashSpecifier = { ...input, specifierText: ".\\inferred" };
      const backslashImporter = { ...input, importerPath: "bounded-contexts\\example\\source.ts" };
      for (const row of [backslashSpecifier, backslashImporter]) {
        assert.throws(() =>
          assertSequence(paths(m.enumerateGuardImportCandidates(row)), paths(enumerateGuardImportCandidates(row))),
        );
      }
      const moved = movedRows(m.enumerateGuardImportCandidates);
      assert.ok(moved.length > 0);
      return { backslashControlsRejected: 2, moved };
    },
  },
  {
    name: "AC7 merge by normalized path",
    mutate: (source) =>
      replaceOnce(
        source,
        "candidates: Object.freeze(candidates)",
        "candidates: Object.freeze(candidates.filter((candidate, index) => candidates.findIndex((other) => normalizeRepoPath(other.path) === normalizeRepoPath(candidate.path)) === index))",
      ),
    check: (m) =>
      assert.equal(
        m.enumerateGuardImportCandidates({ ...input, specifierText: "@chase-sets/example/../../packages/example/x" })
          .candidates.length,
        24,
      ),
    inspect: (m) => {
      const merged = m.enumerateGuardImportCandidates({
        ...input,
        specifierText: "@chase-sets/example/../../packages/example/x",
      }).candidates.length;
      assert.equal(merged, 15);
      return { raw: 24, merged };
    },
  },
  {
    name: "AC9 uppercase package segment",
    mutate: (source) => replaceOnce(source, "([a-z0-9-]+)", "([a-zA-Z0-9-]+)"),
    check: (m) =>
      assert.equal(
        m.enumerateGuardImportCandidates({ ...input, specifierText: "@chase-sets/Example/bad" }).candidates.length,
        0,
      ),
    inspect: (m) => {
      const zeros = oracle.rows
        .filter((row) => row.candidates.length === 0)
        .map((row) => ({
          specifierText: row.specifierText,
          count: m.enumerateGuardImportCandidates(row).candidates.length,
        }));
      assert.equal(zeros.length, 6);
      assert.deepEqual(
        zeros.filter(({ count }) => count !== 0),
        [{ specifierText: "@chase-sets/Example/bad", count: 24 }],
      );
      return zeros;
    },
  },
  {
    name: "AC10 computed filesystem read evades literal grep",
    mutate: (source) =>
      replaceOnce(
        source,
        "  validateGuardEmissionTable(emissionTable);",
        '  ({ ["read" + "FileSync"]: readFileSync })["read" + "FileSync"]("synthetic-file");\n  validateGuardEmissionTable(emissionTable);',
      ),
    check: (_m, target) => {
      const child = runPurity(pathToFileURL(target).href);
      assert.equal(child.status, 0, child.stderr);
    },
    inspect: (_m, target, source) => {
      const body = source
        .split("export function buildGuardImportCandidates")[1]
        .split("export function enumerateGuardImportCandidates")[0];
      assert.equal(body.includes("existsSync"), false);
      const child = runPurity(pathToFileURL(target).href);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /DENIED:filesystem/);
      return { literalExistsSyncMatches: 0, childExit: child.status, denial: "DENIED:filesystem" };
    },
  },
];

function canonicalFlips(m) {
  return canonicalRows.flatMap((row) => {
    const actual = m.resolveModule(row);
    return JSON.stringify(actual) === JSON.stringify(row.expected)
      ? []
      : [
          {
            id: row.id,
            importer: row.importerPath,
            specifier: row.specifierText,
            before: row.expected,
            after: actual,
          },
        ];
  });
}
const canonicalCheck = (m) => assert.deepEqual(canonicalFlips(m), []);
function inspectFlips(ids, additional = () => ({})) {
  return (m) => {
    const flips = canonicalFlips(m);
    assert.deepEqual(
      flips.map(({ id }) => id),
      ids,
    );
    return { sharedFixture: flips, ...additional(m) };
  };
}
const eligibilityLine = (suffix, eligible = true) =>
  `    { targetForm: "other", suffix: ${JSON.stringify(suffix)}, canonicalSelection: ${eligible} },\n`;
function swapEligibility(source, a, b) {
  return replaceOnce(source, eligibilityLine(a) + eligibilityLine(b), eligibilityLine(b) + eligibilityLine(a));
}
const singletonTarget = { ...canonicalRows[8], existingPaths: new Set(["bounded-contexts/example/target"]) };
const canonicalMutationCases = [
  {
    name: "AC1 invented canonical rule",
    mutate: (source) => replaceOnce(source, "        rule,\n", '        rule: "invented",\n'),
    check: (m) => assertCanonicalRecord(m.enumerateCanonicalModuleCandidates(canonicalRows[0]), canonicalRows[0]),
    inspect: (m) => {
      assert.throws(() => m.enumerateCanonicalModuleCandidates(canonicalRows[0]), /Unknown canonical candidate value/);
      return { refusedBeforeReturn: true };
    },
  },
  {
    name: "AC2 removed external arm retains INDETERMINATE default",
    mutate: (source) =>
      replaceOnce(source, "    matches: ({ relative, workspaceSpecifier }) => !relative && !workspaceSpecifier,\n", ""),
    check: (m) => assertCanonicalRecord(m.enumerateCanonicalModuleCandidates(canonicalRows[30]), canonicalRows[30]),
    inspect: (m) => {
      const record = m.enumerateCanonicalModuleCandidates(canonicalRows[30]);
      assert.deepEqual(record, { canonicalState: "INDETERMINATE", canonicalTarget: null, candidates: [] });
      return { record };
    },
  },
  {
    name: "AC3 escaping branch incorrectly retains target",
    mutate: (source) =>
      replaceOnce(
        source,
        "canonicalTarget = branch.rules.length ? target : null;",
        'canonicalTarget = branch.rules.length || state === "path-escapes-repository" ? target : null;',
      ),
    check: (m) => assertCanonicalRecord(m.enumerateCanonicalModuleCandidates(canonicalRows[15]), canonicalRows[15]),
    inspect: (m) => {
      const record = m.enumerateCanonicalModuleCandidates(canonicalRows[15]);
      assert.throws(() => assert.equal(record.canonicalTarget, null));
      assert.throws(() => assert.equal(record.candidates.length, 0));
      return { targetAssertionRed: true, emptyCandidatesAssertionRed: true, record };
    },
  },
  {
    name: "AC4 delete other .mts eligibility",
    mutate: (source) => replaceOnce(source, eligibilityLine(".mts"), ""),
    check: canonicalCheck,
    inspect: inspectFlips([8, 11], (m) => {
      assert.deepEqual(m.resolveModule(canonicalRows[7]), hit("bounded-contexts/example/fi/index.ts"));
      assert.deepEqual(m.resolveModule(canonicalRows[10]), refusal("missing-file"));
      return { dualUnchanged: true };
    }),
  },
  {
    name: "AC5 swap file suffix order",
    mutate: (source) => swapEligibility(source, ".ts", ".mts"),
    check: canonicalCheck,
    inspect: inspectFlips([6], (m) => {
      assert.deepEqual(m.resolveModule(canonicalRows[5]), hit("bounded-contexts/example/dual.mts"));
      return { diAndFiUnchanged: true };
    }),
  },
  {
    name: "AC5 swap index suffix order",
    mutate: (source) => swapEligibility(source, "/index.ts", "/index.mts"),
    check: canonicalCheck,
    inspect: inspectFlips([7], (m) => {
      assert.deepEqual(m.resolveModule(canonicalRows[6]), hit("bounded-contexts/example/di/index.mts"));
      return { dualAndFiUnchanged: true };
    }),
  },
  {
    name: "AC6 promote empty other suffix",
    mutate: (source) => replaceOnce(source, eligibilityLine("", false), eligibilityLine("", true)),
    check: canonicalCheck,
    inspect: inspectFlips([9, 10], (m) => {
      assert.deepEqual(m.resolveModule(singletonTarget), hit("bounded-contexts/example/target"));
      return {
        separateContext: {
          specifier: "./target",
          files: [...singletonTarget.existingPaths],
          before: refusal("missing-file"),
          after: m.resolveModule(singletonTarget),
        },
      };
    }),
  },
  {
    name: "AC7 select all emitted rows rather than eligible rows",
    mutate: (source) =>
      replaceOnce(
        source,
        "candidate.canonicalSelection && existingPaths.has(candidate.path)",
        "existingPaths.has(candidate.path)",
      ),
    check: canonicalCheck,
    inspect: inspectFlips([9, 10], (m) => {
      assert.deepEqual(canonicalPartition(m.resolveModule), expectedPartition);
      return { unchangedPartition: canonicalPartition(m.resolveModule), absentUnchanged: true };
    }),
  },
  {
    name: "AC8 emit wildcard target alongside exact target",
    mutate: (source) =>
      replaceOnce(
        source,
        "  Object.freeze(candidates);",
        `  if (rule === "workspace-export-exact" && workspaceSpecifier?.subpath !== null) {
    const pkg = workspacePackages.get(workspaceSpecifier.packageName);
    const wildcard = pkg.exports["./*"];
    if (typeof wildcard === "string") {
      const secondTarget = normalizeRepoPath(path.posix.join(pkg.root, wildcard.replaceAll("*", workspaceSpecifier.subpath)));
      candidates.push(Object.freeze({ path: secondTarget, rule: "workspace-export-wildcard", suffix: "", canonicalSelection: true }));
    }
  }
  Object.freeze(candidates);`,
      ),
    check: (m) => {
      const record = m.enumerateCanonicalModuleCandidates(canonicalRows[21]);
      assertSingleRule(record);
      assertDistinctPaths(record);
    },
    inspect: (m) => {
      const record = m.enumerateCanonicalModuleCandidates(canonicalRows[21]);
      assert.throws(() => assertSingleRule(record));
      assert.throws(() => assertDistinctPaths(record));
      const rules = [...new Set(record.candidates.map(({ rule }) => rule))];
      assert.deepEqual(rules, ["workspace-export-exact", "workspace-export-wildcard"]);
      return { rules, duplicatePath: "packages/example/src/exact.ts", bothAssertionsRed: true };
    },
  },
  {
    name: "AC9 wildcard before exact export",
    mutate: (source) =>
      replaceOnce(
        source,
        '  if (typeof exactTarget === "string") return { target: exactTarget, rule: exactRule };',
        `  if (subpath !== null && typeof exportsMap["./*"] === "string") {
    return { target: exportsMap["./*"].replaceAll("*", subpath), rule: wildcardRule };
  }
  if (typeof exactTarget === "string") return { target: exactTarget, rule: exactRule };`,
      ),
    check: canonicalCheck,
    inspect: inspectFlips([22, 23], (m) => {
      for (const index of [21, 22]) assert.deepEqual(m.resolveModule(canonicalRows[index]), refusal("missing-file"));
      return { wildcardThingUnchanged: true };
    }),
  },
  {
    name: "AC10 canonical normalization leaks into raw channel",
    mutate: (source) =>
      replaceOnce(source, "path: `${resolved}${suffix}`", "path: normalizeRepoPath(`${resolved}${suffix}`)"),
    check: (m) => assert.deepEqual(movedRows(m.enumerateGuardImportCandidates), []),
    inspect: (m) => {
      const moved = movedRows(m.enumerateGuardImportCandidates);
      assert.ok(moved.length > 0);
      return { movedRawOracleRows: moved };
    },
  },
  {
    name: "AC11 remove canonical importer normalization",
    mutate: (source) =>
      replaceOnce(
        source,
        "const normalizedImporter = normalizeRepoPath(importerPath);",
        "const normalizedImporter = importerPath;",
      ),
    check: canonicalCheck,
    inspect: inspectFlips([2], (m) => {
      assert.deepEqual(m.resolveModule(canonicalRows[1]), refusal("missing-file"));
      return { plainDotPrefixedAndOutsideRootUnchanged: true };
    }),
  },
  {
    name: "AC12 computed property filesystem read defeats keyword grep",
    mutate: (source) =>
      'import * as computedFs from "node:fs";\n' +
      replaceOnce(
        source,
        "  const normalizedImporter = normalizeRepoPath(importerPath);",
        '  computedFs[["read", "File", "Sync"].join("")]("synthetic-root");\n  const normalizedImporter = normalizeRepoPath(importerPath);',
      ),
    check: (_m, target) => {
      const child = canonicalPurity(pathToFileURL(target).href);
      assert.equal(child.status, 0, child.stderr);
    },
    inspect: (_m, target, source) => {
      const body = source
        .split("export function enumerateCanonicalModuleCandidates")[1]
        .split("export function resolveModule")[0];
      assert.equal(body.includes("existsSync"), false);
      const child = canonicalPurity(pathToFileURL(target).href);
      assert.equal(child.status, 1);
      assert.match(child.stderr, /DENIED:filesystem/);
      return { literalExistsSyncMatches: 0, childExit: child.status, denial: "DENIED:filesystem" };
    },
  },
  {
    name: "AC13 builder returns object instead of Map",
    mutate: (source) =>
      replaceOnce(source, "workspacePackages: new Map(\n", "workspacePackages: Object.fromEntries(\n"),
    check: (m) =>
      assert.ok(
        m.buildModuleResolutionContextFixture({ files: canonicalFiles, packages: canonicalPackages })
          .workspacePackages instanceof Map,
      ),
    inspect: (m) => {
      const context = m.buildModuleResolutionContextFixture({ files: canonicalFiles, packages: canonicalPackages });
      assert.equal(context.workspacePackages.constructor, Object);
      return { actualType: "Object", expectedType: "Map" };
    },
  },
  ...[
    [
      "unknown suffix",
      "        suffix: entry.suffix,",
      '        suffix: "invented",',
      /Unknown canonical candidate value/,
    ],
    ["unknown state", "      canonicalState = state;", '      canonicalState = "invented";', /Unknown canonical state/],
  ].map(([name, before, after, error]) => ({
    name: `closed grammar sibling: ${name}`,
    mutate: (source) => replaceOnce(source, before, after),
    check: (m) => assertCanonicalRecord(m.enumerateCanonicalModuleCandidates(canonicalRows[0]), canonicalRows[0]),
    inspect: (m) => {
      assert.throws(() => m.enumerateCanonicalModuleCandidates(canonicalRows[0]), error);
      return { refusedBeforeReturn: true };
    },
  })),
];

describe("canonical isolated one-variable source mutants", () => {
  it.each(canonicalMutationCases)(
    "$name: green, red, byte-restored green",
    async ({ name, mutate, check, inspect }) => {
      const original = readFileSync(modulePath, "utf8");
      const temporary = mkdtempSync(path.join(tmpdir(), "canonical-module-mutant-"));
      const target = path.join(temporary, "module-resolution.mjs");
      const load = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      try {
        writeFileSync(target, original);
        check(await load(original), target);
        const changed = mutate(original);
        writeFileSync(target, changed);
        const mutant = await load(changed);
        assert.throws(() => check(mutant, target), "the original assertion must turn red");
        emit("CANONICAL_MUTANT_RED", { name, evidence: inspect(mutant, target, changed) });
        writeFileSync(target, original);
        check(await load(readFileSync(target, "utf8")), target);
        assert.equal(digest(readFileSync(target)), digest(original));
        assert.equal(digest(readFileSync(modulePath)), digest(original));
        emit("CANONICAL_MUTANT_RESTORED", { name, restoredFileSha256: digest(readFileSync(target)) });
      } finally {
        assert.equal(path.dirname(target), temporary);
        assert.ok(temporary.startsWith(path.join(tmpdir(), "canonical-module-mutant-")));
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
});

describe("isolated one-variable source mutants", () => {
  it.each(mutationCases)("$name: green, red, byte-restored green", async ({ name, mutate, check, inspect }) => {
    const original = readFileSync(modulePath, "utf8");
    const temporary = mkdtempSync(path.join(tmpdir(), "guard-import-mutant-"));
    const target = path.join(temporary, "module-resolution.mjs");
    const load = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    writeFileSync(target, original);
    try {
      check(await load(original), target);
      const changed = mutate(original);
      writeFileSync(target, changed);
      const mutant = await load(changed);
      let rejection;
      try {
        check(mutant, target);
      } catch (error) {
        rejection = error;
      }
      expect(rejection, "the named original assertion must turn red").toBeDefined();
      emit("MUTANT_RED", {
        name,
        rejection: rejection.message.split("\n")[0],
        evidence: inspect(mutant, target, changed),
      });
    } finally {
      writeFileSync(target, original);
    }
    try {
      check(await load(readFileSync(target, "utf8")), target);
      expect(digest(readFileSync(target))).toBe(digest(original));
      expect(digest(readFileSync(modulePath))).toBe(digest(original));
      emit("MUTANT_RESTORED", {
        name,
        restoredFileSha256: digest(readFileSync(target)),
        shippedFileSha256: digest(readFileSync(modulePath)),
      });
    } finally {
      assert.equal(path.dirname(target), temporary);
      assert.ok(temporary.startsWith(path.join(tmpdir(), "guard-import-mutant-")));
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
