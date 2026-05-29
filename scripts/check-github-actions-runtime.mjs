import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowRoot = path.join(repoRoot, ".github");

const minimumNode24ActionMajors = new Map([
  ["actions/cache", 5],
  ["actions/checkout", 6],
  ["actions/download-artifact", 7],
  ["actions/setup-node", 6],
  ["actions/upload-artifact", 7],
  ["docker/setup-buildx-action", 4],
  ["hashicorp/setup-terraform", 4],
  ["pnpm/action-setup", 6],
]);

const minimumNode24ActionVersions = new Map([["digitalocean/action-doctl", "v2.5.2"]]);

function walkYamlFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return walkYamlFiles(entryPath);
    }

    return /\.(?:ya?ml)$/i.test(entry.name) ? [entryPath] : [];
  });
}

function normalizeActionUse(value) {
  return value
    .replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function parseMajor(ref) {
  const match = ref.match(/^v(\d+)(?:\.|$)/);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function parseVersion(ref) {
  const match = ref.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1] ?? "", 10),
    Number.parseInt(match[2] ?? "", 10),
    Number.parseInt(match[3] ?? "", 10),
  ];
}

function isVersionAtLeast(ref, minimumRef) {
  const version = parseVersion(ref);
  const minimum = parseVersion(minimumRef);
  if (!version || !minimum) {
    return false;
  }

  for (let index = 0; index < version.length; index += 1) {
    if (version[index] > minimum[index]) return true;
    if (version[index] < minimum[index]) return false;
  }

  return true;
}

function actionUsesFromFile(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*(\S.*)$/);
      if (!match) {
        return null;
      }

      return {
        filePath,
        line: index + 1,
        value: normalizeActionUse(match[1] ?? ""),
      };
    })
    .filter(Boolean);
}

function validateActionUse(actionUse) {
  const value = actionUse.value;
  if (value.startsWith("./") || value.startsWith("docker://")) {
    return null;
  }

  const [actionName, ref] = value.split("@", 2);
  if (!actionName || !ref) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: action '${value}' must be pinned with an explicit @ref.`;
  }

  const minimumRef = minimumNode24ActionVersions.get(actionName);
  if (minimumRef && !isVersionAtLeast(ref, minimumRef)) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} must stay on ${minimumRef} or newer documented Node 24 metadata.`;
  }

  const minimumMajor = minimumNode24ActionMajors.get(actionName);
  if (!minimumMajor) {
    return null;
  }

  const major = parseMajor(ref);
  if (major === null) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} must use a major tag at least v${minimumMajor} for Node 24 action runtime support.`;
  }

  if (major < minimumMajor) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} targets an older JavaScript action runtime; use v${minimumMajor}+ for Node 24 support.`;
  }

  return null;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

export function checkGithubActionsRuntime({ rootDir = workflowRoot } = {}) {
  const violations = walkYamlFiles(rootDir).flatMap((filePath) =>
    actionUsesFromFile(filePath).map(validateActionUse).filter(Boolean),
  );

  if (violations.length === 0) {
    return { passed: true, violations };
  }

  return { passed: false, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkGithubActionsRuntime();
  if (!result.passed) {
    console.error("GitHub Actions runtime check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("GitHub Actions runtime pins are Node 24 compatible.");
}
