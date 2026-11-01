import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALWAYS_RUN,
  MAY_NARROW,
  parseVerifyStaticChain,
  selectVerifyStaticGuardTests,
  selectVerifyStaticLinks,
  verifyStaticGuardTestMapCompleteness,
  verifyStaticSurfaceMapCompleteness,
  VERIFY_STATIC_GUARD_TEST_SURFACES,
  VERIFY_STATIC_SCOPED_EXCLUSIONS,
  VERIFY_STATIC_SURFACES,
} from "./verify-static-surfaces.mjs";
import { classifyChanges, parseNameStatusZ } from "./change-scope.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";

function packageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function currentChain() {
  return parseVerifyStaticChain(packageJson());
}

function noFanoutDependencies() {
  return {
    listWorkspacePackages: () => [{ name: "@fixture/one" }, { name: "@fixture/two" }],
    classifyChanges: () => ({ affectedWorkspaces: [] }),
  };
}

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function selectedNames(changedFiles, options = {}) {
  return selectVerifyStaticLinks({
    chain: currentChain(),
    changedFiles,
    repoRoot,
    dependencies: noFanoutDependencies(),
    ...options,
  }).selected.map(({ name }) => name);
}

function assertOnlyTestScriptsWasRemoved(basePlan, repairedPlan) {
  expect(repairedPlan.selected.map(({ name }) => name)).toEqual(
    basePlan.selected.map(({ name }) => name).filter((name) => name !== "test:scripts"),
  );
  expect(repairedPlan.skipped.map(({ link }) => link.name)).toEqual(
    basePlan.skipped.map(({ link }) => link.name).filter((name) => name !== "test:scripts"),
  );
  expect(repairedPlan.excluded.map(({ link }) => link.name)).toEqual(["test:scripts"]);
}

function execGit(rootDir, args) {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeFixture(rootDir, relativePath, source) {
  const absolutePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, "utf8");
}

describe("verify:static surface-map and selector contracts", () => {
  it("validates every real-map citation and fail-closes malformed classifications", () => {
    const chain = currentChain();
    expect(chain).toHaveLength(31);
    expect(verifyStaticSurfaceMapCompleteness(chain)).toEqual({ missing: [], extra: [], invalidMayNarrow: [] });
    for (const entry of Object.values(VERIFY_STATIC_SURFACES)) {
      expect(entry.rule).toBeTruthy();
      expect(entry.evidence.length).toBeGreaterThan(0);
      for (const citation of entry.evidence) {
        const match = /^([^:]+):(\d+)/.exec(citation);
        expect(match, citation).not.toBeNull();
        const lines = readFileSync(path.join(repoRoot, match[1]), "utf8").split(/\r?\n/).length;
        expect(lines, citation).toBeGreaterThanOrEqual(Number(match[2]));
      }
    }
    const malformedChain = [{ name: "check:uncertain", command: "pnpm run check:uncertain" }];
    expect(
      selectVerifyStaticLinks({
        chain: malformedChain,
        changedFiles: ["docs/only-this.md"],
        repoRoot,
        surfaces: {
          "check:uncertain": { classification: "typo", rule: "invalid", evidence: ["fixture:1"] },
        },
        dependencies: noFanoutDependencies(),
      }).selected,
    ).toEqual(malformedChain);
  });

  it("rejects MAY_NARROW maps without non-empty includes and selects them fail-closed", () => {
    const chain = [
      { name: "check:missing-include", command: "pnpm run check:missing-include" },
      { name: "check:empty-include", command: "pnpm run check:empty-include" },
    ];
    const surfaces = {
      "check:missing-include": { classification: MAY_NARROW, rule: "invalid", evidence: ["fixture:1"] },
      "check:empty-include": { classification: MAY_NARROW, rule: "invalid", evidence: ["fixture:2"], include: [] },
    };
    expect(verifyStaticSurfaceMapCompleteness(chain, surfaces).invalidMayNarrow).toEqual([
      "check:missing-include",
      "check:empty-include",
    ]);
    expect(
      selectVerifyStaticLinks({
        chain,
        changedFiles: ["docs/only-this.md"],
        surfaces,
        dependencies: noFanoutDependencies(),
      }).selected,
    ).toEqual(chain);
  });

  it("matches every hosted verify:static link and excludes only the scripts battery", () => {
    const chain = currentChain();
    expect(verifyStaticSurfaceMapCompleteness(chain)).toEqual({ missing: [], extra: [], invalidMayNarrow: [] });
    const plan = selectVerifyStaticLinks({
      chain,
      changedFiles: ["docs/readme.md"],
      repoRoot,
      dependencies: noFanoutDependencies(),
    });
    expect(plan.excluded.map(({ link }) => link.name)).toEqual(["test:scripts"]);
    expect(plan.excluded[0].rule).toBe(VERIFY_STATIC_SCOPED_EXCLUSIONS["test:scripts"]);
  });

  it("fails closed when a chain link has no surface entry", () => {
    const chain = [
      ...currentChain(),
      { name: "check:future-static-link", command: "pnpm run check:future-static-link" },
    ];
    expect(verifyStaticSurfaceMapCompleteness(chain).missing).toEqual(["check:future-static-link"]);
    expect(
      selectVerifyStaticLinks({
        chain,
        changedFiles: ["docs/readme.md"],
        repoRoot,
        dependencies: noFanoutDependencies(),
      }).selected.map(({ name }) => name),
    ).toContain("check:future-static-link");
  });

  it.each([
    [
      "scripts/check-no-legacy-forms.mjs",
      "scripts/** changed (guard and tooling changes require the full static chain)",
    ],
    ["package.json", null],
  ])("selects the expected scope for %s", (changedFile, expectedReason) => {
    const plan = selectVerifyStaticLinks({
      chain: currentChain(),
      changedFiles: [changedFile],
      repoRoot,
      dependencies: noFanoutDependencies(),
    });
    if (expectedReason) expect(plan.fullReason).toBe(expectedReason);
    expect(plan.selected.map(({ name }) => name)).toContain("check:structure");
  });

  it("retains path-specific guards and changed script test siblings", () => {
    const guard = "scripts/check-structure/lost-update-write-guard.test.mjs";
    const sidecar =
      "bounded-contexts/pricing/features/market-estimates/read-model/queries.ts.lost-update-exceptions.json";
    expect(selectVerifyStaticGuardTests({ changedFiles: [sidecar] })).toContain(guard);
    expect(
      selectVerifyStaticGuardTests({
        changedFiles: ["scripts/synthetic-check.mjs"],
        surfaces: {},
        testFileExists: (file) => file === "scripts/synthetic-check.test.mjs",
      }),
    ).toEqual(["scripts/synthetic-check.test.mjs"]);
  });

  it("runs every guard on force-full and rejects missing targets", () => {
    const all = Object.keys(VERIFY_STATIC_GUARD_TEST_SURFACES).sort();
    expect(selectVerifyStaticGuardTests({ changedFiles: [], forceFull: true })).toEqual(all);
    const missing = "scripts/synthetic-missing-guard.test.mjs";
    const surfaces = { [missing]: VERIFY_STATIC_GUARD_TEST_SURFACES[all[0]] };
    expect(verifyStaticGuardTestMapCompleteness({ surfaces }).missingTestFiles).toEqual([missing]);
    expect(() => selectVerifyStaticGuardTests({ changedFiles: [], surfaces })).toThrow(
      expect.objectContaining({ code: "STATIC_SCOPE_GUARD_TEST_MAP_INVALID" }),
    );
  });

  it("kills narrowed-include mutants for repository-wide guards", () => {
    const guard = "scripts/check-structure/sql-execution-surface.test.mjs";
    const mutant = {
      ...VERIFY_STATIC_GUARD_TEST_SURFACES,
      [guard]: {
        ...VERIFY_STATIC_GUARD_TEST_SURFACES[guard],
        include: [{ kind: "prefix", value: "bounded-contexts" }],
      },
    };
    expect(
      selectVerifyStaticGuardTests({
        changedFiles: ["scripts/check-structure/sql-execution-surface.mjs"],
        surfaces: mutant,
      }),
    ).toContain(guard);
    expect(selectVerifyStaticGuardTests({ changedFiles: ["nebula/unrelated.bin"], surfaces: mutant })).not.toContain(
      guard,
    );
  });

  it("covers guard-map completeness, repository-wide rules, path normalization, and deleted tests", () => {
    const all = Object.keys(VERIFY_STATIC_GUARD_TEST_SURFACES).sort();
    expect(verifyStaticGuardTestMapCompleteness()).toEqual({
      missingTestFiles: [],
      invalidTargets: [],
      invalidInclude: [],
      invalidEvidence: [],
    });
    expect(selectVerifyStaticGuardTests({ changedFiles: [], forceFull: true })).toEqual(all);
    for (const file of [
      "scripts/check-structure/sql-execution-surface.test.mjs",
      "scripts/check-structure/brand-mark-representations.test.mjs",
      "scripts/ci-gate-plan.test.mjs",
      "scripts/check-structure/consent-authorization-sites.test.mjs",
      "scripts/check-structure/json-import-attributes.test.mjs",
    ])
      expect(VERIFY_STATIC_GUARD_TEST_SURFACES[file].include).toContainEqual({ kind: "any" });
    const missing = "scripts/synthetic-missing-guard.test.mjs";
    expect(
      verifyStaticGuardTestMapCompleteness({ surfaces: { [missing]: VERIFY_STATIC_GUARD_TEST_SURFACES[all[0]] } })
        .missingTestFiles,
    ).toEqual([missing]);
    expect(() =>
      selectVerifyStaticGuardTests({
        changedFiles: [],
        surfaces: { [missing]: VERIFY_STATIC_GUARD_TEST_SURFACES[all[0]] },
      }),
    ).toThrow(expect.objectContaining({ code: "STATIC_SCOPE_GUARD_TEST_MAP_INVALID" }));
    const files = new Set(["scripts/nested/foo.test.mjs", "scripts/changed.test.mjs"]);
    expect(
      selectVerifyStaticGuardTests({
        changedFiles: [
          "scripts\\nested\\foo.mjs",
          "scripts/changed.test.mjs",
          "scripts/nested/foo.test.mjs",
          "scripts/no-sibling.mjs",
        ],
        surfaces: {},
        testFileExists: (file) => files.has(file),
      }),
    ).toEqual([...files].sort());
    const rootDir = mkdtempSync(path.join(tmpdir(), "verify-static-deleted-test-"));
    temporaryDirectories.push(rootDir);
    writeFixture(rootDir, "scripts/impact.test.mjs", "");
    writeFixture(rootDir, "scripts/renamed.test.mjs", "");
    const changedFiles = parseNameStatusZ(
      "D\0scripts/deleted.test.mjs\0R100\0scripts/old.test.mjs\0scripts/renamed.test.mjs\0",
    );
    const selected = selectVerifyStaticGuardTests({
      repoRoot: rootDir,
      changedFiles,
      surfaces: {
        "scripts/impact.test.mjs": {
          rule: "synthetic",
          evidence: ["fixture:1"],
          include: [
            { kind: "exact", value: "scripts/deleted.test.mjs" },
            { kind: "exact", value: "scripts/old.test.mjs" },
          ],
        },
      },
    });
    expect(selected).toEqual(["scripts/impact.test.mjs", "scripts/renamed.test.mjs"]);
    expect(selected.every((file) => existsSync(path.join(rootDir, file)))).toBe(true);
  });

  it("kills guard narrowing, documentation exemption, empty-include, and missing-target mutants", () => {
    const brandGuard = "scripts/check-structure/brand-mark-representations.test.mjs";
    expect(selectVerifyStaticGuardTests({ changedFiles: ["docs/synthetic-brand-caller.md"] })).toContain(brandGuard);
    const narrowed = {
      ...VERIFY_STATIC_GUARD_TEST_SURFACES,
      [brandGuard]: {
        ...VERIFY_STATIC_GUARD_TEST_SURFACES[brandGuard],
        include: [{ kind: "prefix", value: "bounded-contexts" }],
      },
    };
    const representativeFiles = [
      "docs/synthetic-brand-caller.md",
      "deployables/marketplace/public/icons/icon.png",
      "pnpm-lock.yaml",
    ];
    const assertRepresentativeCoverage = (surfaces) => {
      for (const changedFile of representativeFiles) {
        expect(selectVerifyStaticGuardTests({ changedFiles: [changedFile], surfaces })).toContain(brandGuard);
      }
    };
    assertRepresentativeCoverage(VERIFY_STATIC_GUARD_TEST_SURFACES);
    expect(() => assertRepresentativeCoverage(narrowed)).toThrow();
    const empty = {
      ...VERIFY_STATIC_GUARD_TEST_SURFACES,
      [brandGuard]: { ...VERIFY_STATIC_GUARD_TEST_SURFACES[brandGuard], include: [] },
    };
    expect(verifyStaticGuardTestMapCompleteness({ surfaces: empty }).invalidInclude).toEqual([brandGuard]);
    expect(selectVerifyStaticGuardTests({ changedFiles: [], surfaces: empty })).toEqual(Object.keys(empty).sort());
    const invalid = {
      ...VERIFY_STATIC_GUARD_TEST_SURFACES,
      [brandGuard]: { ...VERIFY_STATIC_GUARD_TEST_SURFACES[brandGuard], include: [{ kind: "synthetic-invalid-rule" }] },
    };
    expect(
      selectVerifyStaticGuardTests({ changedFiles: ["docs/synthetic-brand-caller.md"], surfaces: invalid }),
    ).toContain(brandGuard);
    const documentationExemptionMutant = (changedFiles) =>
      changedFiles.every((file) => file.endsWith(".md")) ? [] : selectVerifyStaticGuardTests({ changedFiles });
    expect(() =>
      expect(documentationExemptionMutant(["docs/synthetic-brand-caller.md"])).toContain(brandGuard),
    ).toThrow();
  });
});

describe("retained selector soundness and scoped-step contracts", () => {
  it("preserves soundness corpus and forces full scope for scripts", () => {
    const alwaysRun = Object.entries(VERIFY_STATIC_SURFACES)
      .filter(([name, entry]) => name !== "test:scripts" && entry.classification === ALWAYS_RUN)
      .map(([name]) => name);
    const corpus = [
      [["bounded-contexts/catalog/features/items/ui/editor.tsx"], ["check:no-legacy-forms", "check:structure"]],
      [["contracts/new-surface/package.json"], ["check:package-export-targets", "check:structure"]],
      [["infrastructure/retired/cited-file.ts"], ["check:docs-path-claims"]],
      [
        ["packages/design-system/src/components/old.tsx", "nebula/renamed.tsx"],
        ["check:design-system-hoc-budget", "check:design-system-component-index"],
      ],
      [["contracts/localization/locales/en/discovery.ts"], ["check:structure"]],
      [
        [".github/workflows/platform-pr.yml"],
        ["check:github-actions-runtime", "check:workflow-canonical-artifacts", "check:managed-postgres-authority"],
      ],
      [["scripts/check-no-legacy-forms.mjs"], ["check:no-legacy-forms", "check:structure"]],
      [["packages/design-system/DESIGN_SYSTEM_HOC_BUDGET.json"], ["check:design-system-hoc-budget"]],
    ];
    for (const [paths, failures] of corpus) {
      const selected = selectedNames(paths);
      expect(selected).toEqual(expect.arrayContaining([...failures, ...alwaysRun]));
    }
    for (const changedPath of ["scripts/check-no-legacy-forms.mjs", "scripts/lib/files.mjs"]) {
      const plan = selectVerifyStaticLinks({
        chain: currentChain(),
        changedFiles: [changedPath],
        repoRoot,
        dependencies: noFanoutDependencies(),
      });
      expect(plan.selected).toEqual(currentChain().filter(({ name }) => name !== "test:scripts"));
      expect(plan.excluded.map(({ link }) => link.name)).toEqual(["test:scripts"]);
      expect(plan.fullReason).toContain("scripts/** changed");
    }
    const arbitrary = selectedNames(["nebula/alias/features/quiet-client.tsx"]);
    expect(arbitrary).toEqual(expect.arrayContaining(alwaysRun));
    expect(arbitrary).toContain("check:localization");
    expect(arbitrary).not.toContain("check:no-legacy-forms");
  });

  it("keeps command-plan boundary, both mutants, real classifier fanout, and step fail-closed behavior", () => {
    const options = {
      chain: currentChain(),
      changedFiles: ["docs/readme.md"],
      repoRoot,
      dependencies: noFanoutDependencies(),
    };
    const basePlan = selectVerifyStaticLinks({ ...options, scopedExclusions: {} });
    const repairedPlan = selectVerifyStaticLinks(options);
    assertOnlyTestScriptsWasRemoved(basePlan, repairedPlan);
    expect(() =>
      assertOnlyTestScriptsWasRemoved(basePlan, selectVerifyStaticLinks({ ...options, scopedExclusions: {} })),
    ).toThrow();
    const narrowedGuardMutant = selectVerifyStaticLinks({
      ...options,
      scopedExclusions: {},
      surfaces: {
        ...VERIFY_STATIC_SURFACES,
        "check:kb-reference-ratchet": {
          ...VERIFY_STATIC_SURFACES["check:kb-reference-ratchet"],
          classification: MAY_NARROW,
          include: [{ kind: "exact", value: "never-selected.fixture" }],
        },
      },
    });
    expect(() => assertOnlyTestScriptsWasRemoved(basePlan, narrowedGuardMutant)).toThrow();
    const fanout = selectVerifyStaticLinks({
      chain: currentChain(),
      changedFiles: ["package.json"],
      repoRoot,
      dependencies: { classifyChanges, listWorkspacePackages },
    });
    expect(fanout.fullReason).toContain("affected every workspace");
    expect(fanout.selected).toEqual(currentChain().filter(({ name }) => name !== "test:scripts"));
    const structure = VERIFY_STATIC_SURFACES["check:structure"];
    const stale = selectVerifyStaticLinks({
      ...options,
      surfaces: {
        ...VERIFY_STATIC_SURFACES,
        "check:structure": { ...structure, scopedSteps: structure.scopedSteps.slice(0, 1) },
      },
    });
    const staleLink = stale.selected.find(({ name }) => name === "check:structure");
    expect(staleLink.scopedStepsStale).toBe(true);
    expect(() =>
      selectVerifyStaticLinks({
        ...options,
        surfaces: { ...VERIFY_STATIC_SURFACES, "check:structure": { ...structure, scopedSteps: [] } },
      }),
    ).toThrow(expect.objectContaining({ code: "STATIC_SCOPE_STEPS_MAP_INVALID" }));
  });
});

it("keeps hosted verify:static unchanged and removes the scoped package alias", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
  expect(workflow).toContain("pnpm run verify:static");
  expect(workflow).not.toContain("pnpm run verify:static:scoped");
  expect(packageJson().scripts["verify:static:scoped"]).toBeUndefined();
  expect(existsSync(path.join(repoRoot, "scripts/verify-static-scoped.mjs"))).toBe(false);
});
