import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { enumerateGuardImportCandidates } from "./check-structure/module-resolution.mjs";
import { deriveGuardCandidateProvenance } from "./check-structure/guard-candidate-provenance.mjs";
import { listNonTestTypeScriptModules } from "./check-structure/sql-execution-surface.mjs";
import { enumerateTrackedRoots } from "./check-structure/authoritative-stream-read-classification.mjs";
import {
  RELEASE_QUALIFICATION_APPLICABILITY_KINDS,
  RELEASE_QUALIFICATION_APPLICABILITY_BINDINGS,
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
const classifierPath = path.join(repoRoot, "scripts", "release-qualification-scope.mjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const emit = (label, value) => process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
const git = (args) => execFileSync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true });

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
  const extraFiles = fixture.extraFiles ?? {};
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
      if (entry) {
        return ref === "base" ? (entry.baseContent ?? entry.content ?? null) : (entry.content ?? null);
      }
      return extraFiles[filePath] ?? null;
    },
    // When a fixture omits the field, the classifier collects references
    // itself from the fixture's readable files (extraFiles workflows and
    // package.json), exercising the real pnpm-run alias resolution.
    releaseWorkflowScriptReferences: fixture.releaseWorkflowScriptReferences
      ? new Set(fixture.releaseWorkflowScriptReferences)
      : undefined,
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

function neutralityError(code, clause) {
  throw Object.assign(new Error(code), { code, reachedClause: clause });
}

function treeMembers(read, aliases = new Map()) {
  let bytes;
  try {
    bytes = read();
  } catch {
    neutralityError("NEUTRALITY_TREE_UNREADABLE", "tree-read");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.at(-1) !== 0)
    neutralityError("NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree");
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    neutralityError("NEUTRALITY_INVALID_UTF8", "fatal-tree-decoder");
  }
  const names = decoded.slice(0, -1).split("\0");
  if (names.some((name) => !name)) neutralityError("NEUTRALITY_TREE_INCOMPLETE", "empty-tree-member");
  const members = [];
  for (const name of names) {
    const governed = listNonTestTypeScriptModules(repoRoot, { execGit: () => `${name}\0` });
    if (governed.length === 0) continue;
    const canonicalName = governed[0];
    const raw = Buffer.from(name, "utf8").toString("hex");
    if (aliases.has(canonicalName) && aliases.get(canonicalName) !== raw)
      neutralityError("NEUTRALITY_CANONICAL_ALIAS_COLLISION", "canonical-to-raw-one-to-one");
    aliases.set(canonicalName, raw);
    members.push({ canonicalName, raw });
  }
  const complete = listNonTestTypeScriptModules(repoRoot, { execGit: () => decoded });
  if (JSON.stringify(members.map((member) => member.canonicalName).sort()) !== JSON.stringify(complete))
    neutralityError("NEUTRALITY_MEMBER_BIJECTION_FAILED", "complete-raw-bijection");
  return members.sort((a, b) => (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
}

function compareTrees(base, candidate) {
  const aliases = new Map();
  const before = treeMembers(base, aliases);
  const after = treeMembers(candidate, aliases);
  if (JSON.stringify(before) !== JSON.stringify(after))
    neutralityError("NEUTRALITY_MEMBER_SET_CHANGED", "complete-raw-member-set");
  return after;
}

function refusal(run, code, reachedClause) {
  let caught;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, code).toMatchObject({ code, reachedClause });
  emit("AC11_REFUSAL", { code, reachedClause });
}

const tree = (...names) => Buffer.from(`${names.join("\0")}\0`);
const neutralityForkPoint = "406d9bf5d82cbee79fcc5b295c67aa7cc9f35bb9";
const neutralityLanding = "c08e1e4ec547dcbd70959874b48afd70931026cc";

function assertPinnedNeutrality(readGit = git) {
  for (const sha of [neutralityForkPoint, neutralityLanding]) {
    try {
      readGit(["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
      neutralityError("NEUTRALITY_PINNED_OBJECT_MISSING", "pinned-object-existence");
    }
  }
  let parentage;
  try {
    parentage = readGit(["rev-list", "--parents", "-n", "1", neutralityLanding]).toString("utf8").trim().split(/\s+/);
  } catch {
    neutralityError("NEUTRALITY_PINNED_PARENTAGE_MISMATCH", "pinned-parentage");
  }
  if (JSON.stringify(parentage) !== JSON.stringify([neutralityLanding, neutralityForkPoint]))
    neutralityError("NEUTRALITY_PINNED_PARENTAGE_MISMATCH", "pinned-parentage");
  const record = deriveGuardCandidateProvenance({
    env: { GITHUB_EVENT_NAME: "merge_group" },
    execGit: (args) =>
      args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? neutralityLanding : readGit(args),
    readEventPayload: () => ({ merge_group: { head_sha: neutralityLanding, base_sha: neutralityForkPoint } }),
  });
  expect(record.environment).toBe("merge-group");
  expect(record.roles).toMatchObject({
    landingCandidate: { sha: neutralityLanding, source: "merge-group-event-head" },
    baseTipAtAnalysis: { sha: neutralityForkPoint, source: "merge-group-event-base" },
    forkPoint: { sha: neutralityForkPoint, source: "git-merge-base" },
  });
  const read = (sha) => () => readGit(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
  const members = compareTrees(read(neutralityForkPoint), read(neutralityLanding));
  expect(members.length).toBeGreaterThan(0);
  emit("AC11_HISTORICAL_N1", { roles: record.roles, members: members.length });
}

describe("AC11 issue-owned raw membership comparator, historical replay only", () => {
  it("N1 injects recorded #8409 roles and compares complete immutable trees, not this candidate", () => {
    const treeReads = [];
    assertPinnedNeutrality((args) => {
      if (args[0] === "ls-tree") treeReads.push(args.at(-1));
      return git(args);
    });
    expect(treeReads).toEqual([neutralityForkPoint, neutralityLanding]);
  });

  it.each([
    ["N2 addition", tree("src/a.ts"), tree("src/a.ts", "src/b.ts")],
    ["N3 removal", tree("src/a.ts", "src/b.ts"), tree("src/a.ts")],
    ["N4 equal cardinality different membership", tree("src/a.ts"), tree("src/b.ts")],
  ])("%s refuses complete raw inequality", (_name, base, candidate) => {
    refusal(
      () =>
        compareTrees(
          () => base,
          () => candidate,
        ),
      "NEUTRALITY_MEMBER_SET_CHANGED",
      "complete-raw-member-set",
    );
    expect(
      compareTrees(
        () => base,
        () => base,
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ["empty", () => Buffer.alloc(0), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    ["short", () => Buffer.from("src/a.ts"), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    ["empty member", () => tree("src/a.ts", ""), "NEUTRALITY_TREE_INCOMPLETE", "empty-tree-member"],
    [
      "failed",
      () => {
        throw new Error("failed ls-tree");
      },
      "NEUTRALITY_TREE_UNREADABLE",
      "tree-read",
    ],
  ])("N5 refuses %s tree read", (_name, read, code, clause) => {
    refusal(() => treeMembers(read), code, clause);
  });

  it("N6 preserves raw case/Unicode identities, rejects invalid UTF-8 and same-tree aliases", () => {
    for (const names of [
      ["src/a\\b.ts", "src/a/b.ts"],
      ["src/./a.ts", "src/a.ts"],
    ]) {
      refusal(
        () => treeMembers(() => tree(...names)),
        "NEUTRALITY_CANONICAL_ALIAS_COLLISION",
        "canonical-to-raw-one-to-one",
      );
    }
    for (const invalid of ["7372632fff2e747300", "7372632ffe2e747300"]) {
      refusal(() => treeMembers(() => Buffer.from(invalid, "hex")), "NEUTRALITY_INVALID_UTF8", "fatal-tree-decoder");
    }
    const identities = tree("src/A.ts", "src/a.ts", "src/\u00e9.ts", "src/e\u0301.ts", "src/\ufeffa.ts");
    const members = compareTrees(
      () => identities,
      () => identities,
    );
    expect(members).toHaveLength(5);
    expect(new Set(members.map((member) => member.raw)).size).toBe(5);
    emit("AC11_N6_RAW_IDENTITIES", members);
  });

  it.each([
    [Buffer.from("7372632f615c622e747300", "hex"), Buffer.from("7372632f612f622e747300", "hex")],
    [tree("src/./a.ts"), tree("src/a.ts")],
  ])("N8 cross-tree aliases refuse while a canonical-only mutant wrongly passes", (base, candidate) => {
    refusal(
      () =>
        compareTrees(
          () => base,
          () => candidate,
        ),
      "NEUTRALITY_CANONICAL_ALIAS_COLLISION",
      "canonical-to-raw-one-to-one",
    );
    const canonicalOnly = (bytes) => listNonTestTypeScriptModules(repoRoot, { execGit: () => bytes.toString("utf8") });
    expect(canonicalOnly(base)).toEqual(canonicalOnly(candidate));
    emit("AC11_N8_CANONICAL_MUTANT_GREEN", { base: base.toString("hex"), candidate: candidate.toString("hex") });
  });

  it("N9 injected positives ignore push and a later TS-adding ambient tree; bare-call mutant refuses", () => {
    const later = "af90b2a092593c570e995bfb33bbc08e021ff711";
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    vi.stubEnv("GITHUB_SHA", later);
    try {
      assertPinnedNeutrality((args) =>
        args[0] === "rev-parse" && args[1] === "HEAD" ? Buffer.from(later) : git(args),
      );
      refusal(deriveGuardCandidateProvenance, "guard-provenance-environment-ambiguous", "environment-classification");
      const read = (sha) => () => git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]);
      refusal(
        () => compareTrees(read("ce038cd3bc769bd73856fac463d8372dd5920bf2"), read(later)),
        "NEUTRALITY_MEMBER_SET_CHANGED",
        "complete-raw-member-set",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([neutralityForkPoint, neutralityLanding])("N10 missing pin %s refuses before comparison", (missing) => {
    refusal(
      () =>
        assertPinnedNeutrality((args) => {
          if (args[0] === "cat-file" && args[2] === `${missing}^{commit}`) throw new Error("missing pin");
          expect(args[0]).toBe("cat-file");
          return git(args);
        }),
      "NEUTRALITY_PINNED_OBJECT_MISSING",
      "pinned-object-existence",
    );
  });

  it.each([
    "",
    neutralityLanding,
    `${neutralityLanding} ${neutralityForkPoint} ${neutralityForkPoint}`,
    `${neutralityForkPoint} ${neutralityLanding}`,
    null,
  ])("N10 incorrect or unreadable parentage %s refuses", (parentage) => {
    refusal(
      () =>
        assertPinnedNeutrality((args) => {
          if (args[0] === "rev-list") {
            if (parentage === null) throw new Error("unreadable parentage");
            return Buffer.from(parentage);
          }
          expect(args[0]).toBe("cat-file");
          return git(args);
        }),
      "NEUTRALITY_PINNED_PARENTAGE_MISMATCH",
      "pinned-parentage",
    );
  });

  it("both owned mjs paths are outside production roots", () => {
    const production = new Set(enumerateTrackedRoots(repoRoot));
    expect(production.has("scripts/release-qualification-scope.mjs")).toBe(false);
    expect(production.has("scripts/release-qualification-scope.test.mjs")).toBe(false);
  });
});

function extractImportCollector(source) {
  const start = source.indexOf("function collectResolvedImportCodes(");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 1;
  let end = open + 1;
  for (; end < source.length && depth !== 0; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
  }
  expect(depth).toBe(0);
  return source.slice(start, end);
}

function pureApplicability() {
  return {
    kind: "pure-module/v1",
    modules: [{ path: "src/a.ts", specifiers: [{ specifier: "./b", binding: "value" }] }],
  };
}

function freezeApplicability(value, except) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeApplicability(child, except);
    if (value !== except) Object.freeze(value);
  }
  return value;
}

function registryWithApplicability(applicability) {
  return {
    ...releaseQualificationScopeRegistry,
    reviewedNonPersistentSurfaces: Object.freeze([
      Object.freeze({ ...releaseQualificationScopeRegistry.reviewedNonPersistentSurfaces[0], applicability }),
      ...releaseQualificationScopeRegistry.reviewedNonPersistentSurfaces.slice(1),
    ]),
  };
}

const applicabilityLabel = "reviewedNonPersistentSurfaces[0].applicability";
const moduleLabel = `${applicabilityLabel}.modules[0]`;
const specifierLabel = `${moduleLabel}.specifiers[0]`;
const freezeRows = [
  ["applicability", (value) => value, applicabilityLabel],
  ["modules array", (value) => value.modules, `${applicabilityLabel}.modules`],
  ["module record", (value) => value.modules[0], moduleLabel],
  ["specifiers array", (value) => value.modules[0].specifiers, `${moduleLabel}.specifiers`],
  ["specifier record", (value) => value.modules[0].specifiers[0], specifierLabel],
];

describe("reviewed-ruling applicability schema", () => {
  it("AC1 preserves all four pre-edit ruling literals and only adds frozen grandfathering", () => {
    const rulings = releaseQualificationScopeRegistry.reviewedNonPersistentSurfaces;
    expect(
      rulings.map(({ pattern, expectedClass, rationale }) => ({ pattern: pattern.source, expectedClass, rationale })),
    ).toEqual([
      {
        pattern: "^scripts\\/browser-e2e-bootstrap-observation\\.mjs$",
        expectedClass: "not_applicable",
        rationale:
          "Browser e2e bootstrap observation records disposable local test processes and does not seed or mutate persistent environments.",
      },
      {
        pattern: "^deployables\\/[^/]+\\/e2e\\/",
        expectedClass: "not_applicable",
        rationale:
          "End-to-end test seed contracts run only inside disposable e2e environments; they never touch persistent staging or production.",
      },
      {
        pattern: "^bounded-contexts\\/(?!checkout\\/|ordering\\/|payments\\/|settlement\\/)[^/]+\\/index\\.ts$",
        expectedClass: "isolated",
        rationale:
          "Context module barrels import the seed module to compose the context contract; the seed processes themselves are the registered surfaces, and barrels are ordinary application composition. Money-context barrels stay persistent via the money-movement registry.",
      },
      {
        pattern: "^bounded-contexts\\/catalog\\/features\\/source-observations\\/ui\\/",
        expectedClass: "isolated",
        rationale:
          "Import-to-promotion admin UI renders the import workflow; the import mutations live under the registered source-observations api surface.",
      },
    ]);
    expect(Object.isFrozen(rulings)).toBe(true);
    for (const entry of rulings) {
      expect(Reflect.ownKeys(entry).sort()).toEqual(["applicability", "expectedClass", "pattern", "rationale"]);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.applicability).toEqual({ kind: "path-scope/v0" });
      expect(Object.isFrozen(entry.applicability)).toBe(true);
    }
    expect(validateReleaseQualificationScopeRegistry(releaseQualificationScopeRegistry)).toEqual([]);
  });

  it("AC2 pins the exact ordered frozen kind enum", () => {
    expect(RELEASE_QUALIFICATION_APPLICABILITY_KINDS).toEqual(["path-scope/v0", "pure-module/v1"]);
    expect(Object.isFrozen(RELEASE_QUALIFICATION_APPLICABILITY_KINDS)).toBe(true);
  });

  it("AC2 pins the exact ordered frozen binding vocabulary", () => {
    expect(RELEASE_QUALIFICATION_APPLICABILITY_BINDINGS).toEqual(["type-only", "value"]);
    expect(Object.isFrozen(RELEASE_QUALIFICATION_APPLICABILITY_BINDINGS)).toBe(true);
  });

  const withModule = (module) => ({ kind: "pure-module/v1", modules: [module] });
  const withSpecifier = (specifier) => withModule({ path: "src/a.ts", specifiers: [specifier] });
  const moduleKeysError = `${moduleLabel} must have exactly keys: path, specifiers.`;
  const specifierKeysError = `${specifierLabel} must have exactly keys: specifier, binding.`;
  const pathError = `${moduleLabel}.path must be a non-empty repository-relative path without backslashes, leading ./ or .. segments.`;
  const frozenModule = freezeApplicability(pureApplicability()).modules[0];
  const frozenSpecifier = frozenModule.specifiers[0];
  it.each([
    ["missing applicability", undefined, `${applicabilityLabel} must be an object.`],
    ["non-object applicability", "path-scope/v0", `${applicabilityLabel} must be an object.`],
    ["null applicability", null, `${applicabilityLabel} must be an object.`],
    ["array applicability", [], `${applicabilityLabel} must be an object.`],
    ["unknown kind", { kind: "unknown" }, `${applicabilityLabel}.kind must be one of: path-scope/v0, pure-module/v1.`],
    [
      "path-scope modules",
      { kind: "path-scope/v0", modules: [] },
      `${applicabilityLabel} must have exactly keys: kind.`,
    ],
    [
      "path-scope extra key",
      { kind: "path-scope/v0", extra: true },
      `${applicabilityLabel} must have exactly keys: kind.`,
    ],
    ["missing modules", { kind: "pure-module/v1" }, `${applicabilityLabel} must have exactly keys: kind, modules.`],
    [
      "pure-module extra key",
      { ...pureApplicability(), extra: true },
      `${applicabilityLabel} must have exactly keys: kind, modules.`,
    ],
    [
      "empty modules",
      { kind: "pure-module/v1", modules: [] },
      `${applicabilityLabel}.modules must be a non-empty array.`,
    ],
    [
      "non-array modules",
      { kind: "pure-module/v1", modules: {} },
      `${applicabilityLabel}.modules must be a non-empty array.`,
    ],
    [
      "modules array extra named key",
      { kind: "pure-module/v1", modules: Object.assign([frozenModule], { extra: true }) },
      `${applicabilityLabel}.modules must contain only indexed data elements.`,
    ],
    [
      "specifiers array extra named key",
      withModule({ path: "src/a.ts", specifiers: Object.assign([frozenSpecifier], { extra: true }) }),
      `${moduleLabel}.specifiers must contain only indexed data elements.`,
    ],
    [
      "modules array accessor element",
      { kind: "pure-module/v1", modules: Object.defineProperty([], "0", { get: () => frozenModule }) },
      `${applicabilityLabel}.modules must contain only indexed data elements.`,
    ],
    [
      "specifiers array accessor element",
      withModule({ path: "src/a.ts", specifiers: Object.defineProperty([], "0", { get: () => frozenSpecifier }) }),
      `${moduleLabel}.specifiers must contain only indexed data elements.`,
    ],
    ["missing path", withModule({ specifiers: [] }), moduleKeysError],
    ["missing specifiers", withModule({ path: "src/a.ts" }), moduleKeysError],
    ["module extra key", withModule({ path: "src/a.ts", specifiers: [], extra: true }), moduleKeysError],
    ...["", "/src/a.ts", "C:/src/a.ts", "C:src/a.ts", "src/../a.ts", "src\\a.ts", "./src/a.ts"].map((value) => [
      `invalid path ${JSON.stringify(value)}`,
      withModule({ path: value, specifiers: [] }),
      pathError,
    ]),
    [
      "non-array specifiers",
      withModule({ path: "src/a.ts", specifiers: {} }),
      `${moduleLabel}.specifiers must be an array.`,
    ],
    ["missing specifier", withSpecifier({ binding: "value" }), specifierKeysError],
    ["missing binding", withSpecifier({ specifier: "./b" }), specifierKeysError],
    ["specifier extra key", withSpecifier({ specifier: "./b", binding: "value", extra: true }), specifierKeysError],
    [
      "empty specifier",
      withSpecifier({ specifier: "", binding: "value" }),
      `${specifierLabel}.specifier must be a non-empty string.`,
    ],
    [
      "unknown binding",
      withSpecifier({ specifier: "./b", binding: "runtime" }),
      `${specifierLabel}.binding must be one of: type-only, value.`,
    ],
    [
      "symbol extra key",
      { kind: "path-scope/v0", [Symbol("extra")]: true },
      `${applicabilityLabel} must have exactly keys: kind.`,
    ],
  ])("AC3 recursively closes %s", (name, applicability, error) => {
    const registry = registryWithApplicability(freezeApplicability(applicability));
    if (name === "missing applicability") {
      const { applicability: _omitted, ...entry } = registry.reviewedNonPersistentSurfaces[0];
      registry.reviewedNonPersistentSurfaces = [Object.freeze(entry)];
    }
    expect(validateReleaseQualificationScopeRegistry(registry)).toEqual([error]);
    emit("AC3_SCHEMA_REFUSAL", { name, error });
  });

  it("AC3 refuses accessors and non-enumerable unknown own keys", () => {
    for (const get of [
      () => "path-scope/v0",
      () => {
        throw new Error("kind getter must not execute");
      },
    ]) {
      const accessor = Object.defineProperty({}, "kind", { get });
      const registry = registryWithApplicability(Object.freeze(accessor));
      expect(validateReleaseQualificationScopeRegistry(registry)).toEqual([
        `${applicabilityLabel} must contain only data properties.`,
      ]);
      const record = runFixture({ files: [{ path: "docs/test.md", status: "modified" }] }, { registry });
      expect(record.class).toBe("persistent_required");
      expect(record.reasonCodes).toEqual(["unreadable_metadata"]);
      expect(record.failClosed.trigger).toBe("unreadable_metadata");
    }
    const extra = Object.defineProperty({ kind: "path-scope/v0" }, "hidden", { value: true });
    expect(validateReleaseQualificationScopeRegistry(registryWithApplicability(Object.freeze(extra)))).toEqual([
      `${applicabilityLabel} must have exactly keys: kind.`,
    ]);
  });

  it("AC4 refuses duplicate module paths", () => {
    const value = pureApplicability();
    value.modules.push({ path: "src/a.ts", specifiers: [] });
    const errors = validateReleaseQualificationScopeRegistry(registryWithApplicability(freezeApplicability(value)));
    expect(errors).toEqual([`${applicabilityLabel}.modules[1].path must be unique within modules.`]);
    emit("AC4_DUPLICATE_MODULE", errors);
  });

  it("AC4 refuses duplicate specifiers including conflicting bindings", () => {
    const value = pureApplicability();
    value.modules[0].specifiers.push({ specifier: "./b", binding: "type-only" });
    const errors = validateReleaseQualificationScopeRegistry(registryWithApplicability(freezeApplicability(value)));
    expect(errors).toEqual([`${moduleLabel}.specifiers[1].specifier must be unique within its module.`]);
    emit("AC4_DUPLICATE_SPECIFIER", errors);
  });

  it("AC4 accepts valid plural modules and distinct specifiers, including empty leaves", () => {
    const value = pureApplicability();
    value.modules[0].specifiers.push({ specifier: "./types", binding: "type-only" });
    value.modules.push(
      { path: "src/b.ts", specifiers: [{ specifier: "./types", binding: "type-only" }] },
      { path: "src/types.ts", specifiers: [] },
    );
    expect(validateReleaseQualificationScopeRegistry(registryWithApplicability(freezeApplicability(value)))).toEqual(
      [],
    );
  });

  it.each(freezeRows)("AC5 requires a frozen %s with all other levels frozen", (name, select, label) => {
    const value = pureApplicability();
    const errors = validateReleaseQualificationScopeRegistry(
      registryWithApplicability(freezeApplicability(value, select(value))),
    );
    expect(errors).toEqual([`${label} must be frozen.`]);
    emit("AC5_FREEZE_REFUSAL", { name, errors });
  });

  it("AC6 strict and non-strict mutations preserve validated kind and nested binding", () => {
    const value = freezeApplicability(pureApplicability());
    const registry = registryWithApplicability(value);
    const kind = releaseQualificationScopeRegistry.reviewedNonPersistentSurfaces[0].applicability;
    const binding = value.modules[0].specifiers[0];
    const sloppy = Function("target", "key", "value", "target[key] = value;");
    for (const [target, key, replacement, original] of [
      [kind, "kind", "pure-module/v1", "path-scope/v0"],
      [binding, "binding", "type-only", "value"],
    ]) {
      expect(() => {
        target[key] = replacement;
      }).toThrow(TypeError);
      expect(target[key]).toBe(original);
      sloppy(target, key, replacement);
      expect(target[key]).toBe(original);
      expect(validateReleaseQualificationScopeRegistry(registry)).toEqual([]);
      expect(validateReleaseQualificationScopeRegistry(releaseQualificationScopeRegistry)).toEqual([]);
    }
  });

  it.each(["missing applicability", "unknown kind", "unfrozen nested specifier"])(
    "AC7 %s preserves exact fail-closed record and policy",
    (name) => {
      const value = pureApplicability();
      let registry = registryWithApplicability(
        name === "unknown kind"
          ? Object.freeze({ kind: "unknown" })
          : freezeApplicability(value, value.modules[0].specifiers[0]),
      );
      if (name === "missing applicability") {
        const { applicability: _omitted, ...entry } = registry.reviewedNonPersistentSurfaces[0];
        registry = { ...registry, reviewedNonPersistentSurfaces: [Object.freeze(entry)] };
      }
      const record = runFixture({ files: [{ path: "docs/test.md", status: "modified" }] }, { registry });
      expect(record.class).toBe("persistent_required");
      expect(record.reasonCodes).toEqual(["unreadable_metadata"]);
      expect(record.failClosed.trigger).toBe("unreadable_metadata");
      expect(record.policyVersion).toBe("release-qualification-scope/v1");
      expect(RELEASE_QUALIFICATION_SCOPE_POLICY_VERSION).toBe("release-qualification-scope/v1");
      expect(JSON.stringify(record)).not.toContain('"applicability":');
    },
  );
});

describe("applicability one-variable mutants with byte-exact restoration", () => {
  // Exact source anchors keep each mutant one-variable; update them with intentional source reformatting.
  it.each([
    ["third kind", '["path-scope/v0", "pure-module/v1"]', '["path-scope/v0", "pure-module/v1", "pure-module/v2"]'],
    ["third binding", '["type-only", "value"]', '["type-only", "value", "runtime"]'],
    [
      "dropped specifier freeze",
      "if (!Object.isFrozen(value))",
      'if (!label.includes(".specifiers[") && !Object.isFrozen(value))',
    ],
  ])("AC2/AC5 %s: green, discriminating mutant, restored green", async (name, before, after) => {
    const original = readFileSync(classifierPath, "utf8");
    expect(original.split(before)).toHaveLength(2);
    const isolated = original.replace(
      /from "(\.\/[^"]+)"/g,
      (_match, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
    );
    const directory = mkdtempSync(path.join(tmpdir(), "ruling-schema-"));
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    const target = path.join(directory, "scope.mjs");
    let revision = 0;
    const load = async (source) => {
      writeFileSync(target, source);
      return import(`${pathToFileURL(target).href}?revision=${revision++}`);
    };
    const check = (module) => {
      if (name === "third kind")
        expect(module.RELEASE_QUALIFICATION_APPLICABILITY_KINDS).toEqual(["path-scope/v0", "pure-module/v1"]);
      else if (name === "third binding")
        expect(module.RELEASE_QUALIFICATION_APPLICABILITY_BINDINGS).toEqual(["type-only", "value"]);
      else {
        for (const [, select, label] of freezeRows) {
          const value = pureApplicability();
          expect(
            module.validateReleaseQualificationScopeRegistry(
              registryWithApplicability(freezeApplicability(value, select(value))),
            ),
          ).toEqual([`${label} must be frozen.`]);
        }
      }
    };
    try {
      check(await load(isolated));
      const mutant = await load(isolated.replace(before, after));
      expect(() => check(mutant)).toThrow();
      if (name === "dropped specifier freeze") {
        for (const [row, select, label] of freezeRows) {
          const value = pureApplicability();
          const errors = mutant.validateReleaseQualificationScopeRegistry(
            registryWithApplicability(freezeApplicability(value, select(value))),
          );
          expect(errors).toEqual(row === "specifier record" ? [] : [`${label} must be frozen.`]);
          emit("AC5_MUTANT_ROW", { row, errors });
        }
      }
      emit("APPLICABILITY_MUTANT_RED", { name });
    } finally {
      try {
        check(await load(isolated));
        expect(hash(readFileSync(target))).toBe(hash(isolated));
        expect(hash(readFileSync(classifierPath))).toBe(hash(original));
        emit("APPLICABILITY_RESTORED", {
          name,
          isolatedSha256: hash(readFileSync(target)),
          sourceSha256: hash(readFileSync(classifierPath)),
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});

describe("advisory CLI exit polarity", () => {
  it("classification stays exit zero when fail-closed; usage stays exit one", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ruling-cli-"));
    expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
    const run = (args) =>
      spawnSync(process.execPath, [classifierPath, ...args], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
      });
    try {
      const classified = run(["classify", "--candidate", "a".repeat(40), "--git", path.join(directory, "missing-git")]);
      expect(classified.status, classified.stderr).toBe(0);
      const record = JSON.parse(classified.stdout);
      expect(record.class).toBe("persistent_required");
      expect(record.failClosed).not.toBeNull();
      expect(record.policyVersion).toBe("release-qualification-scope/v1");
      expect(record).not.toHaveProperty("applicability");
      expect(run([]).status).toBe(1);
      expect(run(["classify"]).status).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("classifies the shared authoritative seed-state primitive as persistence-sensitive", () => {
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: [
        {
          path: "infrastructure/bounded-context-runtime/seed-aggregate-state.ts",
          status: "modified",
        },
      ],
      readFileAt: realReadFileAt,
      releaseWorkflowScriptReferences,
      now: () => 1753100000000,
    });

    expect(record.class).toBe("persistent_required");
    expect(record.reasonCodes).toContain("seed_bootstrap_import_reconciliation");
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
    expect({ discovered: discovered.length, persistentCount, ruledCount }).toEqual({
      discovered: 152,
      persistentCount: 148,
      ruledCount: 4,
    });
  });

  it("AC8 compares every discovered path across two valid registries without emitted applicability", () => {
    const original = releaseQualificationScopeRegistry;
    const alternate = registryWithApplicability(Object.freeze({ kind: "path-scope/v0" }));
    alternate.reviewedNonPersistentSurfaces = Object.freeze([
      ...alternate.reviewedNonPersistentSurfaces,
      Object.freeze({
        pattern: /^synthetic-no-tracked-path$/,
        expectedClass: "isolated",
        rationale: "Synthetic schema-only control.",
        applicability: freezeApplicability(pureApplicability()),
      }),
    ]);
    expect(alternate.reviewedNonPersistentSurfaces[0].applicability).not.toBe(
      original.reviewedNonPersistentSurfaces[0].applicability,
    );
    expect(trackedFiles.some((file) => alternate.reviewedNonPersistentSurfaces.at(-1).pattern.test(file))).toBe(false);
    expect(validateReleaseQualificationScopeRegistry(original)).toEqual([]);
    expect(validateReleaseQualificationScopeRegistry(alternate)).toEqual([]);
    const classify = (registry) =>
      discovered.map((filePath) =>
        classifyReleaseQualificationScope({
          base: DUMMY_BASE,
          candidate: DUMMY_CANDIDATE,
          changedFiles: [{ path: filePath, status: "modified" }],
          registry,
          readFileAt: realReadFileAt,
          releaseWorkflowScriptReferences,
          now: () => 1753100000000,
        }),
      );
    const records = classify(original);
    expect(classify(alternate)).toEqual(records);
    expect(records.every((record) => record.failClosed === null)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('"applicability":');
    emit("AC8_VALID_REGISTRY_NEUTRALITY", { comparedPaths: discovered.length });
  });

  it("AC10 raw rewire has equal seed-pattern matches on every discovered specifier against immutable Git grammar", () => {
    const oracleCommit = "f78143573af96c636d97696b987a82990df23904";
    git(["cat-file", "-e", `${oracleCommit}^{commit}`]);
    const historical = extractImportCollector(
      git(["show", `${oracleCommit}:scripts/release-qualification-scope.mjs`]).toString("utf8"),
    );
    const currentSource = readFileSync(classifierPath, "utf8");
    const current = extractImportCollector(currentSource);
    expect(current).toContain("enumerateGuardImportCandidates({ importerPath: filePath, specifierText: match[1] })");
    expect(current).not.toMatch(/candidates\.push|path\.posix|packageMatch|mappedSubpath/);
    expect(currentSource).not.toMatch(/enumerateCanonicalModuleCandidates|MODULE_RESOLUTION_/);
    const patterns = releaseQualificationScopeRegistry.seedBootstrapImportReconciliationPatterns;
    const matches = (declaration, filePath, specifier) => {
      const matched = new Set();
      const collector = Function(
        "path",
        "enumerateGuardImportCandidates",
        "matchesAny",
        `return (${declaration});`,
      )(path, enumerateGuardImportCandidates, (candidate) => {
        for (const [index, pattern] of patterns.entries()) if (pattern.test(candidate)) matched.add(index);
        return false;
      });
      collector(
        filePath,
        `export { value } from "${specifier}"`,
        { registry: releaseQualificationScopeRegistry },
        new Set(),
      );
      return [...matched].sort((a, b) => a - b);
    };
    let specifiers = 0;
    for (const filePath of discovered) {
      for (const match of realReadFileAt("candidate", filePath).matchAll(
        /(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g,
      )) {
        expect(matches(current, filePath, match[1])).toEqual(matches(historical, filePath, match[1]));
        specifiers += 1;
      }
    }
    expect(specifiers).toBeGreaterThan(0);
    emit("AC10_RAW_DIFFERENTIAL", {
      comparedPaths: discovered.length,
      specifiers,
      historicalDeclarationSha256: hash(historical),
    });
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
  it("classifies provider credential vocabulary as a runtime library, not a live provider", () => {
    expect(releaseQualificationScopeRegistry.contracts["provider-credentials"]).toBe("runtime-library");
    const record = classifyReleaseQualificationScope({
      base: DUMMY_BASE,
      candidate: DUMMY_CANDIDATE,
      changedFiles: [{ path: "contracts/provider-credentials/index.ts", status: "modified" }],
      readFileAt: (_ref, filePath) => readFileSync(path.join(repoRoot, filePath), "utf8"),
      releaseWorkflowScriptReferences: new Set(),
      now: () => 1753100000000,
    });
    expect(record.class).toBe("isolated");
    expect(record.reasonCodes).toEqual(["application_runtime"]);
  });

  it("registers the extracted theme contract and appearance adapter as runtime libraries", () => {
    expect(releaseQualificationScopeRegistry.contracts["embedded-surface-theme"]).toBe("runtime-library");
    expect(releaseQualificationScopeRegistry.infrastructure["stripe-appearance"]).toBe("runtime-library");
  });

  it("classifies the managed Postgres authority action and a real consumer as persistent release surfaces", () => {
    const actionPath = ".github/actions/export-managed-postgres-authority/action.yml";
    const workflowPath = ".github/workflows/catalog-provider-refresh-watch.yml";
    const readFileAt = (ref, filePath) => {
      try {
        return readFileSync(path.join(repoRoot, filePath), "utf8");
      } catch {
        return null;
      }
    };

    expect(readFileAt("candidate", actionPath)).toContain("using: composite");
    expect(readFileAt("candidate", workflowPath)).toContain(
      "uses: ./.github/actions/export-managed-postgres-authority",
    );

    for (const filePath of [actionPath, workflowPath]) {
      const record = classifyReleaseQualificationScope({
        base: DUMMY_BASE,
        candidate: DUMMY_CANDIDATE,
        changedFiles: [{ path: filePath, status: "modified" }],
        readFileAt,
        releaseWorkflowScriptReferences: new Set(),
        now: () => 1753100000000,
      });

      expect(record.class).toBe("persistent_required");
      expect(record.reasonCodes).toEqual(["deployment_release_workflow"]);
    }
  });

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
    const contracts = [
      ...new Set(
        tracked.filter((filePath) => /^contracts\/[^/]+\//.test(filePath)).map((filePath) => filePath.split("/")[1]),
      ),
    ].sort();

    expect(workflows).toEqual(Object.keys(releaseQualificationScopeRegistry.workflows).sort());
    expect(actions).toEqual(Object.keys(releaseQualificationScopeRegistry.actions).sort());
    expect(deployables).toEqual(Object.keys(releaseQualificationScopeRegistry.deployables).sort());
    expect(infrastructure).toEqual(Object.keys(releaseQualificationScopeRegistry.infrastructure).sort());
    expect(contracts).toEqual(Object.keys(releaseQualificationScopeRegistry.contracts).sort());
    // eslint-disable-next-line no-console
    console.log(
      `registration drift: scanned ${workflows.length}/${workflows.length} workflows, ${actions.length}/${actions.length} actions, ${deployables.length}/${deployables.length} deployables, ${infrastructure.length}/${infrastructure.length} infrastructure roots, ${contracts.length}/${contracts.length} contracts — all registered`,
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

  it("resolves pnpm-run aliases from the candidate package.json, transitively", () => {
    const references = collectReleaseWorkflowScriptReferences({
      registry: releaseQualificationScopeRegistry,
      readFileAt: (ref, filePath) => {
        if (filePath === ".github/workflows/platform-production.yml") {
          return "run: pnpm run smoke:chained --record\n";
        }
        if (filePath === ".github/workflows/platform-coverage.yml") {
          return "run: pnpm run coverage:digest\n";
        }
        if (filePath === "package.json") {
          return JSON.stringify({
            scripts: {
              "smoke:chained": "pnpm run smoke:platform && pnpm run ops",
              "smoke:platform": "node ./scripts/platform-smoke.mjs",
              ops: "node ./scripts/ops.mjs",
              "coverage:digest": "node ./scripts/coverage-summary.mjs",
              "self:loop": "pnpm run self:loop",
            },
          });
        }
        return null;
      },
    });
    expect(references.has("scripts/platform-smoke.mjs")).toBe(true);
    expect(references.has("scripts/ops.mjs")).toBe(true);
    // Referenced only by a ci-category workflow: not release machinery.
    expect(references.has("scripts/coverage-summary.mjs")).toBe(false);
    // Self-referencing aliases terminate.
    expect(references.size).toBe(2);
  });

  it("collects real release-gate scripts reached via pnpm-run aliases in the working tree", () => {
    const references = collectReleaseWorkflowScriptReferences({
      registry: releaseQualificationScopeRegistry,
      readFileAt: (ref, filePath) => {
        try {
          return readFileSync(path.join(repoRoot, filePath), "utf8");
        } catch {
          return null;
        }
      },
    });
    // Probe 1x set from the max-scrutiny review: gate scripts release
    // workflows invoke only through root pnpm-run aliases.
    for (const scriptPath of [
      "scripts/platform-smoke.mjs",
      "scripts/stripe-money-smoke-test.mjs",
      "scripts/ops.mjs",
      "scripts/rollback-readiness.mjs",
      "scripts/staging-mixed-version-wake-drill.mjs",
      "scripts/platform-kubernetes-deployment.mjs",
    ]) {
      expect(references.has(scriptPath), `${scriptPath} must be release-referenced`).toBe(true);
    }
  });
});
