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
