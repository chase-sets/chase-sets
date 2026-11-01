import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseVerifyStaticChain,
  selectVerifyStaticGuardTests,
  selectVerifyStaticLinks,
  verifyStaticGuardTestMapCompleteness,
  verifyStaticSurfaceMapCompleteness,
  VERIFY_STATIC_GUARD_TEST_SURFACES,
  VERIFY_STATIC_SCOPED_EXCLUSIONS,
} from "./verify-static-surfaces.mjs";
import { classifyChanges } from "./change-scope.mjs";
import { repoRoot } from "./lib/repo.mjs";

function packageJson() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
}

function currentChain() {
  return parseVerifyStaticChain(packageJson());
}

function noFanoutDependencies() {
  return {
    listWorkspacePackages: () => [{ name: "@fixture/one" }, { name: "@fixture/two" }],
    classifyChanges: (...args) => {
      void classifyChanges;
      void args;
      return { affectedWorkspaces: [] };
    },
  };
}

describe("verify:static surface-map and selector contracts", () => {
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
});

it("keeps hosted verify:static unchanged and removes the scoped package alias", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
  expect(workflow).toContain("pnpm run verify:static");
  expect(workflow).not.toContain("pnpm run verify:static:scoped");
  expect(packageJson().scripts["verify:static:scoped"]).toBeUndefined();
  expect(existsSync(path.join(repoRoot, "scripts/verify-static-scoped.mjs"))).toBe(false);
});
