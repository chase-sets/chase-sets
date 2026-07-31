import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../lib/repo.mjs";

export const guardCandidateProvenanceSchemaVersion = "guard-candidate-provenance/v1";
export const guardCandidateProvenanceSchemaPath = "scripts/check-structure/guard-candidate-provenance-v1.schema.json";

const qualifiedBaseRef = "refs/remotes/origin/main";
const shaPattern = /^[0-9a-f]{40}$/;
const roleNames = Object.freeze([
  "analyzedTree",
  "reviewedHead",
  "landingCandidate",
  "baseTipAtAnalysis",
  "eventBaseSnapshot",
  "forkPoint",
]);

export class GuardCandidateProvenanceError extends Error {
  constructor(code, reachedClause, message) {
    super(message);
    this.name = "GuardCandidateProvenanceError";
    this.code = code;
    this.reachedClause = reachedClause;
  }
}

function failure(code, reachedClause, message) {
  return new GuardCandidateProvenanceError(code, reachedClause, message);
}

function defaultExecGit(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function defaultReadEventPayload(env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw failure("guard-provenance-invalid", "event-payload", "GITHUB_EVENT_PATH is required for a hosted checkout");
  }
  return readFileSync(eventPath, "utf8");
}

function normalizeGitResult(result) {
  if (typeof result === "string" || Buffer.isBuffer(result)) {
    return { status: 0, stdout: String(result) };
  }
  if (result && typeof result === "object") {
    return {
      status: Number.isInteger(result.status) ? result.status : 0,
      stdout: result.stdout === undefined ? "" : String(result.stdout),
    };
  }
  return { status: 0, stdout: result === undefined ? "" : String(result) };
}

function executeGit(execGit, args, reachedClause, { allowExitOne = false, allowEmpty = false } = {}) {
  let result;
  try {
    result = normalizeGitResult(execGit(args));
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : null;
    if (allowExitOne && status === 1) return { status, stdout: "" };
    throw failure("guard-provenance-unavailable", reachedClause, `git ${args.join(" ")} could not be executed`);
  }

  if (allowExitOne && result.status === 1) return result;
  if (result.status !== 0) {
    throw failure("guard-provenance-unavailable", reachedClause, `git ${args.join(" ")} exited ${result.status}`);
  }
  if (!allowEmpty && !result.stdout.trim()) {
    throw failure("guard-provenance-unavailable", "git-output", `git ${args.join(" ")} returned empty output`);
  }
  return result;
}

function gitText(execGit, args, reachedClause, options) {
  return executeGit(execGit, args, reachedClause, options).stdout.trim();
}

function requireSha(value, reachedClause, label) {
  if (typeof value !== "string" || !shaPattern.test(value)) {
    throw failure("guard-provenance-invalid", reachedClause, `${label} must be a full lowercase commit sha`);
  }
  return value;
}

function parseEventPayload(readEventPayload) {
  let payload;
  try {
    const value = readEventPayload();
    payload = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    if (error instanceof GuardCandidateProvenanceError) throw error;
    throw failure("guard-provenance-invalid", "event-payload", "the GitHub event payload is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw failure("guard-provenance-invalid", "event-payload", "the GitHub event payload must be an object");
  }
  return payload;
}

function eventSha(payload, path, label) {
  let value = payload;
  for (const key of path) value = value?.[key];
  return requireSha(value, "event-payload", label);
}

function classifyEnvironment(env) {
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName === undefined) return "plain";
  if (eventName === "pull_request") return "pull-request-merge-ref";
  if (eventName === "merge_group") return "merge-group";
  throw failure(
    "guard-provenance-environment-ambiguous",
    "environment-classification",
    `GITHUB_EVENT_NAME ${JSON.stringify(eventName)} is not a handled checkout environment`,
  );
}

function commitParentage(execGit, sha) {
  const fields = gitText(execGit, ["rev-list", "--parents", "-n", "1", sha], "git-parentage").split(/\s+/);
  if (fields[0] !== sha) {
    throw failure(
      "guard-provenance-invalid",
      "base-tip-parentage",
      "the analyzed tree parentage did not identify the requested commit",
    );
  }
  return fields.slice(1).map((parent) => requireSha(parent, "git-parentage", "commit parent"));
}

function requireObject(execGit, sha) {
  executeGit(execGit, ["cat-file", "-e", `${sha}^{commit}`], "object-existence", { allowEmpty: true });
}

function isAncestor(execGit, ancestor, descendant, reachedClause) {
  const result = executeGit(execGit, ["merge-base", "--is-ancestor", ancestor, descendant], reachedClause, {
    allowExitOne: true,
    allowEmpty: true,
  });
  return result.status === 0;
}

function role(sha, source) {
  return { sha, source };
}

export function deriveRoleCoincidences(roles) {
  const sortedNames = [...roleNames].sort();
  const coincidences = [];
  for (let left = 0; left < sortedNames.length; left += 1) {
    for (let right = left + 1; right < sortedNames.length; right += 1) {
      const leftName = sortedNames[left];
      const rightName = sortedNames[right];
      const sha = roles[leftName].sha;
      if (sha !== null && sha === roles[rightName].sha) coincidences.push([leftName, rightName]);
    }
  }
  return coincidences;
}

export function deriveGuardCandidateProvenance({
  env = process.env,
  execGit = defaultExecGit,
  readEventPayload = () => defaultReadEventPayload(env),
} = {}) {
  const environment = classifyEnvironment(env);
  const insideWorkTree = gitText(execGit, ["rev-parse", "--is-inside-work-tree"], "git-worktree");
  if (insideWorkTree !== "true") {
    throw failure("guard-provenance-unavailable", "git-worktree", "guard provenance requires a Git worktree");
  }

  const analyzedTreeSha = requireSha(gitText(execGit, ["rev-parse", "HEAD"], "git-head"), "git-head", "git HEAD");
  const resolvedBaseRef = requireSha(
    gitText(execGit, ["rev-parse", qualifiedBaseRef], "qualified-base-ref"),
    "qualified-base-ref",
    qualifiedBaseRef,
  );

  let roles;
  if (environment === "plain") {
    roles = {
      analyzedTree: role(analyzedTreeSha, "git-head"),
      reviewedHead: role(analyzedTreeSha, "git-head"),
      landingCandidate: role(analyzedTreeSha, "git-head"),
      baseTipAtAnalysis: role(resolvedBaseRef, "git-qualified-remote-ref"),
      eventBaseSnapshot: role(null, "absent-outside-pull-request"),
      forkPoint: null,
    };
  } else if (environment === "pull-request-merge-ref") {
    const payload = parseEventPayload(readEventPayload);
    const reviewedHeadSha = eventSha(payload, ["pull_request", "head", "sha"], "pull_request.head.sha");
    const eventBaseSha = eventSha(payload, ["pull_request", "base", "sha"], "pull_request.base.sha");
    const parents = commitParentage(execGit, analyzedTreeSha);
    if (parents.length !== 2 || parents[1] !== reviewedHeadSha) {
      throw failure(
        "guard-provenance-invalid",
        "base-tip-parentage",
        "the pull-request merge ref must have base then reviewed-head parents",
      );
    }
    roles = {
      analyzedTree: role(analyzedTreeSha, "git-head"),
      reviewedHead: role(reviewedHeadSha, "pull-request-event-head"),
      landingCandidate: role(reviewedHeadSha, "pull-request-event-head"),
      baseTipAtAnalysis: role(parents[0], "analyzed-tree-first-parent"),
      eventBaseSnapshot: role(eventBaseSha, "pull-request-event-base-snapshot"),
      forkPoint: null,
    };
  } else {
    const payload = parseEventPayload(readEventPayload);
    const landingCandidateSha = eventSha(payload, ["merge_group", "head_sha"], "merge_group.head_sha");
    const eventBaseSha = eventSha(payload, ["merge_group", "base_sha"], "merge_group.base_sha");
    const parents = commitParentage(execGit, analyzedTreeSha);
    if (analyzedTreeSha !== landingCandidateSha || parents.length !== 1 || parents[0] !== eventBaseSha) {
      throw failure(
        "guard-provenance-invalid",
        "base-tip-parentage",
        "the merge-group head must be the analyzed tree with its event base as sole parent",
      );
    }
    roles = {
      analyzedTree: role(analyzedTreeSha, "git-head"),
      reviewedHead: role(null, "not-present-in-merge-group"),
      landingCandidate: role(landingCandidateSha, "merge-group-event-head"),
      baseTipAtAnalysis: role(eventBaseSha, "merge-group-event-base"),
      eventBaseSnapshot: role(null, "absent-outside-pull-request"),
      forkPoint: null,
    };
  }

  if (environment !== "plain" && resolvedBaseRef !== roles.baseTipAtAnalysis.sha) {
    throw failure(
      "guard-provenance-invalid",
      "base-tip-parentage",
      "the qualified base ref must resolve to the base tip contemporaneous with the analyzed tree",
    );
  }

  const forkPointSha = requireSha(
    gitText(execGit, ["merge-base", roles.landingCandidate.sha, qualifiedBaseRef], "fork-point-resolution"),
    "fork-point-resolution",
    "fork point",
  );
  roles.forkPoint = role(forkPointSha, "git-merge-base");

  for (const name of roleNames) {
    const sha = roles[name].sha;
    if (sha !== null) requireObject(execGit, sha);
  }

  if (!isAncestor(execGit, forkPointSha, roles.landingCandidate.sha, "fork-point-ancestry")) {
    throw failure(
      "guard-provenance-invalid",
      "fork-point-ancestry",
      "the fork point is not an ancestor of the landing candidate",
    );
  }

  const reviewedHeadLands =
    roles.reviewedHead.sha === null
      ? false
      : isAncestor(execGit, roles.reviewedHead.sha, roles.landingCandidate.sha, "reviewed-head-ancestry");
  const coincidences = deriveRoleCoincidences(roles);
  const distinctObjectCount = new Set(roleNames.map((name) => roles[name].sha).filter((sha) => sha !== null)).size;

  return {
    schemaVersion: guardCandidateProvenanceSchemaVersion,
    environment,
    roles,
    coincidences,
    distinctObjectCount,
    reviewedHeadLands,
    capturedAt: new Date().toISOString(),
  };
}

export function loadGuardCandidateProvenanceSchema() {
  return JSON.parse(readFileSync(new URL(`../../${guardCandidateProvenanceSchemaPath}`, import.meta.url), "utf8"));
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  try {
    process.stdout.write(`${JSON.stringify(deriveGuardCandidateProvenance())}\n`);
  } catch (error) {
    const receipt = {
      code: error?.code ?? "guard-provenance-unavailable",
      reachedClause: error?.reachedClause ?? "unexpected-failure",
      message: error instanceof Error ? error.message : String(error),
    };
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 1;
  }
}
