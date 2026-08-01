import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDoksIngressChartVersion } from "../doks-cluster-addons.mjs";

export const DOKS_INGRESS_CHART_ROOT = "infrastructure/helm/doks-ingress";
export const DOKS_INGRESS_CHART_YAML = `${DOKS_INGRESS_CHART_ROOT}/Chart.yaml`;
const chartValues = `${DOKS_INGRESS_CHART_ROOT}/values.yaml`;
const templatesRoot = `${DOKS_INGRESS_CHART_ROOT}/templates`;

export const doksIngressExcludedChartFiles = new Map([
  [`${DOKS_INGRESS_CHART_ROOT}/README.md`, "not consumed by any chart render input"],
  [
    `${DOKS_INGRESS_CHART_ROOT}/ingress-nginx-values.yaml`,
    "compared directly by the steady-state gate as the pinned ingress-nginx release's user-supplied values",
  ],
  [
    `${DOKS_INGRESS_CHART_ROOT}/cert-manager-values.yaml`,
    "compared directly by the steady-state gate as the pinned cert-manager release's user-supplied values",
  ],
  [
    `${DOKS_INGRESS_CHART_ROOT}/argo-rollouts-values.yaml`,
    "compared directly by the steady-state gate as the pinned argo-rollouts release's user-supplied values",
  ],
]);

export class DoksIngressChartVersionGuardError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "DoksIngressChartVersionGuardError";
    this.code = code;
  }
}

function guardError(code, message) {
  return new DoksIngressChartVersionGuardError(code, message);
}

function normalizeRepoPath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInsideChartRoot(file) {
  return file === DOKS_INGRESS_CHART_ROOT || file.startsWith(`${DOKS_INGRESS_CHART_ROOT}/`);
}

export function classifyDoksIngressChartPath(file) {
  const normalized = normalizeRepoPath(file);
  if (
    normalized === DOKS_INGRESS_CHART_YAML ||
    normalized === chartValues ||
    normalized.startsWith(`${templatesRoot}/`)
  ) {
    return { file: normalized, arm: "deployment-affecting" };
  }

  const exclusionReason = doksIngressExcludedChartFiles.get(normalized);
  if (exclusionReason) {
    return { file: normalized, arm: "excluded", reason: exclusionReason };
  }
  if (isInsideChartRoot(normalized)) {
    return { file: normalized, arm: "unclassified" };
  }
  return { file: normalized, arm: "outside-chart" };
}

function listFiles(root, relativeRoot = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const absolutePath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(absolutePath, relativePath) : [relativePath];
  });
}

export function scanDoksIngressChartSurface({ repoRoot } = {}) {
  const absoluteChartRoot = path.join(repoRoot, DOKS_INGRESS_CHART_ROOT);
  if (!existsSync(absoluteChartRoot)) {
    throw guardError(
      "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
      `${DOKS_INGRESS_CHART_ROOT} is absent; the guard refuses to certify an empty surface.`,
    );
  }

  const candidateFiles = listFiles(absoluteChartRoot)
    .map((file) => `${DOKS_INGRESS_CHART_ROOT}/${file}`)
    .sort();
  if (candidateFiles.length === 0) {
    throw guardError(
      "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
      `${DOKS_INGRESS_CHART_ROOT} contains no files; the guard refuses to certify an empty surface.`,
    );
  }

  const classifications = candidateFiles.map(classifyDoksIngressChartPath);
  return {
    candidateFiles,
    candidateCount: candidateFiles.length,
    scanned: classifications.filter(({ arm }) => arm === "deployment-affecting").map(({ file }) => file),
    scannedCount: classifications.filter(({ arm }) => arm === "deployment-affecting").length,
    excluded: classifications.filter(({ arm }) => arm === "excluded").map(({ file, reason }) => ({ file, reason })),
    unclassified: classifications.filter(({ arm }) => arm === "unclassified").map(({ file }) => file),
  };
}

function parseExplicitChangedFiles(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw guardError(
      "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID",
      "CHANGED_FILES_JSON must be valid JSON containing an array of non-empty file paths.",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((file) => typeof file !== "string" || file.trim().length === 0)) {
    throw guardError(
      "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID",
      "CHANGED_FILES_JSON must be a JSON array of non-empty file paths.",
    );
  }
  return parsed.map(normalizeRepoPath);
}

function defaultExecGit(args, repoRoot) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function execGitOrThrow(execGit, args, code, message) {
  try {
    return String(execGit(args));
  } catch {
    throw guardError(code, message);
  }
}

function parseNullSeparatedPaths(output) {
  return String(output).split("\0").filter(Boolean).map(normalizeRepoPath);
}

export function discoverDoksIngressChangedFiles({
  repoRoot,
  environment = process.env,
  execGit = (args) => defaultExecGit(args, repoRoot),
} = {}) {
  // Keep the same fail-closed stage order as scripts/format-check.mjs: explicit
  // input is parsed first, then Git identity, merge-base, and diff discovery.
  const hasExplicitInput =
    Object.hasOwn(environment, "CHANGED_FILES_JSON") && environment.CHANGED_FILES_JSON !== undefined;
  const explicitChangedFiles = hasExplicitInput ? parseExplicitChangedFiles(environment.CHANGED_FILES_JSON) : null;

  const insideWorkTree = execGitOrThrow(
    execGit,
    ["rev-parse", "--is-inside-work-tree"],
    "DOKS_INGRESS_NOT_A_GIT_WORKTREE",
    "could not confirm that the guard is running inside a Git worktree.",
  ).trim();
  if (insideWorkTree !== "true") {
    throw guardError("DOKS_INGRESS_NOT_A_GIT_WORKTREE", "the guard is not running inside a Git worktree.");
  }

  const mergeBase = execGitOrThrow(
    execGit,
    ["merge-base", "HEAD", "refs/remotes/origin/main"],
    "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
    "could not derive the merge base for HEAD and refs/remotes/origin/main.",
  ).trim();
  if (!mergeBase) {
    throw guardError(
      "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
      "the merge base for HEAD and refs/remotes/origin/main was empty.",
    );
  }

  if (explicitChangedFiles) {
    return { source: "CHANGED_FILES_JSON", changedFiles: explicitChangedFiles, mergeBase };
  }

  const changedFiles = parseNullSeparatedPaths(
    execGitOrThrow(
      execGit,
      ["diff", "--name-only", "-z", "--diff-filter=ACMRTD", `${mergeBase}...HEAD`, "--"],
      "DOKS_INGRESS_DIFF_UNAVAILABLE",
      "could not derive changed files from the merge-base diff.",
    ),
  );
  return { source: "git merge-base", changedFiles, mergeBase };
}

function readBaseChartSurface({ mergeBase, execGit }) {
  const output = execGitOrThrow(
    execGit,
    ["ls-tree", "-r", "--name-only", mergeBase, "--", DOKS_INGRESS_CHART_ROOT],
    "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
    "could not read the base chart surface.",
  );
  const files = output.split(/\r?\n/).filter(Boolean).map(normalizeRepoPath).sort();
  if (files.length === 0) {
    throw guardError("DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE", "the base chart surface was empty.");
  }
  return files;
}

function readBaseChartSource({ mergeBase, execGit }) {
  const source = execGitOrThrow(
    execGit,
    ["show", `${mergeBase}:${DOKS_INGRESS_CHART_YAML}`],
    "DOKS_INGRESS_BASE_CHART_UNREADABLE",
    "could not read the base Chart.yaml through Git.",
  );
  if (!source.trim()) {
    throw guardError("DOKS_INGRESS_BASE_CHART_UNREADABLE", "the base Chart.yaml was empty.");
  }
  return source;
}

// The grammar is derived from SemVer 2.0.0 clauses 9 and 10:
// https://semver.org/spec/v2.0.0.html.
const numericIdentifier = "(?:0|[1-9]\\d*)";
const alphanumericIdentifier = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${alphanumericIdentifier})`;
const strictSemverPattern = new RegExp(
  `^(${numericIdentifier})\\.(${numericIdentifier})\\.(${numericIdentifier})` +
    `(?:-(${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*))?` +
    "(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$",
);

export function parseDoksIngressSemver(version, label = "Chart.yaml") {
  const match = strictSemverPattern.exec(version);
  if (!match) {
    throw guardError(
      "DOKS_INGRESS_VERSION_NON_SEMVER",
      `${label} version ${JSON.stringify(version)} is not SemVer 2.0.0.`,
    );
  }
  return {
    core: match.slice(1, 4),
    prerelease: match[4]?.split(".") ?? [],
    build: match[5]?.split(".") ?? [],
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// This is the complete SemVer 2.0.0 clause-11 partition: core fields, stable
// versus prerelease, numeric and ASCII identifier order, identifier type, and
// equal-prefix field count. Build metadata is deliberately absent.
export function compareDoksIngressSemverPrecedence(leftVersion, rightVersion) {
  const left = parseDoksIngressSemver(leftVersion, "left Chart.yaml");
  const right = parseDoksIngressSemver(rightVersion, "right Chart.yaml");

  for (let index = 0; index < left.core.length; index += 1) {
    const result = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (result !== 0) return result;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;

    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

function diagnosticResult(error, partial = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code ?? "DOKS_INGRESS_CHART_VERSION_GUARD_FAILED";
  return {
    violations: [`${DOKS_INGRESS_CHART_ROOT}: ${code}: ${message.replace(`${code}: `, "")}`],
    passShape: "error",
    ...partial,
  };
}

function readCurrentChartSource(repoRoot) {
  const chartPath = path.join(repoRoot, DOKS_INGRESS_CHART_YAML);
  if (!existsSync(chartPath)) {
    throw guardError(
      "DOKS_INGRESS_CHART_MANIFEST_MISSING",
      `${DOKS_INGRESS_CHART_YAML} is missing from the current chart surface.`,
    );
  }
  try {
    return readFileSync(chartPath, "utf8");
  } catch {
    throw guardError("DOKS_INGRESS_CHART_VERSION_UNPARSABLE", `${DOKS_INGRESS_CHART_YAML} could not be read.`);
  }
}

export async function validateDoksIngressChartVersion({
  repoRoot,
  environment = process.env,
  execGit = (args) => defaultExecGit(args, repoRoot),
} = {}) {
  let discovery;
  let surface;
  let baseVersion;
  let currentVersion;
  let changedChartFiles = [];
  try {
    discovery = discoverDoksIngressChangedFiles({ repoRoot, environment, execGit });
    const baseChartFiles = readBaseChartSurface({ mergeBase: discovery.mergeBase, execGit });
    const baseChartSource = readBaseChartSource({ mergeBase: discovery.mergeBase, execGit });
    baseVersion = parseDoksIngressChartVersion(baseChartSource);

    surface = scanDoksIngressChartSurface({ repoRoot });
    const currentChartSource = readCurrentChartSource(repoRoot);
    currentVersion = parseDoksIngressChartVersion(currentChartSource);

    const currentFiles = new Set(surface.candidateFiles);
    changedChartFiles = [
      ...new Set([
        ...discovery.changedFiles.filter(isInsideChartRoot),
        ...baseChartFiles.filter((file) => !currentFiles.has(file)),
      ]),
    ].sort();
    const changedPathClassifications = changedChartFiles.map(classifyDoksIngressChartPath);
    const changedDeploymentAffectingFiles = changedPathClassifications
      .filter(({ arm }) => arm === "deployment-affecting")
      .map(({ file }) => file);
    const excludedChangedFiles = changedPathClassifications
      .filter(({ arm }) => arm === "excluded")
      .map(({ file, reason }) => ({ file, reason }));
    const unclassifiedChangedFiles = changedPathClassifications
      .filter(({ arm }) => arm === "unclassified")
      .map(({ file }) => file);
    const result = {
      violations: [],
      surface,
      discovery: {
        source: discovery.source,
        totalChangedFiles: discovery.changedFiles.length,
        mergeBase: discovery.mergeBase,
      },
      baseVersion,
      currentVersion,
      changedChartFiles,
      changedDeploymentAffectingFiles,
      excludedChangedFiles,
      unclassifiedChangedFiles,
    };

    if (unclassifiedChangedFiles.length > 0) {
      return {
        ...result,
        passShape: "error",
        violations: unclassifiedChangedFiles.map(
          (file) => `${file}: DOKS_INGRESS_UNCLASSIFIED_CHART_FILE: changed chart path has no declared partition arm.`,
        ),
      };
    }
    if (changedChartFiles.length === 0) {
      return { ...result, passShape: "empty-candidate-set" };
    }
    if (changedDeploymentAffectingFiles.length === 0) {
      return { ...result, passShape: "all-excluded" };
    }

    parseDoksIngressSemver(baseVersion, "base Chart.yaml");
    parseDoksIngressSemver(currentVersion, "current Chart.yaml");
    if (currentVersion === baseVersion) {
      return {
        ...result,
        passShape: "error",
        violations: [
          `${DOKS_INGRESS_CHART_YAML}: DOKS_INGRESS_VERSION_UNCHANGED: deployment-affecting content changed (${changedDeploymentAffectingFiles.join(", ")}) but version remains ${currentVersion}.`,
        ],
      };
    }
    if (compareDoksIngressSemverPrecedence(currentVersion, baseVersion) <= 0) {
      return {
        ...result,
        passShape: "error",
        violations: [
          `${DOKS_INGRESS_CHART_YAML}: DOKS_INGRESS_VERSION_NOT_INCREASING: deployment-affecting content changed (${changedDeploymentAffectingFiles.join(", ")}) but version did not increase from ${baseVersion} to ${currentVersion}.`,
        ],
      };
    }
    return { ...result, passShape: "version-increased" };
  } catch (error) {
    return diagnosticResult(error, {
      ...(discovery ? { discovery } : {}),
      ...(surface ? { surface } : {}),
      ...(baseVersion ? { baseVersion } : {}),
      ...(currentVersion ? { currentVersion } : {}),
      changedChartFiles,
    });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await validateDoksIngressChartVersion({ repoRoot: process.cwd() });
  console.log(
    JSON.stringify(
      {
        surface: result.surface,
        discovery: result.discovery,
        passShape: result.passShape,
        baseVersion: result.baseVersion,
        currentVersion: result.currentVersion,
        changedChartFiles: result.changedChartFiles,
        changedDeploymentAffectingFiles: result.changedDeploymentAffectingFiles,
        excludedChangedFiles: result.excludedChangedFiles,
      },
      null,
      2,
    ),
  );
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
}
