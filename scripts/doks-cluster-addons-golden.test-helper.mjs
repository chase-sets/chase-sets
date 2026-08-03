import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const originMainRef = "refs/remotes/origin/main";
export const dryRunEnvironments = ["staging", "production"];
export const emptyAllowedNormalizedDeltas = Object.freeze([]);

const dryRunTokenMarker = "do_dry_run_must_not_be_read";
const temporaryBase = realpathSync(resolve("."));
const fixedGitEnvironment = {
  GIT_AUTHOR_NAME: "DOKS golden fixture",
  GIT_AUTHOR_EMAIL: "doks-golden-fixture@invalid.example",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "DOKS golden fixture",
  GIT_COMMITTER_EMAIL: "doks-golden-fixture@invalid.example",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function run(command, args, { cwd, env = process.env, input } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    input,
  });
}

export function runGit(args, cwd, { env = process.env, input } = {}) {
  const result = run("git", args, { cwd, env, input });
  if (result.error || result.status !== 0) {
    throw new Error(
      `doks-golden-fixture-git-command-failed: git ${args.join(" ")} (${result.error?.message ?? result.stderr.trim()})`,
    );
  }
  return result.stdout.trim();
}

function jsonEscapedPath(path) {
  return JSON.stringify(path).slice(1, -1);
}

export function normalizeCheckoutRootOnly(output, repositoryRoot) {
  return output.replaceAll(jsonEscapedPath(repositoryRoot), "<repo>");
}

export function normalizeDryRunOutput(output, repositoryRoot) {
  return normalizeCheckoutRootOnly(output, repositoryRoot).replace(/(^|\s)<repo>\S*/g, (token) =>
    token.replaceAll("\\\\", "/"),
  );
}

function isolatedDryRunEnvironment(repositoryRoot) {
  const env = { ...process.env };
  for (const name of [
    "DIGITALOCEAN_ACCESS_TOKEN",
    "DIGITALOCEAN_TOKEN",
    "DO_TOKEN",
    "SPACES_ACCESS_KEY_ID",
    "SPACES_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ]) {
    delete env[name];
  }
  env.DIGITALOCEAN_ACCESS_TOKEN = dryRunTokenMarker;
  env.KUBECONFIG = join(repositoryRoot, ".doks-dry-run-nonexistent-kubeconfig");
  return env;
}

export function runRealDryRun({ repositoryRoot, environment }) {
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const scriptPath = resolve(realRepositoryRoot, "scripts", "doks-cluster-addons.mjs");
  const result = run(process.execPath, [scriptPath, "--dry-run", "--environment", environment], {
    cwd: realRepositoryRoot,
    env: isolatedDryRunEnvironment(realRepositoryRoot),
  });
  if (result.error || result.status !== 0 || result.stderr !== "") {
    throw new Error(
      `dry-run-cli-failed: ${environment} (${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`})`,
    );
  }
  if (result.stdout.includes(dryRunTokenMarker)) {
    throw new Error(`dry-run-token-leak: ${environment}`);
  }
  return normalizeDryRunOutput(result.stdout, realRepositoryRoot);
}

export function readCommittedGoldens(repositoryRoot) {
  return Object.fromEntries(
    dryRunEnvironments.map((environment) => [
      environment,
      readFileSync(
        resolve(repositoryRoot, "scripts", "fixtures", `doks-cluster-addons.dry-run.${environment}.golden.txt`),
        "utf8",
      ),
    ]),
  );
}

export function applyAllowedNormalizedDeltas(golden, allowlist) {
  return allowlist.reduce((expected, entry) => {
    const { name, decision, goldenFragment, currentFragment } = entry;
    if (
      !name ||
      !decision ||
      !goldenFragment ||
      typeof currentFragment !== "string" ||
      expected.indexOf(goldenFragment) === -1 ||
      expected.indexOf(goldenFragment) !== expected.lastIndexOf(goldenFragment)
    ) {
      throw new Error(`dry-run-allowlist-invalid-entry: ${name || "unnamed"}`);
    }
    return expected.replace(goldenFragment, currentFragment);
  }, golden);
}

export function firstDifferentLine(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    if (expectedLines[index] !== actualLines[index]) return index + 1;
  }
  return 0;
}

export function assertDryRunMatchesGolden({ environment, golden, actual, allowlist = emptyAllowedNormalizedDeltas }) {
  const expected = applyAllowedNormalizedDeltas(golden, allowlist);
  if (actual !== expected) {
    throw new Error(`dry-run-parity-mismatch: ${environment} line ${firstDifferentLine(expected, actual)}`);
  }
}

function assertGitRepository(gitRoot) {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd: gitRoot });
  if (result.error || result.status !== 0 || realpathSync(result.stdout.trim()) !== realpathSync(gitRoot)) {
    throw new Error("golden-provenance-not-a-git-repository");
  }
}

function assertCommitExists(gitRoot, revision, failure) {
  const result = run("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: gitRoot });
  if (result.error || result.status !== 0) throw new Error(failure);
}

function visibleMainHistoryIsTruncated(gitRoot, baseRef) {
  const rootsResult = run("git", ["rev-list", "--max-parents=0", baseRef], { cwd: gitRoot });
  const commonDirResult = run("git", ["rev-parse", "--git-common-dir"], { cwd: gitRoot });
  if (rootsResult.error || rootsResult.status !== 0 || commonDirResult.error || commonDirResult.status !== 0) {
    throw new Error("golden-provenance-ancestry-classification-failed");
  }

  const commonDirOutput = commonDirResult.stdout.trim();
  const commonDir = isAbsolute(commonDirOutput) ? commonDirOutput : resolve(gitRoot, commonDirOutput);
  const shallowPath = join(commonDir, "shallow");
  if (!existsSync(shallowPath)) return false;

  const boundary = new Set(readFileSync(shallowPath, "utf8").split(/\r?\n/).filter(Boolean));
  return rootsResult.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .some((root) => boundary.has(root));
}

function extractCommitTree({ gitRoot, revision, destinationRoot }) {
  const archivePath = join(destinationRoot, "doks-golden-tree.tar");
  const archiveResult = run(
    "git",
    [
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      revision,
      "--",
      "scripts",
      "infrastructure/helm/doks-ingress",
    ],
    { cwd: gitRoot },
  );
  if (archiveResult.error || archiveResult.status !== 0) {
    throw new Error(`golden-provenance-extraction-failed: ${revision}`);
  }
  try {
    const extractResult = run("tar", ["-xf", archivePath, "-C", destinationRoot], { cwd: destinationRoot });
    if (extractResult.error || extractResult.status !== 0) {
      throw new Error(`golden-provenance-extraction-failed: ${revision}`);
    }
  } finally {
    rmSync(archivePath, { force: true });
  }
}

function assertGoldenReconstruction({ gitRoot, provenanceSha, goldens, onReconstructionRoot }) {
  const createdRoot = mkdtempSync(join(temporaryBase, ".doks-golden-reconstruction-"));
  const reconstructionRoot = realpathSync(createdRoot);
  onReconstructionRoot?.(reconstructionRoot);
  try {
    extractCommitTree({ gitRoot, revision: provenanceSha, destinationRoot: reconstructionRoot });
    for (const environment of dryRunEnvironments) {
      const actual = runRealDryRun({ repositoryRoot: reconstructionRoot, environment });
      if (actual !== goldens[environment]) {
        throw new Error(
          `golden-provenance-reconstruction-mismatch: ${environment} line ${firstDifferentLine(
            goldens[environment],
            actual,
          )}`,
        );
      }
    }
  } finally {
    rmSync(reconstructionRoot, { recursive: true, force: true });
  }
}

export function assertGoldenProvenance({
  gitRoot,
  provenanceSha,
  goldens,
  baseRef = originMainRef,
  onReconstructionRoot,
}) {
  assertGitRepository(gitRoot);
  assertCommitExists(gitRoot, baseRef, `golden-provenance-base-ref-missing: ${baseRef}`);
  assertCommitExists(gitRoot, provenanceSha, `golden-provenance-object-does-not-exist: ${provenanceSha}`);

  const ancestry = run("git", ["merge-base", "--is-ancestor", provenanceSha, baseRef], { cwd: gitRoot });
  if (ancestry.error || ![0, 1].includes(ancestry.status)) {
    throw new Error("golden-provenance-ancestry-command-failed");
  }
  if (ancestry.status === 1) {
    if (visibleMainHistoryIsTruncated(gitRoot, baseRef)) {
      throw new Error(`golden-provenance-ancestry-undecidable-shallow: ${provenanceSha} -> ${baseRef}`);
    }
    throw new Error(`golden-provenance-not-an-ancestor: ${provenanceSha} -> ${baseRef}`);
  }

  assertGoldenReconstruction({ gitRoot, provenanceSha, goldens, onReconstructionRoot });
}

export function withTemporaryDirectory(prefix, callback) {
  const temporaryRoot = realpathSync(mkdtempSync(join(temporaryBase, `.${prefix}`)));
  try {
    return callback(temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function fixtureGitEnvironment() {
  return { ...process.env, ...fixedGitEnvironment };
}

export function initializePlannerFixtureRepository({ root, sourceGitRoot, sourceSha, goldens, advanceCount = 0 }) {
  mkdirSync(root, { recursive: true });
  runGit(["init", "--initial-branch=main"], root);
  runGit(["config", "core.autocrlf", "false"], root);
  const sourceObjectsOutput = runGit(["rev-parse", "--git-path", "objects"], sourceGitRoot);
  const sourceObjects = isAbsolute(sourceObjectsOutput)
    ? sourceObjectsOutput
    : resolve(sourceGitRoot, sourceObjectsOutput);
  const alternatesPath = join(root, ".git", "objects", "info", "alternates");
  mkdirSync(dirname(alternatesPath), { recursive: true });
  writeFileSync(alternatesPath, `${sourceObjects.replaceAll("\\", "/")}\n`, "utf8");

  const fixtureIndexEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: join(root, ".git", "doks-golden-fixture.index"),
  };
  runGit(["read-tree", `${sourceSha}^{tree}`], root, { env: fixtureIndexEnvironment });
  for (const environment of dryRunEnvironments) {
    const blob = runGit(["hash-object", "-w", "--stdin"], root, { input: goldens[environment] });
    runGit(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        blob,
        `scripts/fixtures/doks-cluster-addons.dry-run.${environment}.golden.txt`,
      ],
      root,
      { env: fixtureIndexEnvironment },
    );
  }
  const fixtureTree = runGit(["write-tree"], root, { env: fixtureIndexEnvironment });
  const baseSha = runGit(["commit-tree", fixtureTree, "-m", "capture DOKS dry-run goldens"], root, {
    env: fixtureGitEnvironment(),
  });
  runGit(["update-ref", "refs/heads/main", baseSha], root);

  let mainSha = baseSha;
  for (let index = 1; index <= advanceCount; index += 1) {
    mainSha = runGit(
      ["commit-tree", fixtureTree, "-p", mainSha, "-m", `planner-unrelated main advance ${index}`],
      root,
      {
        env: fixtureGitEnvironment(),
      },
    );
  }
  runGit(["update-ref", "refs/heads/main", mainSha], root);
  runGit(["update-ref", originMainRef, mainSha], root);
  runGit(["update-ref", "refs/heads/candidate", mainSha], root);
  runGit(["symbolic-ref", "HEAD", "refs/heads/candidate"], root);
  return { baseSha, mainSha };
}

export function createDanglingCommit(gitRoot, message = "deterministic dangling commit") {
  const emptyTree = runGit(["hash-object", "-t", "tree", "--stdin"], gitRoot, { input: "" });
  return runGit(["commit-tree", emptyTree, "-m", message], gitRoot, { env: fixtureGitEnvironment() });
}

export function withFixtureShallowBoundary(gitRoot, boundarySha, callback) {
  const shallowOutput = runGit(["rev-parse", "--git-path", "shallow"], gitRoot);
  const shallowPath = isAbsolute(shallowOutput) ? shallowOutput : resolve(gitRoot, shallowOutput);
  writeFileSync(shallowPath, `${boundarySha}\n`, "utf8");
  try {
    return callback();
  } finally {
    rmSync(shallowPath, { force: true });
  }
}

export function repositoryGitInventory(gitRoot) {
  return {
    refs: runGit(["for-each-ref", "--format=%(refname) %(objectname)"], gitRoot),
    worktrees: runGit(["worktree", "list", "--porcelain"], gitRoot),
  };
}
