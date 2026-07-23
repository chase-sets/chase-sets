import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowRoot = path.join(repoRoot, ".github");

const minimumNode24ActionVersions = new Map([
  ["actions/cache", "v5.0.0"],
  ["actions/checkout", "v6.0.0"],
  ["actions/download-artifact", "v7.0.0"],
  ["actions/github-script", "v8.0.0"],
  ["actions/setup-node", "v6.0.0"],
  ["actions/upload-artifact", "v7.0.0"],
  ["digitalocean/action-doctl", "v2.5.2"],
  ["docker/setup-buildx-action", "v4.0.0"],
  ["hashicorp/setup-terraform", "v4.0.0"],
  ["pnpm/action-setup", "v6.0.0"],
]);

const fullCommitShaPattern = /^[a-f0-9]{40}$/i;

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

function parseVersionComment(value) {
  const match = value.match(/\s+#\s*(v\d+\.\d+\.\d+)(?:\s|$)/);
  return match ? (match[1] ?? null) : null;
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
        versionComment: parseVersionComment(match[1] ?? ""),
        value: normalizeActionUse(match[1] ?? ""),
      };
    })
    .filter(Boolean);
}

function readWorkflowLines(filePath) {
  return readFileSync(filePath, "utf8").split(/\r?\n/);
}

function collectIndentedBlock(lines, startIndex, parentIndent) {
  const block = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed && !line.startsWith(" ".repeat(parentIndent + 1))) {
      break;
    }
    block.push(line);
  }
  return block;
}

function findBlock(lines, pattern, parentIndent) {
  const startIndex = lines.findIndex((line) => pattern.test(line));
  if (startIndex === -1) {
    return null;
  }
  return collectIndentedBlock(lines, startIndex, parentIndent);
}

function previewCleanupPolicyViolations(filePath) {
  if (
    path.basename(path.dirname(filePath)) !== "workflows" ||
    path.basename(filePath) !== "platform-preview-cleanup.yml"
  ) {
    return [];
  }

  const lines = readWorkflowLines(filePath);
  const violations = [];
  const workflowText = lines.join("\n");
  const cleanupJobBlock = findBlock(lines, /^\s{2}destroy-preview:\s*$/, 2);
  const checkoutStepBlock = findBlock(lines, /^\s{6}- uses: actions\/checkout@/, 6);

  if (!/pull_request_target:\n\s+types:\n\s+- closed/.test(workflowText)) {
    violations.push(`${relativePath(filePath)}: pull_request_target preview cleanup must stay closed-only.`);
  }

  const timeoutLine = cleanupJobBlock?.find((line) => /^\s{4}timeout-minutes:\s*\d+\s*$/.test(line));
  const timeoutMinutes = timeoutLine ? Number.parseInt(timeoutLine.split(":")[1] ?? "", 10) : null;
  if (!timeoutMinutes || timeoutMinutes > 60) {
    violations.push(
      `${relativePath(filePath)}: destroy-preview must have an explicit job timeout of 60 minutes or less.`,
    );
  }

  const checkoutStepText = checkoutStepBlock?.join("\n") ?? "";
  if (!checkoutStepText.includes("never checks") || !checkoutStepText.includes("PR head code")) {
    violations.push(
      `${relativePath(filePath)}: checkout step must document why pull_request_target is safe for preview cleanup.`,
    );
  }

  const checkoutRefLine = checkoutStepBlock?.find((line) => /^\s{10}ref:\s*/.test(line)) ?? "";
  if (/\bpull_request\.head\.(?:ref|sha)\b/.test(checkoutRefLine)) {
    violations.push(`${relativePath(filePath)}: checkout ref must not use untrusted pull_request.head code.`);
  }

  return violations;
}

// Discovers advisory evaluator workflows two ways: the original literal
// reference/name checks (kept so an arbitrarily renamed/relocated risk
// review is still caught), plus the underlying code shape every advisory
// evaluator actually runs — an actions/github-script step that fetches
// trusted-base sources from the repository's default branch and
// execFileSync's one of them out of `trustedRoot`. The shape clause is what
// lets this guard find platform-pr-scope.yml (and any future advisory
// evaluator following the same pattern) instead of relying on it
// incidentally mentioning platform-risk-review.mjs in its trusted-base file
// list.
function isAdvisoryEvaluatorWorkflow(workflowText) {
  if (workflowText.includes("scripts/platform-risk-review.mjs") || /^name:\s*Risk Review/m.test(workflowText)) {
    return true;
  }
  return (
    /execFileSync\(\s*process\.execPath,\s*\[\s*path\.join\(trustedRoot,/.test(workflowText) &&
    workflowText.includes("ref: context.payload.repository.default_branch")
  );
}

function riskReviewPolicyViolations(filePath) {
  if (path.basename(path.dirname(filePath)) !== "workflows") return [];
  const workflowText = readFileSync(filePath, "utf8");
  if (!isAdvisoryEvaluatorWorkflow(workflowText)) return [];

  const violations = [];
  for (const event of ["pull_request_target:", "pull_request_review:", "merge_group:"]) {
    if (!workflowText.includes(event)) violations.push(`${relativePath(filePath)}: risk review must handle ${event}`);
  }
  if (workflowText.includes("actions/checkout@")) {
    violations.push(`${relativePath(filePath)}: risk review must not checkout code on elevated review events.`);
  }
  if (
    !workflowText.includes("ref: context.payload.repository.default_branch") ||
    /pull_request\.head\.(?:sha|ref)/.test(workflowText)
  ) {
    violations.push(`${relativePath(filePath)}: risk review must load executable support only from the trusted base.`);
  }
  if (!workflowText.includes("continue-on-error: true") || !workflowText.includes("exit 0")) {
    violations.push(`${relativePath(filePath)}: advisory risk-review child failure must not make its workflow red.`);
  }
  if (!workflowText.includes("contents: read") || !workflowText.includes("pull-requests: write")) {
    violations.push(`${relativePath(filePath)}: risk review permissions must stay explicit and least-privileged.`);
  }
  return violations;
}

function validateActionUse(actionUse) {
  const value = actionUse.value;
  if (value.startsWith("./") || value.startsWith("docker://")) {
    return null;
  }

  const refSeparatorIndex = value.indexOf("@");
  if (refSeparatorIndex === -1 || refSeparatorIndex === value.length - 1) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: action '${value}' must be pinned with an explicit @ref.`;
  }

  const actionName = value.slice(0, refSeparatorIndex);
  const ref = value.slice(refSeparatorIndex + 1);
  const minimumRef = minimumNode24ActionVersions.get(actionName);
  if (!minimumRef) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: external action '${actionName}' is not in the Node 24 compatibility allowlist; verify its action metadata uses Node 24 and add it to check-github-actions-runtime.mjs.`;
  }

  if (!fullCommitShaPattern.test(ref)) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} must be pinned to a full 40-character commit SHA with an inline '# vX.Y.Z' release comment.`;
  }

  if (!actionUse.versionComment) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} must include an inline '# vX.Y.Z' release comment after the SHA pin.`;
  }

  if (!isVersionAtLeast(actionUse.versionComment, minimumRef)) {
    return `${relativePath(actionUse.filePath)}:${actionUse.line}: ${actionName}@${ref} is documented as ${actionUse.versionComment}; keep the release comment on ${minimumRef} or newer Node 24 metadata.`;
  }

  return null;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

export function checkGithubActionsRuntime({ rootDir = workflowRoot } = {}) {
  const violations = walkYamlFiles(rootDir).flatMap((filePath) =>
    actionUsesFromFile(filePath)
      .map(validateActionUse)
      .filter(Boolean)
      .concat(previewCleanupPolicyViolations(filePath), riskReviewPolicyViolations(filePath)),
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

  console.log("GitHub Actions runtime pins are SHA-pinned and Node 24 compatible.");
}
