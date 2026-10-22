import { execFile } from "node:child_process";
import path from "node:path";

// Write-free git evaluations of which bytes a staging command executes and
// whether the deployed runtime holds every deployable byte of the intended
// commit. The caller injects the git runner; every call carries
// --no-optional-locks so even `git status` never refreshes the index.

const OBJECT_ID = /^[0-9a-f]{40}$/;
const MAX_PATH_LENGTH = 260;
const MAX_GOVERNED_PATHS = 32;
const MAX_EXECUTED_FILES = MAX_GOVERNED_PATHS + 2;
const ORIGIN_MAIN = "refs/remotes/origin/main";

const READ_INPUT_KEYS = ["cwd", "governedPaths", "head", "runnerPath", "selfPath", "worktree"];
const CLASSIFY_INPUT_KEYS = ["deployedHead", "intendedHead", "worktree"];
const EXECUTED_BYTES_KEYS = ["files", "head", "mergedIntoOriginMain", "porcelainEmpty", "worktreeRoot"];
const EXECUTED_FILE_KEYS = ["committedBlobSha1", "onDiskBlobSha1", "path"];
const COMPATIBILITY_KEYS = ["deployablePathsChanged", "deployedHead", "intendedHead", "relation"];

export const EXECUTED_BYTES_STOPS = Object.freeze([
  "input-invalid",
  "cwd-outside-worktree",
  "head-not-declared",
  "worktree-not-clean",
  "head-not-merged",
  "executed-byte-drift",
  "unexpected-internal-error",
]);

export const DEPLOYED_RUNTIME_STOPS = Object.freeze([
  "input-invalid",
  "deployed-head-unavailable",
  "deployed-runtime-incompatible",
  "deployed-runtime-ahead",
  "unexpected-internal-error",
]);

export const DEPLOYED_RUNTIME_RELATIONS = Object.freeze([
  "identical",
  "deployed-is-ancestor",
  "deployed-is-descendant",
]);

// Every path is deployable except documentation and agent instructions, which
// reach neither the image nor a step the deploy runs from the release
// checkout. Choosing by exclusion keeps a new path deployable by default.
const NON_DEPLOYABLE_PATH = /^(?:(?:docs|\.agents|\.claude)\/|[^/]+\.md$)/;
// The manifests stage's `COPY . .` exports every depth-3 package.json into the
// dependency install, so those stay deployable even under an excluded root.
const DEPTH_THREE_PACKAGE_MANIFEST = /^[^/]+\/[^/]+\/package\.json$/;

class UnexpectedGitResult extends Error {}

export function runGit(argv, { cwd }) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      argv,
      { cwd, shell: false, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (!error) resolve({ exitCode: 0, stdout });
        else if (Number.isInteger(error.code)) resolve({ exitCode: error.code, stdout });
        else reject(error);
      },
    );
  });
}

async function git(runner, worktree, ...argv) {
  const result = await runner(["--no-optional-locks", ...argv], { cwd: worktree });
  const wellFormed =
    result !== null &&
    typeof result === "object" &&
    Number.isInteger(result.exitCode) &&
    typeof result.stdout === "string";
  if (!wellFormed) throw new UnexpectedGitResult(argv[0]);
  return result;
}

async function gitOutput(runner, worktree, ...argv) {
  const { exitCode, stdout } = await git(runner, worktree, ...argv);
  if (exitCode !== 0) throw new UnexpectedGitResult(argv[0]);
  return stdout;
}

function objectId(stdout) {
  const id = stdout.replace(/\r?\n$/, "");
  if (!OBJECT_ID.test(id)) throw new UnexpectedGitResult("object id");
  return id;
}

async function isWorktreeRoot(runner, worktree) {
  const { exitCode, stdout } = await git(runner, worktree, "rev-parse", "--show-toplevel");
  return exitCode === 0 && path.resolve(stdout.replace(/\r?\n$/, "")) === worktree;
}

async function isAncestor(runner, worktree, ancestor, descendant) {
  const { exitCode } = await git(runner, worktree, "merge-base", "--is-ancestor", ancestor, descendant);
  if (exitCode !== 0 && exitCode !== 1) throw new UnexpectedGitResult("merge-base");
  return exitCode === 0;
}

async function isCommit(runner, worktree, commit) {
  return (await git(runner, worktree, "cat-file", "-e", `${commit}^{commit}`)).exitCode === 0;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const own = Object.getOwnPropertyNames(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function isDataArray(value) {
  return (
    Array.isArray(value) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).length === value.length
  );
}

function isObjectId(value) {
  return typeof value === "string" && OBJECT_ID.test(value);
}

function isRoot(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_PATH_LENGTH &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function isRepositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_PATH_LENGTH &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isGovernedPaths(value) {
  return (
    isDataArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_GOVERNED_PATHS &&
    value.every(isRepositoryPath) &&
    new Set(value).size === value.length
  );
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function namedPath(repositoryPath) {
  return repositoryPath.length >= 1 && repositoryPath.length <= MAX_PATH_LENGTH ? repositoryPath : null;
}

function executedPaths({ governedPaths, runnerPath, selfPath }) {
  return [...new Set([...governedPaths, runnerPath, selfPath])].sort();
}

// Porcelain v1 -z lists `XY path`, followed by the source path for a rename or
// copy; the smallest listed path names the refusal.
function firstDirtyPath(porcelain) {
  const entries = porcelain.split("\0");
  const dirty = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].length < 4) continue;
    dirty.push(entries[index].slice(3));
    if (/^(?:[RC].|.[RC])/.test(entries[index])) index += 1;
  }
  return dirty.length > 0 ? namedPath(dirty.sort()[0]) : null;
}

function isDeployablePath(repositoryPath) {
  if (DEPTH_THREE_PACKAGE_MANIFEST.test(repositoryPath)) return true;
  return !NON_DEPLOYABLE_PATH.test(repositoryPath);
}

function refused(stop, refusedPath) {
  return Object.freeze({ outcome: "refused", stop, path: refusedPath });
}

function failed(stop, failedPath) {
  return Object.freeze({ outcome: "failed", stop, path: failedPath });
}

export async function readExecutedBytes(input, runner) {
  try {
    return await readDeclaredExecutedBytes(input, runner);
  } catch {
    return refused("unexpected-internal-error", null);
  }
}

async function readDeclaredExecutedBytes(input, runner) {
  if (typeof runner !== "function" || !hasExactKeys(input, READ_INPUT_KEYS)) return refused("input-invalid", null);
  const { worktree, cwd, head } = input;
  if (!isRoot(worktree) || !isRoot(cwd) || !isObjectId(head)) return refused("input-invalid", null);
  if (
    !isGovernedPaths(input.governedPaths) ||
    !isRepositoryPath(input.runnerPath) ||
    !isRepositoryPath(input.selfPath)
  ) {
    return refused("input-invalid", null);
  }

  if (!(await isWorktreeRoot(runner, worktree))) return refused("input-invalid", null);
  if (!isWithin(worktree, cwd)) return refused("cwd-outside-worktree", null);

  const declared = await git(runner, worktree, "rev-parse", "--verify", "--quiet", "HEAD");
  if (declared.exitCode > 1) throw new UnexpectedGitResult("rev-parse");
  if (declared.exitCode === 1 || objectId(declared.stdout) !== head) return refused("head-not-declared", null);

  // Ignored files stay ignored; every tracked change and untracked file refuses.
  const porcelain = await gitOutput(runner, worktree, "status", "--porcelain=v1", "--untracked-files=normal", "-z");
  if (porcelain !== "") return refused("worktree-not-clean", firstDirtyPath(porcelain));

  // A stale origin/main refuses; fetching it would be a git write.
  if (!(await isAncestor(runner, worktree, head, ORIGIN_MAIN))) return refused("head-not-merged", null);

  const paths = executedPaths(input);
  const committed = [];
  for (const repositoryPath of paths) {
    const resolved = await git(runner, worktree, "rev-parse", "--verify", "--quiet", `${head}:${repositoryPath}`);
    if (resolved.exitCode === 1) return refused("input-invalid", repositoryPath);
    if (resolved.exitCode !== 0) throw new UnexpectedGitResult("rev-parse");
    committed.push(objectId(resolved.stdout));
  }

  // The committed tree cannot prove what runs: skip-worktree, assume-unchanged
  // and checkin filters all hide on-disk bytes from `git status`. The raw
  // on-disk bytes are hashed instead, and a path that cannot be hashed as a
  // file is drift as well.
  const files = [];
  for (const [index, repositoryPath] of paths.entries()) {
    const hashed = await git(runner, worktree, "hash-object", "--no-filters", "--", repositoryPath);
    const onDiskBlobSha1 = hashed.exitCode === 0 ? objectId(hashed.stdout) : null;
    if (onDiskBlobSha1 !== committed[index]) return refused("executed-byte-drift", repositoryPath);
    files.push(Object.freeze({ path: repositoryPath, committedBlobSha1: committed[index], onDiskBlobSha1 }));
  }

  const executedBytes = Object.freeze({
    head,
    porcelainEmpty: true,
    mergedIntoOriginMain: true,
    worktreeRoot: worktree,
    files: Object.freeze(files),
  });
  if (validateExecutedBytes(executedBytes, input).length > 0) throw new UnexpectedGitResult("executed bytes");
  return Object.freeze({ outcome: "ok", executedBytes });
}

export async function classifyDeployedRuntime(input, runner) {
  try {
    return await classifyDeclaredRuntime(input, runner);
  } catch {
    return failed("unexpected-internal-error", null);
  }
}

async function classifyDeclaredRuntime(input, runner) {
  if (typeof runner !== "function" || !hasExactKeys(input, CLASSIFY_INPUT_KEYS)) return failed("input-invalid", null);
  const { worktree, intendedHead, deployedHead } = input;
  if (!isRoot(worktree) || !isObjectId(intendedHead) || !isObjectId(deployedHead)) return failed("input-invalid", null);

  if (!(await isWorktreeRoot(runner, worktree))) return failed("input-invalid", null);
  if (!(await isCommit(runner, worktree, deployedHead))) return failed("deployed-head-unavailable", null);
  if (!(await isCommit(runner, worktree, intendedHead))) return failed("input-invalid", null);

  const relation = await relationOf(runner, worktree, intendedHead, deployedHead);
  if (relation === null) return failed("deployed-runtime-incompatible", null);
  if (relation !== "identical") {
    const changed = await deployablePathsBetween(runner, worktree, deployedHead, intendedHead);
    if (changed.length > 0) {
      const stop = relation === "deployed-is-ancestor" ? "deployed-runtime-incompatible" : "deployed-runtime-ahead";
      return failed(stop, namedPath(changed[0]));
    }
  }

  const compatibility = Object.freeze({ intendedHead, deployedHead, relation, deployablePathsChanged: 0 });
  if (validateCompatibility(compatibility).length > 0) throw new UnexpectedGitResult("compatibility");
  return Object.freeze({ outcome: "ok", compatibility });
}

async function relationOf(runner, worktree, intendedHead, deployedHead) {
  if (deployedHead === intendedHead) return "identical";
  if (await isAncestor(runner, worktree, deployedHead, intendedHead)) return "deployed-is-ancestor";
  if (await isAncestor(runner, worktree, intendedHead, deployedHead)) return "deployed-is-descendant";
  return null;
}

// Without --no-renames a move out of a deployable path lists only its new,
// possibly excluded, name.
async function deployablePathsBetween(runner, worktree, from, to) {
  const changed = await gitOutput(
    runner,
    worktree,
    "diff",
    "--name-only",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    from,
    to,
    "--",
  );
  return changed
    .split("\0")
    .filter((repositoryPath) => repositoryPath !== "" && isDeployablePath(repositoryPath))
    .sort();
}

export function validateExecutedBytes(executedBytes, { governedPaths, runnerPath, selfPath }) {
  if (!isGovernedPaths(governedPaths) || !isRepositoryPath(runnerPath) || !isRepositoryPath(selfPath)) {
    return ["declared-paths"];
  }
  if (!hasExactKeys(executedBytes, EXECUTED_BYTES_KEYS)) return ["executed-bytes-keys"];
  const errors = new Set();
  if (!isObjectId(executedBytes.head)) errors.add("head");
  if (executedBytes.porcelainEmpty !== true) errors.add("porcelain-empty");
  if (executedBytes.mergedIntoOriginMain !== true) errors.add("merged-into-origin-main");
  if (!isRoot(executedBytes.worktreeRoot)) errors.add("worktree-root");

  const { files } = executedBytes;
  if (!isDataArray(files) || files.length < 1 || files.length > MAX_EXECUTED_FILES) return [...errors, "files-count"];
  const listed = [];
  for (const file of files) {
    if (!hasExactKeys(file, EXECUTED_FILE_KEYS)) {
      errors.add("file-keys");
      continue;
    }
    if (!isRepositoryPath(file.path)) errors.add("file-path");
    if (!isObjectId(file.committedBlobSha1)) errors.add("file-committed-blob");
    if (!isObjectId(file.onDiskBlobSha1)) errors.add("file-on-disk-blob");
    if (file.committedBlobSha1 !== file.onDiskBlobSha1) errors.add("file-blobs-unequal");
    listed.push(file.path);
  }
  for (let index = 1; index < listed.length; index += 1) {
    if (listed[index - 1] === listed[index]) errors.add("files-duplicate");
    else if (String(listed[index - 1]) > String(listed[index])) errors.add("files-unsorted");
  }
  const expected = executedPaths({ governedPaths, runnerPath, selfPath });
  const present = new Set(listed);
  if (present.size !== expected.length || expected.some((expectedPath) => !present.has(expectedPath))) {
    errors.add("files-set");
  }
  return [...errors];
}

export function validateCompatibility(compatibility) {
  if (!hasExactKeys(compatibility, COMPATIBILITY_KEYS)) return ["compatibility-keys"];
  const errors = [];
  if (!isObjectId(compatibility.intendedHead)) errors.push("intended-head");
  if (!isObjectId(compatibility.deployedHead)) errors.push("deployed-head");
  if (!DEPLOYED_RUNTIME_RELATIONS.includes(compatibility.relation)) errors.push("relation");
  else if ((compatibility.relation === "identical") !== (compatibility.intendedHead === compatibility.deployedHead)) {
    errors.push("relation-heads");
  }
  if (compatibility.deployablePathsChanged !== 0) errors.push("deployable-paths-changed");
  return errors;
}
