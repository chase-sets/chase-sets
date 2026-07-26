import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const chartRoot = "infrastructure/helm/doks-ingress";
const chartYaml = `${chartRoot}/Chart.yaml`;
const chartValues = `${chartRoot}/values.yaml`;
const templatesRoot = `${chartRoot}/templates`;
const explicitlyExcluded = new Map([
  [`${chartRoot}/README.md`, "not packaged Helm chart content"],
  [`${chartRoot}/ingress-nginx-values.yaml`, "input to the pinned ingress-nginx release"],
  [`${chartRoot}/cert-manager-values.yaml`, "input to the pinned cert-manager release"],
  [`${chartRoot}/argo-rollouts-values.yaml`, "input to the pinned argo-rollouts release"],
]);

export class DoksIngressChartVersionGuardError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "DoksIngressChartVersionGuardError";
    this.code = code;
  }
}

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isPackagedChartFile(file) {
  return file === chartYaml || file === chartValues || file.startsWith(`${templatesRoot}/`);
}

function readGit(repoRoot, args, code, description, execFileSyncImpl) {
  try {
    return execFileSyncImpl("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new DoksIngressChartVersionGuardError(
        "DOKS_INGRESS_GIT_UNAVAILABLE",
        "Git is required for chart diff discovery.",
      );
    }
    throw new DoksIngressChartVersionGuardError(code, description);
  }
}

function parseExplicitChangedFiles(value) {
  try {
    const changedFiles = JSON.parse(value);
    if (!Array.isArray(changedFiles) || changedFiles.some((file) => typeof file !== "string" || !file.trim())) {
      throw new Error("invalid changed files");
    }
    return changedFiles.map(normalizePath);
  } catch {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_CHANGED_FILES_JSON_INVALID",
      "CHANGED_FILES_JSON must be a JSON array of non-empty file paths.",
    );
  }
}

export function discoverDoksIngressChangedFiles({
  repoRoot,
  environment = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const explicitChangedFiles =
    typeof environment.CHANGED_FILES_JSON === "string"
      ? parseExplicitChangedFiles(environment.CHANGED_FILES_JSON)
      : null;
  const mergeBase = readGit(
    repoRoot,
    ["merge-base", "origin/main", "HEAD"],
    "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
    "Unable to derive merge base against origin/main.",
    execFileSyncImpl,
  );
  if (!mergeBase) {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
      "Unable to derive merge base against origin/main.",
    );
  }
  if (explicitChangedFiles) {
    return { changedFiles: explicitChangedFiles, mergeBase };
  }
  const output = readGit(
    repoRoot,
    ["diff", "--name-only", `${mergeBase}...HEAD`],
    "DOKS_INGRESS_DIFF_UNAVAILABLE",
    "Unable to derive changed files from the merge-base diff.",
    execFileSyncImpl,
  );
  return {
    changedFiles: output ? output.split(/\r?\n/).filter(Boolean).map(normalizePath) : [],
    mergeBase,
  };
}

function listFiles(root, relativeRoot = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(fullPath, relativePath) : [relativePath];
  });
}

export function scannedDoksIngressChartSurface({ repoRoot } = {}) {
  const absoluteChartRoot = path.join(repoRoot, chartRoot);
  if (!existsSync(absoluteChartRoot)) {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
      `${chartRoot} is absent; the guard refuses to certify an empty surface.`,
    );
  }
  const candidateFiles = listFiles(absoluteChartRoot)
    .map((file) => `${chartRoot}/${file}`)
    .sort();
  const scanned = candidateFiles.filter(isPackagedChartFile);
  if (scanned.length === 0) {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_CHART_SURFACE_UNAVAILABLE",
      `${chartRoot} has no packaged chart files to scan.`,
    );
  }
  return {
    scanned,
    excluded: candidateFiles
      .filter((file) => !scanned.includes(file))
      .map((file) => ({
        file,
        reason: explicitlyExcluded.get(file) ?? "not part of the declared packaged-content surface",
      })),
  };
}

function chartVersion(source, label) {
  const version = parse(source)?.version;
  if (typeof version !== "string") {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_VERSION_NON_SEMVER",
      `${label} has no string semver version.`,
    );
  }
  return version;
}

function parseStrictSemver(version, label) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_VERSION_NON_SEMVER",
      `${label} version "${version}" is not semver.`,
    );
  }
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
}

function isStrictlyIncreasing(baseVersion, currentVersion) {
  const base = parseStrictSemver(baseVersion, "base Chart.yaml");
  const current = parseStrictSemver(currentVersion, "current Chart.yaml");
  for (let index = 0; index < base.core.length; index += 1) {
    if (base.core[index] !== current.core[index]) {
      return current.core[index] > base.core[index];
    }
  }
  if (base.prerelease.length === 0 || current.prerelease.length === 0) {
    return base.prerelease.length > 0 && current.prerelease.length === 0;
  }
  for (let index = 0; index < Math.max(base.prerelease.length, current.prerelease.length); index += 1) {
    const left = base.prerelease[index];
    const right = current.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return true;
    if (right === undefined) return false;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(right) > Number(left);
    if (leftNumeric !== rightNumeric) return !rightNumeric;
    return right > left;
  }
  return false;
}

function readBaseChartVersion({ repoRoot, mergeBase }) {
  if (!mergeBase) {
    throw new DoksIngressChartVersionGuardError(
      "DOKS_INGRESS_MERGE_BASE_UNAVAILABLE",
      "A merge base is required to compare the prior Chart.yaml version.",
    );
  }
  return chartVersion(
    readGit(
      repoRoot,
      ["show", `${mergeBase}:${chartYaml}`],
      "DOKS_INGRESS_DIFF_UNAVAILABLE",
      "Unable to read base Chart.yaml.",
      execFileSync,
    ),
    "base Chart.yaml",
  );
}

function baseDoksIngressChartSurface({ repoRoot, mergeBase, execFileSyncImpl }) {
  const output = readGit(
    repoRoot,
    ["ls-tree", "-r", "--name-only", mergeBase, "--", chartRoot],
    "DOKS_INGRESS_DIFF_UNAVAILABLE",
    "Unable to read the base packaged chart surface.",
    execFileSyncImpl,
  );
  return output ? output.split(/\r?\n/).filter(Boolean).map(normalizePath).filter(isPackagedChartFile) : [];
}

export async function validateDoksIngressChartVersion({
  repoRoot,
  environment = process.env,
  execFileSyncImpl = execFileSync,
} = {}) {
  const surface = scannedDoksIngressChartSurface({ repoRoot });
  const discovery = discoverDoksIngressChangedFiles({ repoRoot, environment, execFileSyncImpl });
  const basePackagedFiles = baseDoksIngressChartSurface({
    repoRoot,
    mergeBase: discovery.mergeBase,
    execFileSyncImpl,
  });
  const currentPackagedFiles = new Set(surface.scanned);
  const removedPackagedFiles = basePackagedFiles.filter((file) => !currentPackagedFiles.has(file));
  const changedPackagedFiles = [
    ...new Set([...discovery.changedFiles.filter(isPackagedChartFile), ...removedPackagedFiles]),
  ].sort();
  if (changedPackagedFiles.length === 0) {
    return { violations: [], surface, changedPackagedFiles };
  }
  const currentVersion = chartVersion(readFileSync(path.join(repoRoot, chartYaml), "utf8"), "current Chart.yaml");
  const baseVersion = readBaseChartVersion({ repoRoot, mergeBase: discovery.mergeBase });
  try {
    parseStrictSemver(baseVersion, "base Chart.yaml");
    parseStrictSemver(currentVersion, "current Chart.yaml");
    if (currentVersion === baseVersion) {
      return {
        violations: [
          `${chartYaml}: DOKS_INGRESS_VERSION_UNCHANGED: packaged content changed (${changedPackagedFiles.join(", ")}) but version remains ${currentVersion}.`,
        ],
        surface,
        changedPackagedFiles,
      };
    }
    if (!isStrictlyIncreasing(baseVersion, currentVersion)) {
      return {
        violations: [
          `${chartYaml}: DOKS_INGRESS_VERSION_NOT_INCREASING: packaged content changed (${changedPackagedFiles.join(", ")}) but version decreased from ${baseVersion} to ${currentVersion}.`,
        ],
        surface,
        changedPackagedFiles,
      };
    }
  } catch (error) {
    if (error instanceof DoksIngressChartVersionGuardError) {
      return { violations: [`${chartYaml}: ${error.message}`], surface, changedPackagedFiles };
    }
    throw error;
  }
  return { violations: [], surface, changedPackagedFiles };
}

if (process.argv[1]?.endsWith("doks-ingress-chart-version.mjs")) {
  try {
    const result = await validateDoksIngressChartVersion({ repoRoot: process.cwd() });
    console.log(JSON.stringify({ ...result.surface, changedPackagedFiles: result.changedPackagedFiles }, null, 2));
    if (result.violations.length > 0) {
      console.error(result.violations.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
