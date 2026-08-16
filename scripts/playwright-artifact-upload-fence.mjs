import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const rawPlaywrightRoots = ["artifacts/playwright/report", "artifacts/playwright/test-results"];

const historySchemaVersion = "playwright-upload-fence-history/v1";
const refSchemaVersion = "playwright-upload-fence-ref/v1";
const unknownExpression = "__UNKNOWN_GITHUB_EXPRESSION__";
const runnerTemp = "/__github_runner_temp__";
const workspace = "__GITHUB_WORKSPACE__";
const uploadArtifactPattern = /^actions\/upload-artifact@/;
const yamlPattern = /\.ya?ml$/i;
const shaPattern = /^[0-9a-f]{40}$/;

export class PlaywrightUploadFenceUnknownError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlaywrightUploadFenceUnknownError";
  }
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
    throw new PlaywrightUploadFenceUnknownError(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function isActionsYaml(path) {
  return yamlPattern.test(path) && (path.startsWith(".github/workflows/") || path.startsWith(".github/actions/"));
}

function readTrackedCorpus({ root, ref }) {
  let resolvedRef = null;
  let files;
  if (ref !== undefined && ref !== null) {
    resolvedRef = git(root, ["rev-parse", "--verify", `${ref}^{commit}`])
      .stdout.trim()
      .toLowerCase();
    if (!shaPattern.test(resolvedRef)) {
      throw new PlaywrightUploadFenceUnknownError(`ref '${ref}' did not resolve to one immutable 40-character commit`);
    }
    files = splitNull(
      git(root, ["ls-tree", "-r", "-z", "--name-only", resolvedRef, "--", ".github/workflows", ".github/actions"])
        .stdout,
    ).filter(isActionsYaml);
  } else {
    files = splitNull(git(root, ["ls-files", "-z", "--", ".github/workflows", ".github/actions"]).stdout).filter(
      isActionsYaml,
    );
  }

  if (files.length === 0) {
    throw new PlaywrightUploadFenceUnknownError("tracked Actions corpus is empty");
  }
  if (new Set(files).size !== files.length) {
    throw new PlaywrightUploadFenceUnknownError("tracked Actions corpus contains duplicate paths");
  }

  const corpus = new Map();
  for (const path of files.sort()) {
    try {
      const source = resolvedRef
        ? git(root, ["show", `${resolvedRef}:${path}`]).stdout
        : readFileSync(resolve(root, path), "utf8");
      corpus.set(path, source);
    } catch (error) {
      throw new PlaywrightUploadFenceUnknownError(
        `could not read tracked Actions file '${path}'${resolvedRef ? ` at ${resolvedRef}` : ""}: ${error.message}`,
      );
    }
  }
  return { corpus, requestedRef: ref ?? null, resolvedRef };
}

function parseActionsFile(path, source) {
  const document = parseDocument(source, { merge: true, prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new PlaywrightUploadFenceUnknownError(
      `${path} is not readable YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  try {
    const value = document.toJS({ maxAliasCount: 1_000 });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be a mapping");
    }
    return value;
  } catch (error) {
    throw new PlaywrightUploadFenceUnknownError(`${path} could not resolve YAML aliases: ${error.message}`);
  }
}

function mapping(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function scalar(value) {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  return undefined;
}

function lookupBinding(expression, context, seen) {
  const normalized = expression.trim();
  if (normalized === "runner.temp") return runnerTemp;
  if (normalized === "github.workspace") return workspace;
  const match = normalized.match(/^(env|inputs)\.([A-Za-z_][A-Za-z0-9_-]*)$/);
  if (!match) return unknownExpression;
  const collection = match[1] === "env" ? context.env : context.inputs;
  const value = scalar(collection[match[2]]);
  if (value === undefined) return unknownExpression;
  const identity = `${match[1]}.${match[2]}`;
  if (seen.has(identity)) return unknownExpression;
  return resolveExpressions(value, context, new Set([...seen, identity]));
}

function resolveExpressions(value, context, seen = new Set()) {
  return String(value).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_whole, expression) =>
    lookupBinding(expression, context, seen),
  );
}

function actionInputValues(action, supplied, callerContext) {
  const values = {};
  for (const [name, definition] of Object.entries(mapping(action.inputs))) {
    const defaultValue = scalar(mapping(definition).default);
    if (defaultValue !== undefined) values[name] = resolveExpressions(defaultValue, callerContext);
  }
  for (const [name, value] of Object.entries(mapping(supplied))) {
    const text = scalar(value);
    values[name] = text === undefined ? unknownExpression : resolveExpressions(text, callerContext);
  }
  return values;
}

function contextWith(parent, ...envs) {
  return {
    inputs: parent.inputs,
    env: Object.assign({}, parent.env, ...envs.map(mapping)),
  };
}

function normalizeUploadEntry(value) {
  let normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replaceAll("\\", "/");
  normalized = normalized.replace(new RegExp(`^${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/?`), "");
  normalized = normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  return normalized;
}

function pathRelation(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function uploadEntryFinding(entry, context) {
  if (entry.trim().startsWith("!")) return null;
  const resolved = normalizeUploadEntry(resolveExpressions(entry, context));
  if (!resolved) {
    return { rawRoot: rawPlaywrightRoots[0], resolvedPath: resolved, analysis: "empty upload path is unknown" };
  }
  if (resolved === runnerTemp || resolved.startsWith(`${runnerTemp}/`)) return null;
  if (resolved.startsWith("/") || /^[A-Za-z]:\//.test(resolved)) {
    return {
      rawRoot: rawPlaywrightRoots[0],
      resolvedPath: resolved,
      analysis: "absolute upload path is not provably outside the workspace",
    };
  }
  if (resolved.split("/").includes("..") || resolved.startsWith("~")) {
    return {
      rawRoot: rawPlaywrightRoots[0],
      resolvedPath: resolved,
      analysis: "path escapes or encloses the workspace",
    };
  }

  const normalized = posix.normalize(resolved);
  const magicIndexes = ["?", "*", "{", "[", unknownExpression]
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0);
  const magicIndex = magicIndexes.length === 0 ? -1 : Math.min(...magicIndexes);
  if (magicIndex < 0) {
    if (normalized === ".") {
      return {
        rawRoot: rawPlaywrightRoots[0],
        resolvedPath: normalized,
        analysis: "workspace upload includes disabled raw roots",
      };
    }
    const rawRoot = rawPlaywrightRoots.find((root) => pathRelation(normalized.replace(/\/$/, ""), root));
    return rawRoot
      ? { rawRoot, resolvedPath: normalized, analysis: "literal path intersects a disabled raw root" }
      : null;
  }

  const literalPrefix = normalized.slice(0, magicIndex);
  const slashIndex = literalPrefix.lastIndexOf("/");
  const fixedDirectory = slashIndex < 0 ? "" : literalPrefix.slice(0, slashIndex).replace(/\/$/, "");
  const rawRoot = rawPlaywrightRoots.find((root) => !fixedDirectory || pathRelation(fixedDirectory, root));
  return rawRoot
    ? { rawRoot, resolvedPath: normalized, analysis: "glob or unresolved expression can include a disabled raw root" }
    : null;
}

function uploadPathEntries(value) {
  if (typeof value !== "string") {
    throw new PlaywrightUploadFenceUnknownError("actions/upload-artifact path must be a scalar string");
  }
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function stepLabel(step, index) {
  return scalar(step.name) ?? scalar(step.id) ?? `step-${index + 1}`;
}

function localActionDirectory(uses) {
  if (!uses.startsWith("./")) return null;
  return posix.normalize(uses.slice(2)).replace(/\/$/, "");
}

function actionFileForDirectory(actionsByDirectory, directory) {
  return actionsByDirectory.get(directory) ?? null;
}

export function inspectPlaywrightArtifactUploadCorpus(corpusInput) {
  const corpus = corpusInput instanceof Map ? corpusInput : new Map(Object.entries(corpusInput));
  const parsed = new Map();
  for (const [path, source] of corpus) {
    if (!isActionsYaml(path)) continue;
    if (typeof source !== "string") {
      throw new PlaywrightUploadFenceUnknownError(`${path} is unreadable`);
    }
    parsed.set(path, parseActionsFile(path, source));
  }
  if (parsed.size !== corpus.size) {
    throw new PlaywrightUploadFenceUnknownError("Actions corpus contains an out-of-scope or unreadable tree entry");
  }

  const actionsByDirectory = new Map();
  for (const path of parsed.keys()) {
    if (path.startsWith(".github/actions/") && /\/(?:action)\.ya?ml$/i.test(path)) {
      actionsByDirectory.set(dirname(path).replaceAll("\\", "/"), path);
    }
  }

  const findings = [];
  const uploads = [];
  const calledActions = new Set();
  const localCompositeCallers = [];
  let localCompositeCalls = 0;

  const evaluateSteps = ({ steps, file, owner, context, callerChain, activeActions = new Set() }) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((rawStep, index) => {
      const step = mapping(rawStep);
      const stepContext = contextWith(context, step.env);
      const usesValue = scalar(step.uses);
      if (!usesValue) return;
      const uses = resolveExpressions(usesValue, stepContext);
      if (uploadArtifactPattern.test(uses)) {
        const pathValue = mapping(step.with).path;
        const entries = uploadPathEntries(pathValue);
        const upload = {
          file,
          owner,
          step: stepLabel(step, index),
          callerChain,
          paths: entries,
        };
        uploads.push(upload);
        for (const entry of entries) {
          const finding = uploadEntryFinding(entry, stepContext);
          if (finding) findings.push({ ...upload, uploadPath: entry, ...finding });
        }
        return;
      }

      const actionDirectory = localActionDirectory(uses);
      if (actionDirectory === null || !actionDirectory.startsWith(".github/actions/")) return;
      localCompositeCalls += 1;
      const actionFile = actionFileForDirectory(actionsByDirectory, actionDirectory);
      if (!actionFile) {
        throw new PlaywrightUploadFenceUnknownError(`${file} calls unreadable local action '${uses}'`);
      }
      localCompositeCallers.push({
        file,
        owner,
        step: stepLabel(step, index),
        uses,
        actionFile,
        callerChain,
      });
      calledActions.add(actionFile);
      if (activeActions.has(actionFile)) {
        throw new PlaywrightUploadFenceUnknownError(`local composite action cycle reaches '${actionFile}'`);
      }
      const action = parsed.get(actionFile);
      if (mapping(action.runs).using !== "composite" || !Array.isArray(mapping(action.runs).steps)) {
        throw new PlaywrightUploadFenceUnknownError(`${actionFile} is not a readable composite action`);
      }
      const inputs = actionInputValues(action, step.with, stepContext);
      evaluateSteps({
        steps: action.runs.steps,
        file: actionFile,
        owner: "composite",
        context: { env: {}, inputs },
        callerChain: [...callerChain, `${file}:${owner}:${stepLabel(step, index)}`],
        activeActions: new Set([...activeActions, actionFile]),
      });
    });
  };

  for (const [file, document] of parsed) {
    if (!file.startsWith(".github/workflows/")) continue;
    const workflowEnv = mapping(document.env);
    for (const [jobId, rawJob] of Object.entries(mapping(document.jobs))) {
      const job = mapping(rawJob);
      evaluateSteps({
        steps: job.steps,
        file,
        owner: jobId,
        context: { env: { ...workflowEnv, ...mapping(job.env) }, inputs: mapping(document.inputs) },
        callerChain: [],
      });
    }
  }

  for (const [actionDirectory, actionFile] of actionsByDirectory) {
    if (calledActions.has(actionFile)) continue;
    const action = parsed.get(actionFile);
    if (mapping(action.runs).using !== "composite" || !Array.isArray(mapping(action.runs).steps)) {
      throw new PlaywrightUploadFenceUnknownError(`${actionFile} is not a readable composite action`);
    }
    evaluateSteps({
      steps: action.runs.steps,
      file: actionFile,
      owner: "composite",
      context: { env: {}, inputs: actionInputValues(action, {}, { env: {}, inputs: {} }) },
      callerChain: [`tracked composite ${actionDirectory}`],
      activeActions: new Set([actionFile]),
    });
  }

  const workflowFiles = [...parsed.keys()].filter((path) => path.startsWith(".github/workflows/")).length;
  const compositeActionFiles = [...parsed.keys()].filter((path) => path.startsWith(".github/actions/")).length;
  return {
    schemaVersion: refSchemaVersion,
    status: findings.length === 0 ? "pass" : "fail",
    passed: findings.length === 0,
    findings,
    uploads,
    census: {
      files: [...parsed.keys()].sort(),
      localCompositeCallers,
    },
    discovery: {
      trackedFiles: parsed.size,
      parsedFiles: parsed.size,
      workflowFiles,
      compositeActionFiles,
      uploadSteps: uploads.length,
      evaluatedUploadPaths: uploads.reduce((count, upload) => count + upload.paths.length, 0),
      localCompositeCalls,
    },
  };
}

export function scanPlaywrightArtifactUploads({ root = process.cwd(), ref, corpus } = {}) {
  const loaded = corpus
    ? {
        corpus: corpus instanceof Map ? corpus : new Map(Object.entries(corpus)),
        requestedRef: ref ?? null,
        resolvedRef: null,
      }
    : readTrackedCorpus({ root, ref });
  const result = inspectPlaywrightArtifactUploadCorpus(loaded.corpus);
  return { ...result, requestedRef: loaded.requestedRef, resolvedRef: loaded.resolvedRef };
}

function pullSnapshot(value) {
  return {
    commits: value?.commits,
    headSha: value?.head?.sha?.toLowerCase(),
    branch: value?.head?.ref,
  };
}

function unknownHistory({ pr, repo, expectedHead, before, reasons }) {
  return {
    schemaVersion: historySchemaVersion,
    status: "unknown",
    passed: false,
    repository: repo,
    pullRequest: pr,
    expectedHead,
    branch: before?.branch ?? null,
    firstSha: null,
    finalSha: before?.headSha ?? null,
    commits: [],
    guardResults: [],
    reasons,
  };
}

export async function auditPullRequestHistory({
  pr,
  repo,
  expectedHead,
  fetchPull,
  fetchCommitPages,
  scanRef,
  providerCommitCap = 250,
}) {
  let before;
  try {
    before = pullSnapshot(await fetchPull());
    const reasons = [];
    if (!Number.isSafeInteger(before.commits) || before.commits < 1)
      reasons.push("PR commit count is missing or invalid");
    if (!shaPattern.test(before.headSha ?? "")) reasons.push("PR head is missing or invalid");
    if (!before.branch) reasons.push("PR branch is missing");
    if (expectedHead && before.headSha !== expectedHead.toLowerCase())
      reasons.push("PR head does not match expected head");
    if (before.commits > providerCommitCap) reasons.push(`PR commit count exceeds provider cap ${providerCommitCap}`);
    if (reasons.length > 0) return unknownHistory({ pr, repo, expectedHead, before, reasons });

    const pages = await fetchCommitPages();
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: ["paginated PR commit response is unreadable"],
      });
    }
    const commits = pages.flat().map((commit) => commit?.sha?.toLowerCase());
    if (commits.some((sha) => !shaPattern.test(sha ?? ""))) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: ["paginated PR commit response has a missing commit"],
      });
    }
    if (new Set(commits).size !== commits.length) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: ["paginated PR commit response has duplicate commits"],
      });
    }
    if (commits.length !== before.commits) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: [`paginated PR commit count ${commits.length} does not reconcile to PR count ${before.commits}`],
      });
    }
    if (commits.at(-1) !== before.headSha) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: ["final paginated commit does not equal PR head"],
      });
    }

    const guardResults = [];
    for (const sha of commits) {
      try {
        const result = await scanRef(sha);
        if (result.resolvedRef !== sha || !["pass", "fail"].includes(result.status)) {
          return unknownHistory({ pr, repo, expectedHead, before, reasons: [`guard returned unknown for ${sha}`] });
        }
        guardResults.push({
          sha,
          status: result.status,
          findings: result.findings,
          discovery: result.discovery,
        });
      } catch (error) {
        return unknownHistory({
          pr,
          repo,
          expectedHead,
          before,
          reasons: [`unreadable tree ${sha}: ${error.message}`],
        });
      }
    }

    const after = pullSnapshot(await fetchPull());
    if (after.commits !== before.commits || after.headSha !== before.headSha || after.branch !== before.branch) {
      return unknownHistory({
        pr,
        repo,
        expectedHead,
        before,
        reasons: ["PR head, branch, or commit count moved during audit"],
      });
    }
    const status = guardResults.every((result) => result.status === "pass") ? "pass" : "fail";
    return {
      schemaVersion: historySchemaVersion,
      status,
      passed: status === "pass",
      repository: repo,
      pullRequest: pr,
      expectedHead,
      branch: before.branch,
      firstSha: commits[0],
      finalSha: commits.at(-1),
      commits,
      guardResults,
      reasons: status === "pass" ? [] : ["at least one remotely visible commit contains a raw Playwright upload path"],
    };
  } catch (error) {
    return unknownHistory({ pr, repo, expectedHead, before, reasons: [error.message] });
  }
}

function ghJson(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new PlaywrightUploadFenceUnknownError(
      `gh ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new PlaywrightUploadFenceUnknownError(`gh ${args.join(" ")} returned unreadable JSON: ${error.message}`);
  }
}

function option(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : (argv[index + 1] ?? fallback);
}

function requiredInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function runCli(argv) {
  const root = resolve(option(argv, "--root", process.cwd()));
  const prValue = option(argv, "--pr");
  if (prValue !== null) {
    const pr = requiredInteger(prValue, "--pr");
    const repo = option(argv, "--repo") ?? ghJson(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
    const expectedHead = option(argv, "--expected-head");
    if (expectedHead && !shaPattern.test(expectedHead)) throw new Error("--expected-head must be a 40-character SHA");
    const endpoint = `repos/${repo}/pulls/${pr}`;
    const result = await auditPullRequestHistory({
      pr,
      repo,
      expectedHead,
      fetchPull: async () => ghJson(["api", endpoint]),
      fetchCommitPages: async () => ghJson(["api", "--paginate", "--slurp", `${endpoint}/commits?per_page=100`]),
      scanRef: async (sha) => scanPlaywrightArtifactUploads({ root, ref: sha }),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }

  const ref = option(argv, "--ref");
  try {
    const result = scanPlaywrightArtifactUploads({ root, ref: ref ?? undefined });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          schemaVersion: refSchemaVersion,
          status: "unknown",
          passed: false,
          requestedRef: ref,
          resolvedRef: null,
          findings: [],
          error: error.message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
