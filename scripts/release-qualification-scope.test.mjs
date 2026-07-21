import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION,
  RELEASE_QUALIFICATION_SCOPE_SCHEMA_VERSION,
  classifyReleaseQualificationScope,
  collectReleaseWorkflowScriptReferences,
  listChangedFilesWithStatus,
  releaseQualificationScopeRegistry,
  renderAdvisorySummary,
  validateReleaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(repoRoot, "scripts", "fixtures", "release-qualification-scope");

const DUMMY_BASE = Object.freeze({
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  treeSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
const DUMMY_CANDIDATE = Object.freeze({
  sha: "cccccccccccccccccccccccccccccccccccccccc",
  treeSha: "dddddddddddddddddddddddddddddddddddddddd",
});

function loadFixtures() {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ fileName: name, ...JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) }));
}

function runFixture(fixture, overrides = {}) {
  const fileMap = new Map(fixture.files.map((file) => [file.path, file]));
  return classifyReleaseQualificationScope({
    base: fixture.omitBase ? null : DUMMY_BASE,
    candidate: DUMMY_CANDIDATE,
    changedFiles: fixture.files.map(({ path: filePath, status, previousPath }) => ({
      path: filePath,
      status,
      previousPath,
    })),
    readFileAt: (ref, filePath) => {
      const entry = fileMap.get(filePath);
      if (!entry) {
        return null;
      }
      return ref === "base" ? (entry.baseContent ?? entry.content ?? null) : (entry.content ?? null);
    },
    releaseWorkflowScriptReferences: new Set(fixture.releaseWorkflowScriptReferences ?? []),
    requestedPolicyVersion: fixture.requestedPolicyVersion ?? null,
    now: () => 1753100000000,
    ...overrides,
  });
}

describe("release-qualification-scope fixture matrix", () => {
  const fixtures = loadFixtures();
  const totalFixtureFiles = readdirSync(fixturesDir).length;
  let scanned = 0;

  for (const fixture of fixtures) {
    it(`classifies ${fixture.name} as ${fixture.expectedClass}`, () => {
      const record = runFixture(fixture);
      scanned += 1;
      expect(record.schemaVersion).toBe(RELEASE_QUALIFICATION_SCOPE_SCHEMA_VERSION);
      expect(record.policyVersion).toBe(RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION);
      expect(record.class).toBe(fixture.expectedClass);
      expect(record.reasonCodes).toEqual([...fixture.expectedReasonCodes].sort());
      if (fixture.expectedFailClosedTrigger) {
        expect(record.failClosed?.trigger).toBe(fixture.expectedFailClosedTrigger);
      } else {
        expect(record.failClosed).toBeNull();
        expect(record.changedFileCount).toBe(fixture.files.length);
        expect(record.evaluatedFileCount).toBe(fixture.files.length);
        expect(record.files).toHaveLength(fixture.files.length);
      }
    });
  }

  it("scans the complete fixture matrix (scanned/total) through real directory discovery", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect(fixtures.length).toBe(totalFixtureFiles);
    expect(scanned).toBe(fixtures.length);
    // eslint-disable-next-line no-console
    console.log(`release-qualification-scope fixture matrix: scanned ${scanned}/${totalFixtureFiles} fixtures`);
  });

  it("proves renamed-copy catches and path-lookalike neutrality through discovered fixtures", () => {
    const renamedCopies = fixtures.filter((fixture) => fixture.proves?.includes("renamed_copy"));
    const lookalikes = fixtures.filter((fixture) => fixture.proves?.includes("path_lookalike"));
    expect(renamedCopies.length).toBeGreaterThanOrEqual(4);
    expect(lookalikes.length).toBeGreaterThanOrEqual(2);
    for (const fixture of renamedCopies) {
      expect(fixture.expectedClass).toBe("persistent_required");
    }
    for (const fixture of lookalikes) {
      expect(fixture.expectedClass).not.toBe("persistent_required");
    }
  });

  it("keeps long-lived compatibility fixtures distinct from a fresh empty database run", () => {
    const fresh = fixtures.find((fixture) => fixture.proves?.includes("fresh_database_create"));
    const longLived = fixtures.find((fixture) => fixture.proves?.includes("long_lived_upgrade"));
    expect(fresh).toBeDefined();
    expect(longLived).toBeDefined();
    const freshContent = fresh.files.map((file) => file.content ?? "").join("\n");
    const longLivedContent = longLived.files.map((file) => file.content ?? "").join("\n");
    expect(freshContent).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(freshContent).not.toMatch(/ALTER TABLE/);
    expect(longLivedContent).toMatch(/ALTER TABLE/);
    expect(runFixture(fresh).class).toBe("persistent_required");
    expect(runFixture(longLived).class).toBe("persistent_required");
  });

  it("remains byte-stable across a second reconciliation run", () => {
    for (const fixture of fixtures.filter((entry) => entry.proves?.includes("second_run_stability"))) {
      const first = runFixture(fixture);
      const second = runFixture(fixture);
      expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2));
    }
  });
});

describe("fail-closed negative controls", () => {
  const docsOnlyDiff = {
    name: "inline",
    files: [{ path: "docs/runbooks/release-notes.md", status: "modified" }],
  };

  it("fails closed when the registry metadata is malformed", () => {
    const record = runFixture(docsOnlyDiff, {
      registry: { ...releaseQualificationScopeRegistry, deployables: { "platform-api": "mystery-role" } },
    });
    expect(record.class).toBe("persistent_required");
    expect(record.failClosed?.trigger).toBe("unreadable_metadata");
  });

  it("reports every malformed registry entry at the boundary", () => {
    const errors = validateReleaseQualificationScopeRegistry({
      ...releaseQualificationScopeRegistry,
      policyVersion: "release-qualification-scope/v9",
      workflows: { "platform-production.yml": "not-a-category" },
      migrationSurfacePatterns: ["not-a-regexp"],
    });
    expect(errors.some((error) => error.includes("policyVersion"))).toBe(true);
    expect(errors.some((error) => error.includes("workflows.platform-production.yml"))).toBe(true);
    expect(errors.some((error) => error.includes("migrationSurfacePatterns"))).toBe(true);
  });

  it("fails closed when the changed-file listing is unavailable", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: undefined,
      readFileAt: () => null,
    });
    expect(record.class).toBe("persistent_required");
    expect(record.failClosed?.trigger).toBe("unreadable_metadata");
  });

  it("fails closed per file when the reader throws", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: [{ path: "bounded-contexts/auth/features/sign-in/api/route.ts", status: "modified" }],
      readFileAt: () => {
        throw new Error("read denied");
      },
      releaseWorkflowScriptReferences: new Set(),
    });
    expect(record.class).toBe("persistent_required");
    expect(record.reasonCodes).toEqual(["unreadable_file"]);
  });

  it("fails closed when the classifier itself throws", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: [{ path: "bounded-contexts/auth/features/sign-in/api/route.ts", status: "modified" }],
      readFileAt: () => "export const ok = true;\n",
      releaseWorkflowScriptReferences: new Set(),
      // classifyChanges requires iterable workspace metadata; a corrupt value
      // must surface as classifier_error → persistent_required, never a crash.
      workspaces: 42,
    });
    expect(record.class).toBe("persistent_required");
    expect(record.failClosed?.trigger).toBe("classifier_error");
  });

  it("fails closed on unknown change statuses", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: [{ path: "docs/runbooks/release-notes.md", status: "unknown:X" }],
      readFileAt: () => null,
      releaseWorkflowScriptReferences: new Set(),
    });
    expect(record.class).toBe("persistent_required");
    expect(record.reasonCodes).toEqual(["unknown_change_status"]);
  });
});

describe("caller inventory (seed/bootstrap/import/reconciliation) — issue #5837 AC 2", () => {
  const trackedFiles = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replaceAll("\\", "/"));

  const excludedPattern =
    /\.(?:md|mdx)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__fixtures__|tests|test-support|fixtures)\//;
  const pathTokenPattern =
    /(?:^|[-_./])(?:seed|seeds|seeding|bootstrap|reconcile|reconciliation|backfill)(?=[-_./]|$)|import-to-promotion|representative-commerce|integration-reset/i;
  const seedImportPattern = /from\s+["'][^"']*(?:runtime-support\/seed|seed-support\/|\/seeding)["']/;

  const sweepRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "scripts"];
  const discovered = trackedFiles.filter((filePath) => {
    if (!sweepRoots.some((root) => filePath.startsWith(`${root}/`)) || excludedPattern.test(filePath)) {
      return false;
    }
    if (pathTokenPattern.test(filePath)) {
      return true;
    }
    if (/\.(?:ts|tsx|mjs)$/.test(filePath)) {
      try {
        return seedImportPattern.test(readFileSync(path.join(repoRoot, filePath), "utf8"));
      } catch {
        return false;
      }
    }
    return false;
  });

  const realReadFileAt = (ref, filePath) => {
    try {
      return readFileSync(path.join(repoRoot, filePath), "utf8");
    } catch {
      return null;
    }
  };
  const releaseWorkflowScriptReferences = collectReleaseWorkflowScriptReferences({
    registry: releaseQualificationScopeRegistry,
    readFileAt: realReadFileAt,
  });

  it("classifies every discovered caller persistent_required unless a reviewed ruling covers it", () => {
    expect(discovered.length).toBeGreaterThanOrEqual(40);
    const misses = [];
    let persistentCount = 0;
    let ruledCount = 0;
    for (const filePath of discovered) {
      const ruling = releaseQualificationScopeRegistry.reviewedNonPersistentSurfaces.find((entry) =>
        entry.pattern.test(filePath),
      );
      const expected = ruling?.expectedClass ?? "persistent_required";
      const record = classifyReleaseQualificationScope({
        base: DUMMY_BASE,
        candidate: DUMMY_CANDIDATE,
        changedFiles: [{ path: filePath, status: "modified" }],
        readFileAt: realReadFileAt,
        releaseWorkflowScriptReferences,
        now: () => 1753100000000,
      });
      // The fail-closed direction is always acceptable: a reviewed ruling
      // documents that a surface MAY classify below persistent_required, but a
      // stronger (persistent) result is never a miss. Only a surface drifting
      // BELOW its expectation — the false-isolated trip-wire — fails.
      if (record.class !== expected && record.class !== "persistent_required") {
        misses.push(`${filePath}: expected ${expected}, got ${record.class} (${record.reasonCodes.join(", ")})`);
      } else if (record.class === "persistent_required") {
        persistentCount += 1;
      } else {
        ruledCount += 1;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `caller inventory: discovered ${discovered.length} entry points; ${persistentCount} persistent_required, ${ruledCount} covered by reviewed rulings`,
    );
    expect(misses).toEqual([]);
  });

  it("re-runs the full inventory sweep stably (second reconciliation run)", () => {
    const classify = () =>
      discovered.map((filePath) =>
        JSON.stringify(
          classifyReleaseQualificationScope({
            base: DUMMY_BASE,
            candidate: DUMMY_CANDIDATE,
            changedFiles: [{ path: filePath, status: "modified" }],
            readFileAt: realReadFileAt,
            releaseWorkflowScriptReferences,
            now: () => 1753100000000,
          }),
        ),
      );
    expect(classify()).toEqual(classify());
  });
});

describe("registration contract drift (fail-closed registration)", () => {
  it("registers every workflow, action, deployable, and infrastructure directory", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter(Boolean);

    const workflows = [
      ...new Set(
        tracked
          .filter((filePath) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(filePath))
          .map((filePath) => filePath.split("/").at(-1)),
      ),
    ].sort();
    const actions = [
      ...new Set(
        tracked
          .filter((filePath) => /^\.github\/actions\/[^/]+\//.test(filePath))
          .map((filePath) => filePath.split("/")[2]),
      ),
    ].sort();
    const deployables = [
      ...new Set(
        tracked.filter((filePath) => /^deployables\/[^/]+\//.test(filePath)).map((filePath) => filePath.split("/")[1]),
      ),
    ].sort();
    const infrastructure = [
      ...new Set(
        tracked
          .filter((filePath) => /^infrastructure\/[^/]+\//.test(filePath))
          .map((filePath) => filePath.split("/")[1]),
      ),
    ].sort();

    expect(workflows).toEqual(Object.keys(releaseQualificationScopeRegistry.workflows).sort());
    expect(actions).toEqual(Object.keys(releaseQualificationScopeRegistry.actions).sort());
    expect(deployables).toEqual(Object.keys(releaseQualificationScopeRegistry.deployables).sort());
    expect(infrastructure).toEqual(Object.keys(releaseQualificationScopeRegistry.infrastructure).sort());
    // eslint-disable-next-line no-console
    console.log(
      `registration drift: scanned ${workflows.length}/${workflows.length} workflows, ${actions.length}/${actions.length} actions, ${deployables.length}/${deployables.length} deployables, ${infrastructure.length}/${infrastructure.length} infrastructure roots — all registered`,
    );
  });
});

describe("advisory summary rendering", () => {
  const baseRecordFixture = {
    name: "inline",
    files: [{ path: "docs/runbooks/release-notes.md", status: "modified" }],
  };

  it("renders all three classes", () => {
    const notApplicable = runFixture(baseRecordFixture);
    expect(renderAdvisorySummary(notApplicable)).toContain("Class: `not_applicable`");

    const isolated = runFixture({
      name: "inline",
      files: [{ path: "Dockerfile", status: "modified", content: "FROM node:24-alpine\n" }],
    });
    expect(renderAdvisorySummary(isolated)).toContain("Class: `isolated`");

    const persistent = runFixture({
      name: "inline",
      files: [{ path: "infrastructure/helm/platform/values.yaml", status: "modified", content: "replicaCount: 2\n" }],
    });
    const rendered = renderAdvisorySummary(persistent);
    expect(rendered).toContain("Class: `persistent_required`");
    expect(rendered).toContain("`helm_doks_ingress_dns_spaces`");
    expect(rendered).toContain("Changed files evaluated: 1 of 1 (untruncated)");
    expect(rendered).toContain("advisory only");
  });

  it("renders fail-closed errors", () => {
    const record = runFixture({ ...baseRecordFixture, omitBase: true });
    const rendered = renderAdvisorySummary(record);
    expect(rendered).toContain("Class: `persistent_required`");
    expect(rendered).toContain("Fail-closed trigger: `missing_base`");
  });

  it("records Actions minutes when a job start is provided", () => {
    const record = runFixture(baseRecordFixture, { jobStartedAt: new Date(1753100000000 - 90000).toISOString() });
    expect(record.actionsMinutes).toEqual({ elapsedSeconds: 90, billedEstimate: 2 });
    expect(renderAdvisorySummary(record)).toContain("billed estimate 2 minute(s)");
  });
});

describe("git plumbing", () => {
  it("parses name-status output including renames", () => {
    const exec = (command, args) => {
      if (args[0] === "merge-base") {
        return `${DUMMY_BASE.sha}\n`;
      }
      return "M\tdocs/runbooks/notes.md\nA\tscripts/new-tool.mjs\nD\tscripts/old-tool.mjs\nR094\tbounded-contexts/identity/support/runtime-support/seed.ts\tbounded-contexts/identity/support/runtime-support/scenario-data.ts\n";
    };
    const files = listChangedFilesWithStatus(DUMMY_BASE.sha, DUMMY_CANDIDATE.sha, { execFileSync: exec, cwd: "." });
    expect(files).toEqual([
      {
        path: "bounded-contexts/identity/support/runtime-support/scenario-data.ts",
        status: "renamed",
        previousPath: "bounded-contexts/identity/support/runtime-support/seed.ts",
      },
      { path: "docs/runbooks/notes.md", status: "modified" },
      { path: "scripts/new-tool.mjs", status: "added" },
      { path: "scripts/old-tool.mjs", status: "deleted" },
    ]);
  });

  it("collects scripts referenced by release workflows only", () => {
    const references = collectReleaseWorkflowScriptReferences({
      registry: releaseQualificationScopeRegistry,
      readFileAt: (ref, filePath) => {
        if (filePath === ".github/workflows/platform-production.yml") {
          return "run: node ./scripts/promoted-release.mjs verify\n";
        }
        if (filePath === ".github/workflows/platform-coverage.yml") {
          return "run: node ./scripts/coverage-summary.mjs\n";
        }
        return null;
      },
    });
    expect(references.has("scripts/promoted-release.mjs")).toBe(true);
    expect(references.has("scripts/coverage-summary.mjs")).toBe(false);
  });
});
