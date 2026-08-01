import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseDoksIngressChartVersion } from "../doks-cluster-addons.mjs";
import {
  DOKS_INGRESS_CHART_ROOT,
  DOKS_INGRESS_CHART_YAML,
  classifyDoksIngressChartPath,
  compareDoksIngressSemverPrecedence,
  discoverDoksIngressChangedFiles,
  doksIngressExcludedChartFiles,
  parseDoksIngressSemver,
  scanDoksIngressChartSurface,
  validateDoksIngressChartVersion,
} from "./doks-ingress-chart-version.mjs";

const baseVersion = "0.1.0";
const baseChartSource = `apiVersion: v2\nname: chase-sets-doks-ingress\ndescription: fixture\ntype: application\nversion: ${baseVersion}\nappVersion: "0.1.0"\n`;
const deepTemplate = `${DOKS_INGRESS_CHART_ROOT}/templates/deep/nested/issuer.yaml`;
const clusterIssuerTemplate = `${DOKS_INGRESS_CHART_ROOT}/templates/cluster-issuer.yaml`;
const valuesPath = `${DOKS_INGRESS_CHART_ROOT}/values.yaml`;
const excludedPaths = [
  `${DOKS_INGRESS_CHART_ROOT}/README.md`,
  `${DOKS_INGRESS_CHART_ROOT}/ingress-nginx-values.yaml`,
  `${DOKS_INGRESS_CHART_ROOT}/cert-manager-values.yaml`,
  `${DOKS_INGRESS_CHART_ROOT}/argo-rollouts-values.yaml`,
];
const fixtureBaseFiles = [
  DOKS_INGRESS_CHART_YAML,
  valuesPath,
  `${DOKS_INGRESS_CHART_ROOT}/templates/_helpers.tpl`,
  clusterIssuerTemplate,
  `${DOKS_INGRESS_CHART_ROOT}/templates/preview-wildcard-certificate.yaml`,
  deepTemplate,
  ...excludedPaths,
].sort();
const createdRoots = [];

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function createRoot(prefix = "doks-ingress-chart-version-") {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdRoots.push(repoRoot);
  return repoRoot;
}

async function writeChartManifest(repoRoot, version = baseVersion, description = "fixture") {
  await mkdir(path.join(repoRoot, DOKS_INGRESS_CHART_ROOT), { recursive: true });
  await writeFile(
    path.join(repoRoot, DOKS_INGRESS_CHART_YAML),
    `apiVersion: v2\nname: chase-sets-doks-ingress\ndescription: ${description}\ntype: application\nversion: ${version}\nappVersion: "0.1.0"\n`,
    "utf8",
  );
}

async function createFixtureChart({ version = baseVersion } = {}) {
  const repoRoot = await createRoot();
  await writeChartManifest(repoRoot, version);
  await mkdir(path.join(repoRoot, DOKS_INGRESS_CHART_ROOT, "templates", "deep", "nested"), {
    recursive: true,
  });
  await writeFile(path.join(repoRoot, valuesPath), "clusterIssuers: {}\n", "utf8");
  await writeFile(
    path.join(repoRoot, DOKS_INGRESS_CHART_ROOT, "templates", "_helpers.tpl"),
    "{{/* helpers */}}\n",
    "utf8",
  );
  await writeFile(path.join(repoRoot, clusterIssuerTemplate), "kind: ClusterIssuer\n", "utf8");
  await writeFile(
    path.join(repoRoot, DOKS_INGRESS_CHART_ROOT, "templates", "preview-wildcard-certificate.yaml"),
    "kind: Certificate\n",
    "utf8",
  );
  await writeFile(path.join(repoRoot, deepTemplate), "kind: ConfigMap\n", "utf8");
  await writeFile(path.join(repoRoot, excludedPaths[0]), "operator notes\n", "utf8");
  await writeFile(path.join(repoRoot, excludedPaths[1]), "controller: {}\n", "utf8");
  await writeFile(path.join(repoRoot, excludedPaths[2]), "installCRDs: true\n", "utf8");
  await writeFile(path.join(repoRoot, excludedPaths[3]), "controller: {}\n", "utf8");
  return repoRoot;
}

function createRecordingGitSeam({
  worktree = "true\n",
  mergeBase = "base-sha\n",
  changedFiles = [],
  baseFiles = fixtureBaseFiles,
  chartSource = baseChartSource,
  failAt,
} = {}) {
  const calls = [];
  const execGit = (args) => {
    calls.push([...args]);
    if (args[0] === failAt) throw new Error(`${failAt} unavailable`);
    if (args[0] === "rev-parse") return worktree;
    if (args[0] === "merge-base") return mergeBase;
    if (args[0] === "diff") return changedFiles.length > 0 ? `${changedFiles.join("\0")}\0` : "";
    if (args[0] === "ls-tree") return `${baseFiles.join("\n")}\n`;
    if (args[0] === "show") return chartSource;
    throw new Error(`unexpected Git invocation: ${args.join(" ")}`);
  };
  return { calls, execGit };
}

function explicitEnvironment(changedFiles) {
  return { CHANGED_FILES_JSON: JSON.stringify(changedFiles) };
}

function violationText(result) {
  return result.violations.join("\n");
}

function captureThrownMessage(action) {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to throw");
}

function expectOnlyDiagnostic(message, wanted, unwanted) {
  expect(message).toContain(wanted);
  for (const diagnostic of unwanted) expect(message).not.toContain(diagnostic);
}

const semverGrammarAccepted = [
  ["0.1.1-0", "clause 9 numeric zero"],
  ["0.1.1-0.3.7", "clause 9 numeric identifiers"],
  ["0.1.1-alpha.1", "clause 9 mixed identifiers"],
  ["0.1.1-01a", "clause 9 alphanumeric leading zero"],
  ["0.1.1-x.7.z.92", "clause 9 dot-separated identifiers"],
  ["0.1.1+001", "clause 10 build numeric leading zero"],
  ["0.1.1-beta+exp.sha.5114f85", "clauses 9 and 10 prerelease plus build"],
];
const semverGrammarRejected = [
  ["0.1.1-01", "clause 9 prerelease numeric leading zero"],
  ["0.1.1-1.01", "clause 9 later prerelease numeric leading zero"],
  ["0.1.1-00", "clause 9 prerelease numeric leading zero"],
  ["0.1.02", "clause 2 core numeric leading zero"],
];
const precedencePairs = [
  ["1.0.0", "2.0.0", "clause 11.2 major"],
  ["2.0.0", "2.1.0", "clause 11.2 minor"],
  ["2.1.0", "2.1.1", "clause 11.2 patch"],
  ["1.0.0-alpha", "1.0.0", "clause 11.3 stable versus prerelease"],
  ["1.0.0-alpha", "1.0.0-alpha.1", "clause 11.4.4 field count"],
  ["1.0.0-alpha.1", "1.0.0-alpha.beta", "clause 11.4.3 identifier type"],
  ["1.0.0-alpha.beta", "1.0.0-beta", "clause 11.4.2 ASCII lexical"],
  ["1.0.0-beta", "1.0.0-beta.2", "clause 11.4.4 field count"],
  ["1.0.0-beta.2", "1.0.0-beta.11", "clause 11.4.1 numeric"],
  ["1.0.0-beta.11", "1.0.0-rc.1", "clause 11.4.2 ASCII lexical"],
  ["1.0.0-rc.1", "1.0.0", "clause 11.3 stable versus prerelease"],
  ["1.0.0-1", "1.0.0-alpha", "clause 11.4.3 first identifier type"],
  ["1.0.0-Beta", "1.0.0-alpha", "clause 11.4.2 ASCII case order"],
  ["0.1.1-alpha", "0.1.1-alpha.1", "clause 11.4.4 field count"],
  ["0.1.1-alpha.1", "0.1.1", "clause 11.3 stable versus prerelease"],
  ["9007199254740992.0.0", "9007199254740993.0.0", "clause 11.2 unbounded core"],
  ["1.0.0-9007199254740992", "1.0.0-9007199254740993", "clause 11.4.1 unbounded numeric"],
];
const equalPrecedencePairs = [
  ["1.2.3+build.2", "1.2.3+build.1", "clause 10 build neutrality"],
  ["1.2.3", "1.2.3+build.1", "clause 10 build neutrality"],
  ["0.1.1-alpha+a", "0.1.1-alpha+b", "clause 10 prerelease build neutrality"],
];

function compareDigits(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareSemverMutant(leftVersion, rightVersion, { reverseTypeOrder = false, numberCoercion = false } = {}) {
  const left = parseDoksIngressSemver(leftVersion);
  const right = parseDoksIngressSemver(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    const result = numberCoercion
      ? Math.sign(Number(left.core[index]) - Number(right.core[index]))
      : compareDigits(left.core[index], right.core[index]);
    if (result !== 0) return result;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length !== right.prerelease.length) return left.prerelease.length === 0 ? 1 : -1;
  } else {
    const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const leftIdentifier = left.prerelease[index];
      const rightIdentifier = right.prerelease[index];
      if (leftIdentifier === rightIdentifier) continue;
      const leftNumeric = /^\d+$/.test(leftIdentifier);
      const rightNumeric = /^\d+$/.test(rightIdentifier);
      if (leftNumeric && rightNumeric) {
        return numberCoercion
          ? Math.sign(Number(leftIdentifier) - Number(rightIdentifier))
          : compareDigits(leftIdentifier, rightIdentifier);
      }
      if (leftNumeric !== rightNumeric) {
        const numericFirst = leftNumeric ? -1 : 1;
        return reverseTypeOrder ? -numericFirst : numericFirst;
      }
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (left.prerelease.length !== right.prerelease.length) {
      return left.prerelease.length < right.prerelease.length ? -1 : 1;
    }
  }
  if (numberCoercion) {
    return left.build.join(".").localeCompare(right.build.join("."));
  }
  return 0;
}

afterAll(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("doks ingress chart version guard", () => {
  it("flags a deeply nested real-path template change through default Git discovery", async () => {
    const repoRoot = await createFixtureChart();
    git(repoRoot, ["init", "--initial-branch=main"]);
    git(repoRoot, ["config", "user.email", "test@example.com"]);
    git(repoRoot, ["config", "user.name", "Test"]);
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "base chart"]);
    git(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repoRoot, ["checkout", "-b", "guard-test"]);
    await writeFile(path.join(repoRoot, deepTemplate), "kind: Certificate\n", "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-m", "change nested template"]);

    const result = await validateDoksIngressChartVersion({ repoRoot, environment: {} });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toEqual([deepTemplate]);
    expect(violationText(result)).toContain(deepTemplate);
    expect(violationText(result)).toContain(baseVersion);
  });

  it("passes a deployment-affecting change with a strictly increasing version", async () => {
    const repoRoot = await createFixtureChart({ version: "0.1.1" });
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([deepTemplate, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expect(result.violations).toEqual([]);
    expect(result.passShape).toBe("version-increased");
  });

  it("rejects a decreased version with only the not-increasing diagnostic", async () => {
    const repoRoot = await createFixtureChart({ version: "0.0.9" });
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([deepTemplate, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_VERSION_NOT_INCREASING", [
      "DOKS_INGRESS_VERSION_UNCHANGED",
      "DOKS_INGRESS_VERSION_NON_SEMVER",
    ]);
  });

  it("rejects a build-metadata-only edit for precedence rather than grammar", async () => {
    const repoRoot = await createFixtureChart({ version: "0.1.0+001" });
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([deepTemplate, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_VERSION_NOT_INCREASING", [
      "DOKS_INGRESS_VERSION_UNCHANGED",
      "DOKS_INGRESS_VERSION_NON_SEMVER",
    ]);
  });

  it("rejects a non-SemVer value with only the grammar diagnostic", async () => {
    const repoRoot = await createFixtureChart({ version: "dev" });
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([deepTemplate, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_VERSION_NON_SEMVER", [
      "DOKS_INGRESS_VERSION_UNCHANGED",
      "DOKS_INGRESS_VERSION_NOT_INCREASING",
    ]);
  });

  it.each(excludedPaths)("passes excluded path %s only after reporting its reason", async (excludedPath) => {
    const repoRoot = await createFixtureChart();
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([excludedPath]),
      execGit,
    });

    expect(result.violations).toEqual([]);
    expect(result.passShape).toBe("all-excluded");
    expect(result.excludedChangedFiles).toEqual([
      { file: excludedPath, reason: doksIngressExcludedChartFiles.get(excludedPath) },
    ]);
    expect(result.surface.candidateCount).toBe(fixtureBaseFiles.length);
    expect(result.surface.scannedCount + result.surface.excluded.length).toBe(result.surface.candidateCount);
  });

  it("publishes the exact live chart-surface partition with honest counts", () => {
    const surface = scanDoksIngressChartSurface({ repoRoot: process.cwd() });

    expect(surface.candidateFiles).toEqual([
      `${DOKS_INGRESS_CHART_ROOT}/Chart.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/README.md`,
      `${DOKS_INGRESS_CHART_ROOT}/argo-rollouts-values.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/cert-manager-values.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/ingress-nginx-values.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/templates/_helpers.tpl`,
      `${DOKS_INGRESS_CHART_ROOT}/templates/cluster-issuer.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/templates/preview-wildcard-certificate.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/values.yaml`,
    ]);
    expect(surface).toMatchObject({ candidateCount: 9, scannedCount: 5, unclassified: [] });
    expect(surface.excluded).toHaveLength(4);
  });

  it("reads the base Chart.yaml only through the injected seam", async () => {
    const repoRoot = await createFixtureChart({ version: "9.9.9" });
    const { calls, execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([deepTemplate, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expect(result.baseVersion).toBe(parseDoksIngressChartVersion(baseChartSource));
    expect(result.currentVersion).toBe("9.9.9");
    expect(calls).toContainEqual(["show", `base-sha:${DOKS_INGRESS_CHART_YAML}`]);
  });

  it("uses one exact ordered Git argument vector sequence", async () => {
    const repoRoot = await createFixtureChart({ version: "0.1.1" });
    const { calls, execGit } = createRecordingGitSeam({ changedFiles: [deepTemplate, DOKS_INGRESS_CHART_YAML] });
    const result = await validateDoksIngressChartVersion({ repoRoot, environment: {}, execGit });

    expect(result.violations).toEqual([]);
    expect(calls).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["merge-base", "HEAD", "refs/remotes/origin/main"],
      ["diff", "--name-only", "-z", "--diff-filter=ACMRTD", "base-sha...HEAD", "--"],
      ["ls-tree", "-r", "--name-only", "base-sha", "--", DOKS_INGRESS_CHART_ROOT],
      ["show", `base-sha:${DOKS_INGRESS_CHART_YAML}`],
    ]);
  });

  it("contains exactly one execFileSync call in the default Git seam factory", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts/check-structure/doks-ingress-chart-version.mjs"),
      "utf8",
    );
    expect(source.match(/execFileSync\(/g)).toHaveLength(1);
  });

  it("distinguishes a failing worktree probe from merge-base failure in both environments", () => {
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const { execGit } = createRecordingGitSeam({ failAt: "rev-parse" });
      const message = captureThrownMessage(() =>
        discoverDoksIngressChangedFiles({ repoRoot: process.cwd(), environment, execGit }),
      );
      expectOnlyDiagnostic(message, "DOKS_INGRESS_NOT_A_GIT_WORKTREE", ["DOKS_INGRESS_MERGE_BASE_UNAVAILABLE"]);
    }
  });

  it("distinguishes a non-true worktree answer from merge-base failure in both environments", () => {
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const { execGit } = createRecordingGitSeam({ worktree: "false\n" });
      const message = captureThrownMessage(() =>
        discoverDoksIngressChangedFiles({ repoRoot: process.cwd(), environment, execGit }),
      );
      expectOnlyDiagnostic(message, "DOKS_INGRESS_NOT_A_GIT_WORKTREE", ["DOKS_INGRESS_MERGE_BASE_UNAVAILABLE"]);
    }
  });

  it("distinguishes a failing merge base from non-Git execution in both environments", () => {
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const { execGit } = createRecordingGitSeam({ failAt: "merge-base" });
      const message = captureThrownMessage(() =>
        discoverDoksIngressChangedFiles({ repoRoot: process.cwd(), environment, execGit }),
      );
      expectOnlyDiagnostic(message, "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE", ["DOKS_INGRESS_NOT_A_GIT_WORKTREE"]);
    }
  });

  it("distinguishes an empty merge base from non-Git execution in both environments", () => {
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const { execGit } = createRecordingGitSeam({ mergeBase: "" });
      const message = captureThrownMessage(() =>
        discoverDoksIngressChangedFiles({ repoRoot: process.cwd(), environment, execGit }),
      );
      expectOnlyDiagnostic(message, "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE", ["DOKS_INGRESS_NOT_A_GIT_WORKTREE"]);
    }
  });

  it("uses the real default seam outside Git and reports only the non-worktree diagnostic", async () => {
    const repoRoot = await createFixtureChart();
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const message = captureThrownMessage(() => discoverDoksIngressChangedFiles({ repoRoot, environment }));
      expectOnlyDiagnostic(message, "DOKS_INGRESS_NOT_A_GIT_WORKTREE", ["DOKS_INGRESS_MERGE_BASE_UNAVAILABLE"]);
    }
  });

  it("freezes every accepted and rejected SemVer grammar row from clauses 2, 9, and 10", () => {
    for (const [version] of semverGrammarAccepted) {
      expect(() => parseDoksIngressSemver(version)).not.toThrow();
    }
    for (const [version] of semverGrammarRejected) {
      expect(() => parseDoksIngressSemver(version)).toThrow("DOKS_INGRESS_VERSION_NON_SEMVER");
    }
  });

  it("freezes every SemVer clause-11 precedence branch and build neutrality", () => {
    for (const [lower, higher] of precedencePairs) {
      expect(compareDoksIngressSemverPrecedence(lower, higher)).toBeLessThan(0);
      expect(compareDoksIngressSemverPrecedence(higher, lower)).toBeGreaterThan(0);
    }
    for (const [left, right] of equalPrecedencePairs) {
      expect(compareDoksIngressSemverPrecedence(left, right)).toBe(0);
      expect(compareDoksIngressSemverPrecedence(right, left)).toBe(0);
    }
  });

  it("kills the Number-coercion and build-ordering comparator mutant", () => {
    for (const [version] of semverGrammarAccepted) expect(() => parseDoksIngressSemver(version)).not.toThrow();
    for (const [version] of semverGrammarRejected) {
      expect(() => parseDoksIngressSemver(version)).toThrow("DOKS_INGRESS_VERSION_NON_SEMVER");
    }

    const unboundedPairs = precedencePairs.filter(([, , clause]) => clause.includes("unbounded"));
    const boundedPairs = precedencePairs.filter(([, , clause]) => !clause.includes("unbounded"));
    for (const [lower, higher] of boundedPairs) {
      expect(compareSemverMutant(lower, higher, { numberCoercion: true })).toBeLessThan(0);
    }
    for (const [lower, higher] of unboundedPairs) {
      expect(compareSemverMutant(lower, higher, { numberCoercion: true })).not.toBeLessThan(0);
    }
    for (const [left, right] of equalPrecedencePairs) {
      expect(compareSemverMutant(left, right, { numberCoercion: true })).not.toBe(0);
    }
  });

  it("kills the reversed numeric-versus-nonnumeric identifier-type mutant", () => {
    for (const [version] of semverGrammarAccepted) expect(() => parseDoksIngressSemver(version)).not.toThrow();
    for (const [version] of semverGrammarRejected) {
      expect(() => parseDoksIngressSemver(version)).toThrow("DOKS_INGRESS_VERSION_NON_SEMVER");
    }
    const typeOrderPairs = precedencePairs.filter(([, , clause]) => clause.includes("11.4.3"));
    const otherPairs = precedencePairs.filter(([, , clause]) => !clause.includes("11.4.3"));
    for (const [lower, higher] of otherPairs) {
      expect(compareSemverMutant(lower, higher, { reverseTypeOrder: true })).toBeLessThan(0);
    }
    expect(typeOrderPairs).toHaveLength(2);
    for (const [lower, higher] of typeOrderPairs) {
      expect(compareSemverMutant(lower, higher, { reverseTypeOrder: true })).not.toBeLessThan(0);
    }
  });

  it("gives malformed explicit JSON precedence over a failing worktree probe", () => {
    const { calls, execGit } = createRecordingGitSeam({ failAt: "rev-parse" });
    const message = captureThrownMessage(() =>
      discoverDoksIngressChangedFiles({
        repoRoot: process.cwd(),
        environment: { CHANGED_FILES_JSON: "{" },
        execGit,
      }),
    );

    expectOnlyDiagnostic(message, "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID", ["DOKS_INGRESS_NOT_A_GIT_WORKTREE"]);
    expect(calls).toEqual([]);
  });

  it("fails closed with the diff diagnostic only when explicit input is absent", () => {
    const { execGit } = createRecordingGitSeam({ failAt: "diff" });
    const message = captureThrownMessage(() =>
      discoverDoksIngressChangedFiles({ repoRoot: process.cwd(), environment: {}, execGit }),
    );

    expectOnlyDiagnostic(message, "DOKS_INGRESS_DIFF_UNAVAILABLE", [
      "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID",
      "DOKS_INGRESS_BASE_CHART_UNREADABLE",
    ]);
  });

  it("fails a base Chart.yaml read through the named diagnostic in both environments", async () => {
    const repoRoot = await createFixtureChart();
    for (const environment of [{}, explicitEnvironment([deepTemplate])]) {
      const { execGit } = createRecordingGitSeam({ failAt: "show", changedFiles: [deepTemplate] });
      const result = await validateDoksIngressChartVersion({ repoRoot, environment, execGit });
      expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_BASE_CHART_UNREADABLE", [
        "DOKS_INGRESS_DIFF_UNAVAILABLE",
      ]);
    }
  });

  it("takes the empty fast pass only after a successfully derived empty diff", async () => {
    const repoRoot = await createFixtureChart();
    const { execGit } = createRecordingGitSeam({ changedFiles: [] });
    const result = await validateDoksIngressChartVersion({ repoRoot, environment: {}, execGit });

    expect(result.violations).toEqual([]);
    expect(result.passShape).toBe("empty-candidate-set");
    expect(result.changedChartFiles).toEqual([]);
  });

  it("takes the all-excluded pass only after classifying a nonempty candidate set", async () => {
    const repoRoot = await createFixtureChart();
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment(excludedPaths),
      execGit,
    });

    expect(result.violations).toEqual([]);
    expect(result.passShape).toBe("all-excluded");
    expect(result.changedChartFiles).toEqual(excludedPaths.slice().sort());
    expect(result.excludedChangedFiles).toHaveLength(4);
  });

  it("intentionally skips diff for CI-populated input while retaining every required Git read", async () => {
    const repoRoot = await createFixtureChart();
    const { calls, execGit } = createRecordingGitSeam({ failAt: "diff" });
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment(excludedPaths),
      execGit,
    });

    expect(result.violations).toEqual([]);
    expect(violationText(result)).not.toContain("DOKS_INGRESS_DIFF_UNAVAILABLE");
    expect(calls.some(([command]) => command === "diff")).toBe(false);
    expect(calls).toEqual([
      ["rev-parse", "--is-inside-work-tree"],
      ["merge-base", "HEAD", "refs/remotes/origin/main"],
      ["ls-tree", "-r", "--name-only", "base-sha", "--", DOKS_INGRESS_CHART_ROOT],
      ["show", `base-sha:${DOKS_INGRESS_CHART_YAML}`],
    ]);
  });

  it("flags deletion of the historical cluster-issuer template", async () => {
    const repoRoot = await createFixtureChart();
    await rm(path.join(repoRoot, clusterIssuerTemplate));
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([]),
      execGit,
    });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toContain(clusterIssuerTemplate);
  });

  it("flags a historical cluster-issuer template rename within templates", async () => {
    const repoRoot = await createFixtureChart();
    const renamedPath = `${DOKS_INGRESS_CHART_ROOT}/templates/cluster-issuer-renamed.yaml`;
    await rename(path.join(repoRoot, clusterIssuerTemplate), path.join(repoRoot, renamedPath));
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([renamedPath]),
      execGit,
    });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toEqual([clusterIssuerTemplate, renamedPath].sort());
  });

  it("flags a modified values.yaml", async () => {
    const repoRoot = await createFixtureChart();
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([valuesPath]),
      execGit,
    });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toEqual([valuesPath]);
  });

  it("flags deletion of values.yaml", async () => {
    const repoRoot = await createFixtureChart();
    await rm(path.join(repoRoot, valuesPath));
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([]),
      execGit,
    });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toContain(valuesPath);
  });

  it("flags a non-version Chart.yaml edit", async () => {
    const repoRoot = await createFixtureChart();
    await writeChartManifest(repoRoot, baseVersion, "changed description");
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expect(violationText(result)).toContain("DOKS_INGRESS_VERSION_UNCHANGED");
    expect(result.changedDeploymentAffectingFiles).toEqual([DOKS_INGRESS_CHART_YAML]);
  });

  it("distinguishes a deleted Chart.yaml from an unavailable chart surface", async () => {
    const repoRoot = await createFixtureChart();
    await rm(path.join(repoRoot, DOKS_INGRESS_CHART_YAML));
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_CHART_MANIFEST_MISSING", [
      "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
    ]);
  });

  it("kills the classifier mutant that silently drops both values.yaml shapes", () => {
    const narrowMutant = (file) =>
      file === DOKS_INGRESS_CHART_YAML || file.startsWith(`${DOKS_INGRESS_CHART_ROOT}/templates/`);
    const valuesCases = [
      { name: "modified values.yaml", file: valuesPath },
      { name: "deleted values.yaml", file: valuesPath },
    ];
    expect(valuesCases.map(({ file }) => narrowMutant(file))).toEqual([false, false]);
    expect(classifyDoksIngressChartPath(valuesPath).arm).toBe("deployment-affecting");
    expect(narrowMutant(DOKS_INGRESS_CHART_YAML)).toBe(true);
    expect(narrowMutant(clusterIssuerTemplate)).toBe(true);
  });

  it("fails closed when the current chart directory is absent", async () => {
    const repoRoot = await createRoot("doks-ingress-chart-absent-");
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE", [
      "DOKS_INGRESS_CHART_MANIFEST_MISSING",
    ]);
    expect(result.passShape).toBe("error");
  });

  it("fails closed when the current chart directory is empty", async () => {
    const repoRoot = await createRoot("doks-ingress-chart-empty-");
    await mkdir(path.join(repoRoot, DOKS_INGRESS_CHART_ROOT), { recursive: true });
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE", [
      "DOKS_INGRESS_CHART_MANIFEST_MISSING",
    ]);
    expect(result.passShape).toBe("error");
  });

  it("imports only the shared pure parser and never the disk-reading accessor", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts/check-structure/doks-ingress-chart-version.mjs"),
      "utf8",
    );

    expect(source).toContain('import { parseDoksIngressChartVersion } from "../doks-cluster-addons.mjs";');
    expect(source).not.toContain("readDoksIngressChartVersion");
  });

  it.each([
    `${DOKS_INGRESS_CHART_ROOT}/crds/example-crd.yaml`,
    `${DOKS_INGRESS_CHART_ROOT}/charts/subchart/Chart.yaml`,
    `${DOKS_INGRESS_CHART_ROOT}/values.schema.json`,
    `${DOKS_INGRESS_CHART_ROOT}/.helmignore`,
    `${DOKS_INGRESS_CHART_ROOT}/extra-manifest.yaml`,
  ])("fails closed for unclassified changed chart path %s", async (unclassifiedPath) => {
    const repoRoot = await createFixtureChart();
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([unclassifiedPath]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_UNCLASSIFIED_CHART_FILE", [
      "DOKS_INGRESS_VERSION_UNCHANGED",
    ]);
    expect(violationText(result)).toContain(unclassifiedPath);
    expect(result.passShape).toBe("error");
  });

  it("still fails an unclassified CRD path when the chart version increases", async () => {
    const repoRoot = await createFixtureChart({ version: "0.1.1" });
    const crdPath = `${DOKS_INGRESS_CHART_ROOT}/crds/example-crd.yaml`;
    const { execGit } = createRecordingGitSeam();
    const result = await validateDoksIngressChartVersion({
      repoRoot,
      environment: explicitEnvironment([crdPath, DOKS_INGRESS_CHART_YAML]),
      execGit,
    });

    expectOnlyDiagnostic(violationText(result), "DOKS_INGRESS_UNCLASSIFIED_CHART_FILE", [
      "DOKS_INGRESS_VERSION_UNCHANGED",
    ]);
  });

  it("kills the partition mutant whose default arm silently excludes unknown paths", () => {
    const knownCases = [
      [DOKS_INGRESS_CHART_YAML, "deployment-affecting"],
      [valuesPath, "deployment-affecting"],
      [clusterIssuerTemplate, "deployment-affecting"],
      [deepTemplate, "deployment-affecting"],
      [`${DOKS_INGRESS_CHART_ROOT}/templates/cluster-issuer-renamed.yaml`, "deployment-affecting"],
      ...excludedPaths.map((file) => [file, "excluded"]),
    ];
    const unknownCases = [
      `${DOKS_INGRESS_CHART_ROOT}/crds/example-crd.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/charts/subchart/Chart.yaml`,
      `${DOKS_INGRESS_CHART_ROOT}/values.schema.json`,
      `${DOKS_INGRESS_CHART_ROOT}/.helmignore`,
      `${DOKS_INGRESS_CHART_ROOT}/extra-manifest.yaml`,
    ];
    const mutant = (file) => {
      const classification = classifyDoksIngressChartPath(file);
      return classification.arm === "unclassified" ? { ...classification, arm: "excluded" } : classification;
    };

    for (const [file, expectedArm] of knownCases) expect(mutant(file).arm).toBe(expectedArm);
    expect(unknownCases.map((file) => mutant(file).arm)).toEqual(Array(5).fill("excluded"));
    expect(unknownCases.map((file) => classifyDoksIngressChartPath(file).arm)).toEqual(Array(5).fill("unclassified"));
  });

  it("protects the exclusion premise by rejecting template consumption through .Files", async () => {
    const templatesRoot = path.join(process.cwd(), DOKS_INGRESS_CHART_ROOT, "templates");
    const templateFiles = [];
    const visit = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(entryPath);
        else templateFiles.push(entryPath);
      }
    };
    await visit(templatesRoot);
    const consumers = [];
    for (const file of templateFiles) {
      if (readFileSync(file, "utf8").includes(".Files")) consumers.push(path.relative(process.cwd(), file));
    }

    expect(consumers, "template .Files consumption invalidates the named exclusion rationale").toEqual([]);
  });
});
