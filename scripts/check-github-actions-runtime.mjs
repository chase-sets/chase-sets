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

function lineIndent(line) {
  return line.length - line.trimStart().length;
}

// Splits a block of lines into the direct mapping children at exactly
// `childIndent` (e.g. each job under `jobs:`, or each field under a job).
// Every line more indented than `childIndent` belongs to the preceding
// child; this is the minimal indentation-based walk needed to recover
// GitHub Actions' jobs/steps tree without a general YAML parser.
function splitMappingChildren(lines, childIndent) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.trim() === "") {
      current?.lines.push(line);
      continue;
    }
    const indent = lineIndent(line);
    if (indent === childIndent) {
      const match = line.trim().match(/^([\w.-]+):\s*(.*)$/);
      if (match) {
        current = { key: match[1], lines: [] };
        blocks.push(current);
        continue;
      }
    }
    if (current && indent > childIndent) current.lines.push(line);
  }
  return blocks;
}

// Splits a `steps:` block into individual `- ...` list items at `itemIndent`.
function splitSequenceItems(lines, itemIndent) {
  const marker = `${" ".repeat(itemIndent)}- `;
  const items = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      current = [line];
      items.push(current);
      continue;
    }
    current?.push(line);
  }
  return items;
}

// A step's first line carries the `- ` list marker inline with its first
// field (`- name: Foo`); every following field line aligns to that same
// column without a marker. Replacing the marker's `-` with a space makes
// the first line's indentation directly comparable to its siblings.
function normalizeStepLines(rawLines) {
  if (rawLines.length === 0) return rawLines;
  const [first, ...rest] = rawLines;
  return [first.replace(/^(\s*)-/, "$1 "), ...rest];
}

// Extracts the fields a job-composition proof needs from one step's raw
// lines: whether it calls an external action, whether it has a shell `run:`
// body and that body's last statement, whether `continue-on-error: true` is
// set, and whether it is gated on `if: always()`.
function parseStep(rawLines) {
  const lines = normalizeStepLines(rawLines);
  const text = lines.join("\n");
  const runIndex = lines.findIndex((line) => /^\s*run:\s*(?:[|>][+-]?\s*)?$/.test(line) || /^\s*run:\s+\S/.test(line));
  let runBodyLastLine = null;
  if (runIndex !== -1) {
    const runIndent = lineIndent(lines[runIndex]);
    const inlineMatch = lines[runIndex].match(/^\s*run:\s*(\S.*)$/);
    const bodyLines = [];
    if (inlineMatch && !/^[|>][+-]?\s*$/.test(inlineMatch[1])) bodyLines.push(inlineMatch[1].trim());
    for (let index = runIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") continue;
      if (lineIndent(line) <= runIndent) break;
      bodyLines.push(line.trim());
    }
    runBodyLastLine = bodyLines.length > 0 ? (bodyLines.at(-1) ?? null) : null;
  }
  const nameMatch = text.match(/^\s*name:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    hasUses: /^\s*uses:\s*\S/m.test(text),
    hasRun: runIndex !== -1,
    hasContinueOnError: /^\s*continue-on-error:\s*true\s*$/m.test(text),
    isAlwaysStep: /if:\s*(?:\$\{\{\s*always\(\)\s*\}\}|always\(\))/.test(text),
    runBodyLastLine,
  };
}

// Parses `jobs:` into `{ id, bodyText, steps }` for each job, where `steps`
// is the ordered, field-extracted list produced by `parseStep`. This is a
// real (if GitHub-Actions-specific) job/step-composition parse rather than
// a file-wide substring search, so it can prove per-step containment
// instead of merely observing that safe-looking tokens appear somewhere.
function parseWorkflowJobs(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const jobsBlock = findBlock(lines, /^jobs:\s*$/, 0);
  if (!jobsBlock) return [];
  return splitMappingChildren(jobsBlock, 2).map((job) => {
    const stepsEntry = splitMappingChildren(job.lines, 4).find((entry) => entry.key === "steps");
    const stepBlocks = stepsEntry ? splitSequenceItems(stepsEntry.lines, 6) : [];
    return {
      id: job.key,
      bodyText: job.lines.join("\n"),
      steps: stepBlocks.map(parseStep),
    };
  });
}

// Proves two job-composition invariants a flat "does this file mention
// continue-on-error and exit 0 somewhere" check cannot:
//
// 1. Every step of the `advisory` (documented must-never-turn-red) job is
//    individually contained: an action (`uses:`) step carries
//    `continue-on-error: true`, and any `run:` step without it ends in an
//    unconditional `exit 0` so it cannot itself fail the job.
// 2. Any lightweight `*_CHECK_ONLY` enforcement job's final always()-run
//    boundary step actually relays a computed step-output exit code
//    (proving a later config-only rollout flip can still fail the job)
//    instead of a bare `exit 0` that would swallow it.
function jobCompositionViolations(filePath, workflowText) {
  const violations = [];
  const jobs = parseWorkflowJobs(workflowText);
  const label = relativePath(filePath);

  const advisoryJob = jobs.find((job) => job.id === "advisory");
  if (advisoryJob) {
    advisoryJob.steps.forEach((step, index) => {
      if (step.hasContinueOnError) return;
      const stepLabel = step.name ?? `step ${index + 1}`;
      if (step.hasUses) {
        violations.push(
          `${label}: advisory job step '${stepLabel}' calls an action without continue-on-error: true; a child failure would turn the never-red advisory job red.`,
        );
        return;
      }
      if (step.hasRun && step.runBodyLastLine !== "exit 0") {
        violations.push(
          `${label}: advisory job step '${stepLabel}' is a run step without continue-on-error: true whose last statement is not an unconditional 'exit 0'; it could turn the never-red advisory job red.`,
        );
      }
    });
  }

  for (const job of jobs) {
    if (!/_CHECK_ONLY:\s*["']true["']/.test(job.bodyText)) continue;
    const boundaryStep = [...job.steps].reverse().find((step) => step.isAlwaysStep && step.hasRun);
    const relaysComputedExitCode =
      boundaryStep?.runBodyLastLine != null &&
      /^exit\s+"?\$\{\{\s*steps\.[\w-]+\.outputs\.[\w-]+/.test(boundaryStep.runBodyLastLine);
    if (!relaysComputedExitCode) {
      violations.push(
        `${label}: job '${job.id}' is a check-only enforcement job whose boundary step does not relay a computed steps.*.outputs exit code; an enforcing failure would be swallowed by a bare exit instead of turning the job red.`,
      );
    }
  }

  return violations;
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
    /(?:execFileSync|spawnSync)\(\s*process\.execPath,\s*\[\s*path\.join\(trustedRoot,/.test(workflowText) &&
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
  violations.push(...jobCompositionViolations(filePath, workflowText));
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
