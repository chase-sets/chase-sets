import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "./lib/repo.mjs";
import {
  classifyDeployedRuntime,
  DEPLOYED_RUNTIME_RELATIONS,
  DEPLOYED_RUNTIME_STOPS,
  EXECUTED_BYTES_STOPS,
  readExecutedBytes,
  runGit,
  validateCompatibility,
  validateExecutedBytes,
} from "./staging-executed-bytes.mjs";

const temporaryDirectories = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

// Test-side git builds the temporary fixtures; only the module under test is
// held to the write-free contract.
function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input });
}

const FIXTURE_GIT_CONFIG = [
  "[user]",
  "\tname = Executed Bytes",
  "\temail = executed-bytes@example.test",
  "[commit]",
  "\tgpgsign = false",
  "[core]",
  "\tautocrlf = false",
  "",
].join("\n");

function initRepository(prefix) {
  const root = temporaryDirectory(prefix);
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  appendFileSync(path.join(root, ".git", "config"), FIXTURE_GIT_CONFIG);
  return root;
}

function writeFiles(root, files) {
  for (const [repositoryPath, content] of Object.entries(files)) {
    const target = path.join(root, ...repositoryPath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--no-verify", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

const WORKING_FILES = Object.freeze({
  ".gitignore": "ignored.log\n",
  "scripts/governed-a.mjs": "export const governedA = 1;\n",
  "scripts/governed-b.mjs": "export const governedB = 2;\n",
  "scripts/runner.mjs": "export const runner = true;\n",
  "scripts/staging-executed-bytes.mjs": "export const self = true;\n",
  "src/other.mjs": "export const other = true;\n",
  "sub/dir/file.txt": "nested\n",
});

function createWorkingRepository(extraFiles = {}) {
  const root = initRepository("staging-executed-bytes-");
  writeFiles(root, { ...WORKING_FILES, ...extraFiles });
  const head = commitAll(root, "base");
  git(root, ["update-ref", "refs/remotes/origin/main", head]);
  return { root, head };
}

function executedInput(repository, overrides = {}) {
  return {
    worktree: repository.root,
    cwd: repository.root,
    head: repository.head,
    governedPaths: ["scripts/governed-b.mjs", "scripts/governed-a.mjs"],
    runnerPath: "scripts/runner.mjs",
    selfPath: "scripts/staging-executed-bytes.mjs",
    ...overrides,
  };
}

// Rewrites a tracked file behind skip-worktree, so `git status` and the
// committed tree both stay clean while the executed bytes change.
function driftBehindCleanTree(repository, repositoryPath, content) {
  git(repository.root, ["update-index", "--skip-worktree", "--", repositoryPath]);
  writeFiles(repository.root, { [repositoryPath]: content });
}

// A child commit with the head's own tree, written without touching the index.
function descendantOf({ root, head }) {
  const tree = git(root, ["rev-parse", `${head}^{tree}`]).trim();
  return git(root, ["commit-tree", tree, "-p", head, "-m", "next"]).trim();
}

function blobSha1(content) {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const sourcePath = path.join(repoRoot, "scripts", "staging-executed-bytes.mjs");

// Each named mutant replaces exactly one source span of the module and loads
// the result as its own module, so a control that kills it proves the clause
// it removes is enforced.
async function loadMutant([name, find, replacement]) {
  const source = readFileSync(sourcePath, "utf8");
  const occurrences = source.split(find).length - 1;
  if (occurrences !== 1) throw new Error(`mutant ${name} must match exactly once; matched ${occurrences} times`);
  const file = path.join(temporaryDirectory("staging-executed-bytes-mutant-"), `${name}.mjs`);
  writeFileSync(
    file,
    source.replace(find, () => replacement),
  );
  return import(pathToFileURL(file).href);
}

function refused(stop, refusedPath = null) {
  return { outcome: "refused", stop, path: refusedPath };
}

function failed(stop, failedPath = null) {
  return { outcome: "failed", stop, path: failedPath };
}

describe("readExecutedBytes", () => {
  it("returns the exact executed bytes of a clean head merged into origin/main", async () => {
    const repository = createWorkingRepository();
    const result = await readExecutedBytes(executedInput(repository), runGit);
    const file = (repositoryPath) => ({
      path: repositoryPath,
      committedBlobSha1: blobSha1(WORKING_FILES[repositoryPath]),
      onDiskBlobSha1: blobSha1(WORKING_FILES[repositoryPath]),
    });
    expect(result).toEqual({
      outcome: "ok",
      executedBytes: {
        head: repository.head,
        porcelainEmpty: true,
        mergedIntoOriginMain: true,
        worktreeRoot: repository.root,
        files: [
          file("scripts/governed-a.mjs"),
          file("scripts/governed-b.mjs"),
          file("scripts/runner.mjs"),
          file("scripts/staging-executed-bytes.mjs"),
        ],
      },
    });
    expect(validateExecutedBytes(result.executedBytes, executedInput(repository))).toEqual([]);

    git(repository.root, ["update-ref", "refs/remotes/origin/main", descendantOf(repository)]);
    expect(await readExecutedBytes(executedInput(repository), runGit)).toEqual(result);
  });
});

const executedByteClauses = [
  {
    clause: "the worktree is the repository top level",
    mutant: [
      "toplevel-unchecked",
      'if (!(await isWorktreeRoot(runner, worktree))) return refused("input-invalid", null);',
      "",
    ],
    green: () => ({}),
    red: ({ root }) => ({ worktree: path.join(root, "sub"), cwd: path.join(root, "sub") }),
    refusal: refused("input-invalid"),
  },
  {
    clause: "the worktree contains cwd",
    mutant: ["cwd-unchecked", 'if (!isWithin(worktree, cwd)) return refused("cwd-outside-worktree", null);', ""],
    green: ({ root }) => ({ cwd: path.join(root, "sub", "dir") }),
    red: ({ root }) => ({ cwd: path.dirname(root) }),
    refusal: refused("cwd-outside-worktree"),
  },
  {
    clause: "HEAD is the declared head",
    mutant: [
      "head-unchecked",
      'if (declared.exitCode === 1 || objectId(declared.stdout) !== head) return refused("head-not-declared", null);',
      "",
    ],
    green: () => ({}),
    red: (repository) => {
      writeFiles(repository.root, { "src/other.mjs": "export const other = false;\n" });
      git(repository.root, ["update-ref", "refs/remotes/origin/main", commitAll(repository.root, "advance")]);
      return { head: repository.head };
    },
    refusal: refused("head-not-declared"),
  },
  {
    clause: "no tracked file is modified",
    mutant: [
      "tracked-changes-ignored",
      'if (porcelain !== "") return refused("worktree-not-clean", firstDirtyPath(porcelain));',
      "",
    ],
    green: ({ root }) => {
      const future = new Date(Date.now() + 60_000);
      utimesSync(path.join(root, "src", "other.mjs"), future, future);
      return {};
    },
    red: ({ root }) => {
      writeFiles(root, { "src/other.mjs": "export const other = false;\n" });
      return {};
    },
    refusal: refused("worktree-not-clean", "src/other.mjs"),
  },
  {
    clause: "no untracked file is present",
    mutant: ["untracked-files-ignored", '"--untracked-files=normal"', '"--untracked-files=no"'],
    green: ({ root }) => {
      writeFiles(root, { "ignored.log": "ignored files stay ignored\n" });
      return {};
    },
    red: ({ root }) => {
      writeFiles(root, { "untracked.txt": "untracked\n" });
      return {};
    },
    refusal: refused("worktree-not-clean", "untracked.txt"),
  },
  {
    clause: "the head is merged into origin/main",
    mutant: [
      "merge-ancestry-reversed",
      "isAncestor(runner, worktree, head, ORIGIN_MAIN)",
      "isAncestor(runner, worktree, ORIGIN_MAIN, head)",
    ],
    green: () => ({}),
    red: (repository) => {
      writeFiles(repository.root, { "src/other.mjs": "export const other = false;\n" });
      return { head: commitAll(repository.root, "unmerged") };
    },
    refusal: refused("head-not-merged"),
  },
  {
    clause: "each governed file's on-disk bytes equal its committed blob",
    mutant: [
      "tree-only-comparator",
      '"hash-object", "--no-filters", "--", repositoryPath',
      '"rev-parse", `${head}:${repositoryPath}`',
    ],
    green: (repository) => {
      driftBehindCleanTree(repository, "scripts/governed-a.mjs", WORKING_FILES["scripts/governed-a.mjs"]);
      return {};
    },
    red: (repository) => {
      driftBehindCleanTree(repository, "scripts/governed-a.mjs", "export const governedA = 'drifted';\n");
      return {};
    },
    refusal: refused("executed-byte-drift", "scripts/governed-a.mjs"),
  },
  {
    clause: "the runner file's on-disk bytes equal its committed blob",
    mutant: ["runner-omitted", "[...governedPaths, runnerPath, selfPath]", "[...governedPaths, selfPath]"],
    green: () => ({}),
    red: (repository) => {
      driftBehindCleanTree(repository, "scripts/runner.mjs", "export const runner = 'drifted';\n");
      return {};
    },
    refusal: refused("executed-byte-drift", "scripts/runner.mjs"),
  },
  {
    clause: "the self file's on-disk bytes equal its committed blob",
    mutant: ["self-omitted", "[...governedPaths, runnerPath, selfPath]", "[...governedPaths, runnerPath]"],
    green: () => ({}),
    red: (repository) => {
      driftBehindCleanTree(repository, "scripts/staging-executed-bytes.mjs", "export const self = 'drifted';\n");
      return {};
    },
    refusal: refused("executed-byte-drift", "scripts/staging-executed-bytes.mjs"),
  },
  {
    clause: "on-disk bytes are hashed without checkin filters",
    mutant: ["checkin-filters-applied", '"--no-filters", ', ""],
    extraFiles: { ".gitattributes": "* text=auto eol=lf\n" },
    green: (repository) => {
      driftBehindCleanTree(repository, "scripts/governed-a.mjs", WORKING_FILES["scripts/governed-a.mjs"]);
      return {};
    },
    red: (repository) => {
      driftBehindCleanTree(repository, "scripts/governed-a.mjs", "export const governedA = 1;\r\n");
      return {};
    },
    refusal: refused("executed-byte-drift", "scripts/governed-a.mjs"),
  },
  {
    clause: "every executed path exists at the declared head",
    mutant: [
      "absent-path-accepted",
      'if (resolved.exitCode === 1) return refused("input-invalid", repositoryPath);',
      "",
    ],
    green: () => ({}),
    red: () => ({ governedPaths: ["scripts/governed-a.mjs", "scripts/missing.mjs"] }),
    refusal: refused("input-invalid", "scripts/missing.mjs"),
  },
  {
    clause: "the input is closed",
    mutant: ["input-keys-open", "hasExactKeys(input, READ_INPUT_KEYS)", "isPlainRecord(input)"],
    green: () => ({}),
    red: () => ({ governedRoot: "scripts" }),
    refusal: refused("input-invalid"),
  },
];

describe("refuses each executed-byte clause", () => {
  it.each(executedByteClauses)(
    "$clause, and its $mutant.0 mutant passes the green control but not the red one",
    async ({ mutant, extraFiles, green, red, refusal }) => {
      const greenRepository = createWorkingRepository(extraFiles);
      const greenInput = executedInput(greenRepository, green(greenRepository));
      const redRepository = createWorkingRepository(extraFiles);
      const redInput = executedInput(redRepository, red(redRepository));

      expect(await readExecutedBytes(greenInput, runGit)).toMatchObject({ outcome: "ok" });
      expect(await readExecutedBytes(redInput, runGit)).toEqual(refusal);

      const mutated = await loadMutant(mutant);
      expect(await mutated.readExecutedBytes(greenInput, runGit)).toMatchObject({ outcome: "ok" });
      expect(await mutated.readExecutedBytes(redInput, runGit)).not.toEqual(refusal);
    },
  );

  it("exports exactly the stops its controls exercise", () => {
    const exercised = new Set([...executedByteClauses.map(({ refusal }) => refusal.stop), "unexpected-internal-error"]);
    expect(new Set(EXECUTED_BYTES_STOPS)).toEqual(exercised);
  });

  it("refuses malformed or defaulted input before any git read", async () => {
    const repository = createWorkingRepository();
    const valid = executedInput(repository);
    const calls = [];
    const recording = (argv, options) => {
      calls.push(argv);
      return runGit(argv, options);
    };
    const withoutKey = (key) => Object.fromEntries(Object.entries(valid).filter(([candidate]) => candidate !== key));
    const malformed = [
      ...Object.keys(valid).map(withoutKey),
      { ...valid, worktree: path.basename(repository.root) },
      { ...valid, worktree: `${repository.root}${path.sep}` },
      { ...valid, cwd: "sub" },
      { ...valid, head: repository.head.toUpperCase() },
      { ...valid, head: repository.head.slice(0, 39) },
      { ...valid, head: [repository.head] },
      { ...valid, governedPaths: [] },
      { ...valid, governedPaths: Array.from({ length: 33 }, (_, index) => `scripts/governed-${index}.mjs`) },
      { ...valid, governedPaths: ["scripts/governed-a.mjs", "scripts/governed-a.mjs"] },
      { ...valid, governedPaths: "scripts/governed-a.mjs" },
      ...[
        "/scripts/runner.mjs",
        "scripts/../runner.mjs",
        "scripts\\runner.mjs",
        "scripts//runner.mjs",
        "scripts/",
        ".",
        "",
      ].map((runnerPath) => ({ ...valid, runnerPath })),
      { ...valid, selfPath: `scripts/${"x".repeat(260)}.mjs` },
      null,
      [valid],
    ];
    for (const input of malformed) {
      expect(await readExecutedBytes(input, recording)).toEqual(refused("input-invalid"));
    }
    expect(await readExecutedBytes(valid, undefined)).toEqual(refused("input-invalid"));
    expect(calls).toEqual([]);
  });

  it("refuses a failing or malformed git runner as an unexpected internal error", async () => {
    const repository = createWorkingRepository();
    const throwing = () => Promise.reject(new Error("spawn git ENOENT"));
    const malformed = () => Promise.resolve({ exitCode: "0", stdout: "" });
    expect(await readExecutedBytes(executedInput(repository), throwing)).toEqual(refused("unexpected-internal-error"));
    expect(await readExecutedBytes(executedInput(repository), malformed)).toEqual(refused("unexpected-internal-error"));
  });
});

const ALLOWED_GIT_SUBCOMMANDS = ["rev-parse", "status", "merge-base", "hash-object", "cat-file", "diff"];

function indexState(root) {
  const index = path.join(root, ".git", "index");
  return { bytes: readFileSync(index).toString("base64"), mtimeNs: statSync(index, { bigint: true }).mtimeNs };
}

// A modified file makes the run refuse, and a touched-but-identical file is a
// stat change that any locking `git status` refreshes into the index; the
// index's mtime is moved into the past so any rewrite is visible.
function dirtyRepositoryWithStaleIndex() {
  const repository = createWorkingRepository();
  writeFiles(repository.root, { "src/other.mjs": "export const other = 'dirty';\n" });
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(repository.root, "scripts", "governed-b.mjs"), future, future);
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(repository.root, ".git", "index"), past, past);
  return repository;
}

function recordingRunner(calls) {
  return (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd });
    return runGit(argv, options);
  };
}

describe("never writes git state", () => {
  it("records only lock-free allowed reads and leaves the index bytes and mtime unchanged", async () => {
    const repository = dirtyRepositoryWithStaleIndex();
    const next = descendantOf(repository);
    const before = indexState(repository.root);
    const calls = [];
    const recording = recordingRunner(calls);

    expect(await readExecutedBytes(executedInput(repository), recording)).toEqual(
      refused("worktree-not-clean", "src/other.mjs"),
    );
    expect(indexState(repository.root)).toEqual(before);

    writeFiles(repository.root, { "src/other.mjs": WORKING_FILES["src/other.mjs"] });
    expect(await readExecutedBytes(executedInput(repository), recording)).toMatchObject({ outcome: "ok" });
    expect(
      await classifyDeployedRuntime(
        { worktree: repository.root, intendedHead: next, deployedHead: repository.head },
        recording,
      ),
    ).toMatchObject({ outcome: "ok", compatibility: { relation: "deployed-is-ancestor" } });
    expect(indexState(repository.root)).toEqual(before);

    for (const { argv, cwd } of calls) {
      expect(cwd).toBe(repository.root);
      expect(argv[0]).toBe("--no-optional-locks");
      expect(ALLOWED_GIT_SUBCOMMANDS).toContain(argv[1]);
      expect(argv).not.toContain("-w");
      if (argv[1] === "merge-base") expect(argv).toContain("--is-ancestor");
      if (argv[1] === "cat-file") expect(argv).toContain("-e");
      if (argv[1] === "diff") expect(argv).toContain("--name-only");
    }
    expect(new Set(calls.map(({ argv }) => argv[1]))).toEqual(new Set(ALLOWED_GIT_SUBCOMMANDS));
  });

  it("is red for the optional-locks-dropping mutant, whose status rewrites the index", async () => {
    const repository = dirtyRepositoryWithStaleIndex();
    const before = indexState(repository.root);
    const calls = [];
    const mutated = await loadMutant(["optional-locks-dropped", '["--no-optional-locks", ...argv]', "[...argv]"]);

    expect(await mutated.readExecutedBytes(executedInput(repository), recordingRunner(calls))).toEqual(
      refused("worktree-not-clean", "src/other.mjs"),
    );
    expect(indexState(repository.root).mtimeNs).not.toBe(before.mtimeNs);
    expect(calls.some(({ argv }) => argv[0] !== "--no-optional-locks")).toBe(true);
  });
});

function fastImportData(text) {
  return `data ${Buffer.byteLength(text)}\n${text}`;
}

// Builds commits straight into the object store: each names an earlier
// commit's index as its parent (null only for the first) and maps paths to
// new content, or to null to delete them.
function importCommits(root, commits) {
  const marks = path.join(temporaryDirectory("staging-executed-bytes-marks-"), "marks");
  const stream = commits
    .map(({ parent, files }, index) =>
      [
        "commit refs/heads/fixture",
        `mark :${index + 1}`,
        "committer Executed Bytes <executed-bytes@example.test> 1700000000 +0000",
        fastImportData(`fixture ${index}\n`),
        ...(parent === null ? [] : [`from :${parent + 1}`]),
        ...Object.entries(files).map(([filePath, content]) =>
          content === null ? `D ${filePath}` : `M 100644 inline ${filePath}\n${fastImportData(content)}`,
        ),
      ].join("\n"),
    )
    .join("\n");
  git(root, ["fast-import", "--quiet", `--export-marks=${marks}`], `${stream}\n`);
  const shas = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ")),
  );
  return commits.map((_, index) => shas.get(`:${index + 1}`));
}

const ABSENT_COMMIT = "0123456789abcdef0123456789abcdef01234567";

const AC03_INCOMPATIBLE_PATHS = [
  "bounded-contexts/x.ts",
  "tsconfig.base.json",
  "scripts/workspace-source-aliases.mjs",
  "scripts/lib/repo.mjs",
  ".github/actions/x/action.yml",
  "docs/x/package.json",
  "tools/x.mjs",
];

// Deployable paths a narrower set would drop: .dockerignore subtracts
// infrastructure/digitalocean, where terraform runs from the release checkout,
// and only a root-level *.md is excluded, so scripts/README.md still ships.
const EXTRA_DEPLOYABLE_PATHS = ["infrastructure/digitalocean/platform/main.tf", "scripts/README.md"];

const MOVED_SOURCE = "export const moved = [\n  'rename detection needs content',\n  'that survives the move',\n];\n";

function relationFixture() {
  const root = initRepository("staging-executed-bytes-relations-");
  mkdirSync(path.join(root, "sub"));
  const named = [
    ["base", null, { "README.md": "# Fixture\n", "docs/guide.md": "guide\n", "scripts/moved.mjs": MOVED_SOURCE }],
    ["docs-only", 0, { "docs/guide.md": "guide v2\n" }],
    ["readme-only", 0, { "README.md": "# Fixture v2\n" }],
    ...[...AC03_INCOMPATIBLE_PATHS, ...EXTRA_DEPLOYABLE_PATHS].map((changed) => [
      changed,
      0,
      { [changed]: "changed\n" },
    ]),
    ["several", 0, { "tools/z.mjs": "z\n", "bounded-contexts/a.ts": "a\n", "docs/q.md": "q\n" }],
    ["rename", 0, { "scripts/moved.mjs": null, "docs/moved.mjs": MOVED_SOURCE }],
    ["ahead-deployable", 0, { "scripts/ahead.mjs": "ahead\n" }],
    ["ahead-docs", 0, { "docs/ahead.md": "ahead\n" }],
    ["left", 0, { "docs/left.md": "left\n" }],
    ["right", 0, { "docs/right.md": "right\n" }],
  ];
  const shas = importCommits(
    root,
    named.map(([, parent, files]) => ({ parent, files })),
  );
  return { root, commits: Object.fromEntries(named.map(([name], index) => [name, shas[index]])) };
}

function relationCases({ root, commits }) {
  const ok = (intendedHead, deployedHead, relation) => ({
    input: { worktree: root, intendedHead, deployedHead },
    expected: { outcome: "ok", compatibility: { intendedHead, deployedHead, relation, deployablePathsChanged: 0 } },
  });
  const refusedWith = (intendedHead, deployedHead, expected, worktree = root) => ({
    input: { worktree, intendedHead, deployedHead },
    expected,
  });
  return {
    identical: ok(commits.base, commits.base, "identical"),
    "docs-only ancestor": ok(commits["docs-only"], commits.base, "deployed-is-ancestor"),
    "root README.md-only ancestor": ok(commits["readme-only"], commits.base, "deployed-is-ancestor"),
    ...Object.fromEntries(
      [...AC03_INCOMPATIBLE_PATHS, ...EXTRA_DEPLOYABLE_PATHS].map((changed) => [
        changed,
        refusedWith(commits[changed], commits.base, failed("deployed-runtime-incompatible", changed)),
      ]),
    ),
    "first sorted deployable path": refusedWith(
      commits.several,
      commits.base,
      failed("deployed-runtime-incompatible", "bounded-contexts/a.ts"),
    ),
    "rename into docs": refusedWith(
      commits.rename,
      commits.base,
      failed("deployed-runtime-incompatible", "scripts/moved.mjs"),
    ),
    "deployable change ahead": refusedWith(
      commits.base,
      commits["ahead-deployable"],
      failed("deployed-runtime-ahead", "scripts/ahead.mjs"),
    ),
    "docs-only descendant": ok(commits.base, commits["ahead-docs"], "deployed-is-descendant"),
    diverged: refusedWith(commits.left, commits.right, failed("deployed-runtime-incompatible")),
    "absent deployed head": refusedWith(commits.base, ABSENT_COMMIT, failed("deployed-head-unavailable")),
    "absent intended head": refusedWith(ABSENT_COMMIT, commits.base, failed("input-invalid")),
    "worktree below the top level": refusedWith(
      commits.base,
      commits.base,
      failed("input-invalid"),
      path.join(root, "sub"),
    ),
  };
}

const relationMutants = [
  {
    mutant: [
      "classify-toplevel-unchecked",
      'if (!(await isWorktreeRoot(runner, worktree))) return failed("input-invalid", null);',
      "",
    ],
    kills: ["worktree below the top level"],
    keeps: ["identical"],
  },
  {
    mutant: [
      "deployed-head-unchecked",
      'if (!(await isCommit(runner, worktree, deployedHead))) return failed("deployed-head-unavailable", null);',
      "",
    ],
    kills: ["absent deployed head"],
    keeps: ["docs-only ancestor"],
  },
  {
    mutant: [
      "intended-head-unchecked",
      'if (!(await isCommit(runner, worktree, intendedHead))) return failed("input-invalid", null);',
      "",
    ],
    kills: ["absent intended head"],
    keeps: ["docs-only ancestor"],
  },
  {
    mutant: ["identical-as-ancestor", 'if (deployedHead === intendedHead) return "identical";', ""],
    kills: ["identical"],
    keeps: ["docs-only ancestor"],
  },
  {
    mutant: [
      "is-ancestor-reversed",
      "isAncestor(runner, worktree, deployedHead, intendedHead)",
      "isAncestor(runner, worktree, intendedHead, deployedHead)",
    ],
    kills: ["docs-only ancestor", "bounded-contexts/x.ts", "deployable change ahead", "docs-only descendant"],
    keeps: ["identical"],
  },
  {
    mutant: [
      "diverged-as-ancestor",
      'return "deployed-is-descendant";\n  return null;',
      'return "deployed-is-descendant";\n  return "deployed-is-ancestor";',
    ],
    kills: ["diverged"],
    keeps: ["identical", "docs-only ancestor"],
  },
  {
    mutant: [
      "include-list",
      "return !NON_DEPLOYABLE_PATH.test(repositoryPath);",
      "return /^(?:bounded-contexts|contracts|deployables|infrastructure|packages|scripts)\\//.test(repositoryPath);",
    ],
    kills: ["tsconfig.base.json", ".github/actions/x/action.yml", "tools/x.mjs"],
    keeps: ["bounded-contexts/x.ts", "docs-only ancestor"],
  },
  {
    mutant: ["depth-three-manifest-dropped", "if (DEPTH_THREE_PACKAGE_MANIFEST.test(repositoryPath)) return true;", ""],
    kills: ["docs/x/package.json"],
    keeps: ["bounded-contexts/x.ts", "docs-only ancestor"],
  },
  {
    mutant: [
      "dockerignore-subtracted",
      "(?:docs|\\.agents|\\.claude)\\/",
      "(?:docs|\\.agents|\\.claude|\\.github|infrastructure\\/digitalocean)\\/",
    ],
    kills: [".github/actions/x/action.yml", "infrastructure/digitalocean/platform/main.tf"],
    keeps: ["bounded-contexts/x.ts", "docs-only ancestor"],
  },
  {
    mutant: ["every-markdown-excluded", "|[^/]+\\.md$)/;", "|.*\\.md$)/;"],
    kills: ["scripts/README.md"],
    keeps: ["root README.md-only ancestor", "bounded-contexts/x.ts"],
  },
  {
    mutant: ["exclusions-dropped", "return !NON_DEPLOYABLE_PATH.test(repositoryPath);", "return true;"],
    kills: ["docs-only ancestor", "root README.md-only ancestor", "docs-only descendant"],
    keeps: ["bounded-contexts/x.ts", "identical", "diverged"],
  },
  {
    mutant: ["renames-detected", '"--no-renames"', '"--find-renames"'],
    kills: ["rename into docs"],
    keeps: ["docs-only ancestor", "bounded-contexts/x.ts"],
  },
];

describe("classifies the deployed head relation", () => {
  let cases;

  beforeAll(() => {
    cases = relationCases(relationFixture());
  });

  const classifyEach = (classify, names) =>
    Promise.all(names.map(async (name) => ({ name, result: await classify(cases[name].input, runGit) })));
  const expectedEach = (names) => names.map((name) => ({ name, result: cases[name].expected }));

  it("returns each relation, deployable path and stop on real temporary history", async () => {
    const names = Object.keys(cases);
    expect(await classifyEach(classifyDeployedRuntime, names)).toEqual(expectedEach(names));
  });

  it("exports exactly the stops and relations its cases exercise", () => {
    const expected = Object.values(cases).map((relationCase) => relationCase.expected);
    const stops = new Set([...expected.flatMap(({ stop }) => stop ?? []), "unexpected-internal-error"]);
    expect(new Set(DEPLOYED_RUNTIME_STOPS)).toEqual(stops);
    expect(new Set(DEPLOYED_RUNTIME_RELATIONS)).toEqual(
      new Set(expected.flatMap(({ compatibility }) => compatibility?.relation ?? [])),
    );
  });

  it.each(relationMutants)("is red for the $mutant.0 mutant", async ({ mutant, kills, keeps }) => {
    const mutated = await loadMutant(mutant);
    expect(await classifyEach(mutated.classifyDeployedRuntime, keeps)).toEqual(expectedEach(keeps));
    const killed = await classifyEach(mutated.classifyDeployedRuntime, kills);
    killed.forEach((observed, index) => expect(observed).not.toEqual(expectedEach(kills)[index]));
  });

  it("refuses malformed or defaulted input before any git read", async () => {
    const calls = [];
    const recording = (argv, options) => {
      calls.push(argv);
      return runGit(argv, options);
    };
    const valid = cases.identical.input;
    for (const input of [
      { worktree: valid.worktree, intendedHead: valid.intendedHead },
      { worktree: valid.worktree, deployedHead: valid.deployedHead },
      { intendedHead: valid.intendedHead, deployedHead: valid.deployedHead },
      { ...valid, intendedHead: valid.intendedHead.toUpperCase() },
      { ...valid, deployedHead: "HEAD" },
      { ...valid, worktree: "relative" },
      { ...valid, deployedBranch: "main" },
      null,
    ]) {
      expect(await classifyDeployedRuntime(input, recording)).toEqual(failed("input-invalid"));
    }
    expect(await classifyDeployedRuntime(valid, undefined)).toEqual(failed("input-invalid"));
    expect(calls).toEqual([]);
    expect(await classifyDeployedRuntime(valid, () => Promise.reject(new Error("spawn git ENOENT")))).toEqual(
      failed("unexpected-internal-error"),
    );
  });
});

describe("refuses every executed-bytes and compatibility rule", () => {
  let executed;
  let declared;
  let compatibility;

  beforeAll(async () => {
    const repository = createWorkingRepository();
    declared = executedInput(repository);
    ({ executedBytes: executed } = await readExecutedBytes(declared, runGit));
    ({ compatibility } = await classifyDeployedRuntime(
      { worktree: repository.root, intendedHead: descendantOf(repository), deployedHead: repository.head },
      runGit,
    ));
  });

  const otherSha = "f".repeat(40);
  const filesWith = (value, files) => ({ ...value, files });

  it("accepts the produced objects and their plain-data copies", () => {
    expect(validateExecutedBytes(executed, declared)).toEqual([]);
    expect(validateExecutedBytes(structuredClone(executed), declared)).toEqual([]);
    expect(validateCompatibility(compatibility)).toEqual([]);
    expect(validateCompatibility(structuredClone(compatibility))).toEqual([]);
    expect(Object.isFrozen(executed) && Object.isFrozen(executed.files) && Object.isFrozen(executed.files[0])).toBe(
      true,
    );
    expect(Object.isFrozen(compatibility)).toBe(true);
  });

  it("refuses each executed-bytes mutant with its named rule", () => {
    const [first, second, ...rest] = executed.files;
    const extraFile = { path: "scripts/extra.mjs", committedBlobSha1: otherSha, onDiskBlobSha1: otherSha };
    const thirtyFive = Array.from({ length: 35 }, (_, index) => ({
      ...first,
      path: `scripts/governed-${String(index).padStart(2, "0")}.mjs`,
    }));
    const controls = [
      { mutant: { ...executed, unknown: true }, error: "executed-bytes-keys" },
      {
        mutant: Object.fromEntries(Object.entries(executed).filter(([key]) => key !== "head")),
        error: "executed-bytes-keys",
      },
      { mutant: Object.assign(Object.create({ inherited: true }), executed), error: "executed-bytes-keys" },
      { mutant: { ...executed, head: executed.head.toUpperCase() }, error: "head" },
      { mutant: { ...executed, porcelainEmpty: false }, error: "porcelain-empty" },
      { mutant: { ...executed, mergedIntoOriginMain: "true" }, error: "merged-into-origin-main" },
      { mutant: { ...executed, worktreeRoot: "relative/root" }, error: "worktree-root" },
      { mutant: { ...executed, worktreeRoot: `${executed.worktreeRoot}${path.sep}..` }, error: "worktree-root" },
      { mutant: filesWith(executed, [{ ...first, unknown: true }, second, ...rest]), error: "file-keys" },
      { mutant: filesWith(executed, [[first.path, first.committedBlobSha1], second, ...rest]), error: "file-keys" },
      { mutant: filesWith(executed, [second, first, ...rest]), error: "files-unsorted" },
      { mutant: filesWith(executed, [first, first, ...rest]), error: "files-duplicate" },
      {
        mutant: filesWith(executed, [{ ...first, onDiskBlobSha1: otherSha }, second, ...rest]),
        error: "file-blobs-unequal",
      },
      {
        mutant: filesWith(executed, [{ ...first, committedBlobSha1: "f".repeat(39) }, second, ...rest]),
        error: "file-committed-blob",
      },
      {
        mutant: filesWith(executed, [{ ...first, onDiskBlobSha1: null }, second, ...rest]),
        error: "file-on-disk-blob",
      },
      {
        mutant: filesWith(executed, [{ ...first, path: "/scripts/governed-a.mjs" }, second, ...rest]),
        error: "file-path",
      },
      { mutant: filesWith(executed, [...executed.files, extraFile]), error: "files-set" },
      { mutant: filesWith(executed, [first, second, rest[0]]), error: "files-set" },
      { mutant: filesWith(executed, []), error: "files-count" },
      { mutant: filesWith(executed, thirtyFive), error: "files-count" },
      { mutant: filesWith(executed, { 0: first, length: 1 }), error: "files-count" },
    ];
    for (const { mutant, error } of controls) {
      expect(validateExecutedBytes(mutant, declared)).toContain(error);
    }
    expect(validateExecutedBytes(executed, { ...declared, runnerPath: "scripts/other-runner.mjs" })).toContain(
      "files-set",
    );
    expect(validateExecutedBytes(executed, { ...declared, governedPaths: [] })).toEqual(["declared-paths"]);
  });

  it("refuses each compatibility mutant with its named rule", () => {
    const controls = [
      { mutant: { ...compatibility, unknown: true }, error: "compatibility-keys" },
      {
        mutant: Object.fromEntries(Object.entries(compatibility).filter(([key]) => key !== "relation")),
        error: "compatibility-keys",
      },
      { mutant: [compatibility], error: "compatibility-keys" },
      { mutant: { ...compatibility, intendedHead: "HEAD" }, error: "intended-head" },
      { mutant: { ...compatibility, deployedHead: compatibility.deployedHead.slice(1) }, error: "deployed-head" },
      { mutant: { ...compatibility, relation: "deployed-is-cousin" }, error: "relation" },
      { mutant: { ...compatibility, relation: "identical" }, error: "relation-heads" },
      {
        mutant: { ...compatibility, deployedHead: compatibility.intendedHead, relation: "deployed-is-ancestor" },
        error: "relation-heads",
      },
      { mutant: { ...compatibility, deployablePathsChanged: 1 }, error: "deployable-paths-changed" },
      { mutant: { ...compatibility, deployablePathsChanged: "0" }, error: "deployable-paths-changed" },
    ];
    for (const { mutant, error } of controls) {
      expect(validateCompatibility(mutant)).toContain(error);
    }
  });
});

const DEPLOY_PROBE = "executed-bytes-probe";
const DEPTH_THREE_MANIFEST_PROBES = ["docs", ".agents", ".claude", "tools"].map(
  (root) => `${root}/${DEPLOY_PROBE}/package.json`,
);
const DEPTH_THREE_MANIFEST_EXPORT = /\bfind \. -mindepth 3 -maxdepth 3 -name package\.json\b/;

function readDeployFiles() {
  const actionsRoot = path.join(repoRoot, ".github", "actions");
  return {
    dockerfile: readFileSync(path.join(repoRoot, "Dockerfile"), "utf8"),
    workflow: readFileSync(path.join(repoRoot, ".github", "workflows", "platform-production.yml"), "utf8"),
    actions: readdirSync(actionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        directory: `.github/actions/${entry.name}`,
        text: readFileSync(path.join(actionsRoot, entry.name, "action.yml"), "utf8"),
      })),
  };
}

// Joins continued lines and skips heredoc bodies so every instruction is read
// from its keyword, never from embedded script text.
function dockerfileInstructions(text) {
  const lines = text.split(/\r?\n/);
  const instructions = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(?:#|$)/.test(lines[index])) continue;
    const line = index + 1;
    let source = lines[index];
    while (source.endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      source = `${source.slice(0, -1)} ${lines[index]}`;
    }
    const heredoc = /<<-?(["']?)(\w+)\1/.exec(source);
    if (heredoc) {
      index += 1;
      while (index < lines.length && lines[index].trim() !== heredoc[2]) index += 1;
    }
    const [, keyword, args] = /^\s*(\S+)\s*(.*)$/.exec(source);
    instructions.push({ keyword: keyword.toUpperCase(), args: args.trim(), line });
  }
  return instructions;
}

function dockerfileStages(text) {
  const stages = [];
  for (const instruction of dockerfileInstructions(text)) {
    if (instruction.keyword === "FROM") {
      stages.push({ name: /\sAS\s+(\S+)$/i.exec(instruction.args)?.[1] ?? null, instructions: [] });
    } else if (stages.length > 0) {
      stages.at(-1).instructions.push(instruction);
    }
  }
  return stages;
}

function copyOperands(args) {
  const flags = [];
  let rest = args;
  for (let flag = /^(--\S+)\s+/.exec(rest); flag; flag = /^(--\S+)\s+/.exec(rest)) {
    flags.push(flag[1]);
    rest = rest.slice(flag[0].length);
  }
  const operands = rest.startsWith("[") ? JSON.parse(rest) : rest.split(/\s+/);
  return { flags, sources: operands.slice(0, -1), destination: operands.at(-1) };
}

function dockerfileInputs(text) {
  const inputs = [];
  const violations = [];
  for (const stage of dockerfileStages(text)) {
    const exportsDepthThreeManifests =
      stage.name === "manifests" &&
      stage.instructions.some(({ keyword, args }) => keyword === "RUN" && DEPTH_THREE_MANIFEST_EXPORT.test(args));
    for (const { keyword, args, line } of stage.instructions) {
      const origin = `Dockerfile:${line}`;
      if (keyword === "COPY" || keyword === "ADD") {
        const { flags, sources, destination } = copyOperands(args);
        const from = flags.find((flag) => flag.startsWith("--from="))?.slice("--from=".length);
        if (from === "manifests" && sources.join(" ") !== "/manifests") {
          violations.push(`${origin} copies more than the manifests export`);
        }
        if (from !== undefined) continue;
        for (const source of sources) {
          if (path.posix.normalize(source) !== ".") {
            inputs.push({ shape: "copy-source", path: source, origin });
          } else if (keyword === "COPY" && exportsDepthThreeManifests && sources.length === 1 && destination === ".") {
            inputs.push(
              ...DEPTH_THREE_MANIFEST_PROBES.map((probe) => ({ shape: "depth-three-manifest", path: probe, origin })),
            );
          } else {
            violations.push(`${origin} copies the whole build context outside the manifests stage`);
          }
        }
      } else if (keyword === "RUN") {
        for (const [, options] of args.matchAll(/--mount=(\S+)/g)) {
          const mount = Object.fromEntries(
            options.split(",").map((option) => {
              const separator = option.indexOf("=");
              return separator < 0 ? [option, ""] : [option.slice(0, separator), option.slice(separator + 1)];
            }),
          );
          if ((mount.type ?? "bind") !== "bind" || mount.from !== undefined) continue;
          const source = mount.source ?? mount.src ?? ".";
          if (path.posix.normalize(source) === ".") violations.push(`${origin} bind-mounts the whole build context`);
          else inputs.push({ shape: "bind-mount-source", path: source, origin });
        }
      }
    }
  }
  return { inputs, violations };
}

const SHELL_COMMAND = /(?<![\w./$-])(cd|node)(?=[ \t])/g;
const SHELL_WORD = /(?:[ \t]|\\\r?\n)*("[^"\n]*"|'[^'\n]*'|[^\s;|&()<>]+)/y;
const NODE_INLINE_CODE = new Set(["-", "-e", "-p", "-pe", "--eval", "--print"]);
const ACTION_PATH = /^(?:\$\{GITHUB_ACTION_PATH\}|\$GITHUB_ACTION_PATH|\$\{\{\s*github\.action_path\s*\}\})/;
const WORKSPACE_PATH = /^(?:\$\{GITHUB_WORKSPACE\}|\$GITHUB_WORKSPACE|\$\{\{\s*github\.workspace\s*\}\})/;

function unquote(word) {
  return /^(["']).*\1$/s.test(word) ? word.slice(1, -1) : word;
}

function resolveShellPath(operand, directory, actionDirectory) {
  if (actionDirectory !== null && ACTION_PATH.test(operand)) {
    return path.posix.normalize(operand.replace(ACTION_PATH, actionDirectory));
  }
  if (WORKSPACE_PATH.test(operand)) return path.posix.normalize(operand.replace(WORKSPACE_PATH, "."));
  return path.posix.join(directory, operand);
}

// The first operand after node's options is its script path; inline (-e/-p)
// and stdin (-) code has none. Shell variables assigned in the same step are
// expanded once, and GITHUB_ACTION_PATH resolves to the action's directory.
// A `cd` may sit in a subshell, so each script resolves against every
// directory an earlier `cd` could have left: each candidate that exists is an
// input, and a script with no existing candidate is reported unresolved.
function nodeScriptCandidates(run, workingDirectory, actionDirectory) {
  const assignments = new Map(
    [...run.matchAll(/^[ \t]*([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|\S+)[ \t]*$/gm)].map(([, name, value]) => [
      name,
      unquote(value),
    ]),
  );
  const scripts = [];
  let directories = [workingDirectory ?? "."];
  for (const command of run.matchAll(SHELL_COMMAND)) {
    SHELL_WORD.lastIndex = command.index + command[0].length;
    for (let word = SHELL_WORD.exec(run); word; word = SHELL_WORD.exec(run)) {
      const operand = unquote(word[1]);
      if (command[1] === "node" && NODE_INLINE_CODE.has(operand)) break;
      if (operand.startsWith("-")) continue;
      const expanded = operand.replace(
        /\$\{(\w+)\}|\$(\w+)/g,
        (whole, braced, bare) => assignments.get(braced ?? bare) ?? whole,
      );
      const resolved = [
        ...new Set(directories.map((directory) => resolveShellPath(expanded, directory, actionDirectory))),
      ];
      if (command[1] === "cd") directories = [...new Set([...directories, ...resolved])];
      else scripts.push(resolved);
      break;
    }
  }
  return scripts;
}

function localActionFile(uses) {
  const directory = path.posix.normalize(uses);
  return (
    ["action.yml", "action.yaml"]
      .map((name) => `${directory}/${name}`)
      .find((candidate) => existsSync(path.join(repoRoot, candidate))) ?? directory
  );
}

function workflowStepInputs(steps, { origin, defaultDirectory, actionDirectory }) {
  const inputs = [];
  for (const [index, step] of (steps ?? []).entries()) {
    const where = `${origin}.steps[${index}]`;
    if (typeof step.uses === "string" && step.uses.startsWith("./")) {
      inputs.push({ shape: "local-action", path: localActionFile(step.uses), origin: where });
    }
    if (typeof step.run !== "string") continue;
    const workingDirectory = step["working-directory"] ?? defaultDirectory;
    if (workingDirectory !== undefined)
      inputs.push({ shape: "working-directory", path: workingDirectory, origin: where });
    for (const candidates of nodeScriptCandidates(step.run, workingDirectory, actionDirectory)) {
      const existing = candidates.filter((candidate) => existsSync(path.join(repoRoot, ...candidate.split("/"))));
      for (const script of existing.length > 0 ? existing : candidates.slice(0, 1)) {
        inputs.push({ shape: "node-script", path: script, origin: where });
      }
    }
  }
  return inputs;
}

function workflowInputs(text) {
  const workflow = parse(text);
  return Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) => [
    ...(typeof job.uses === "string" && job.uses.startsWith("./")
      ? [{ shape: "local-workflow", path: job.uses, origin: `platform-production.yml jobs.${name}` }]
      : []),
    ...workflowStepInputs(job.steps, {
      origin: `platform-production.yml jobs.${name}`,
      defaultDirectory: job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"],
      actionDirectory: null,
    }),
  ]);
}

function actionInputs({ directory, text }) {
  const { runs } = parse(text);
  if (runs?.using !== "composite") {
    return { inputs: [], violations: [`${directory} runs '${runs?.using}', which this guard cannot derive`] };
  }
  return {
    inputs: workflowStepInputs(runs.steps, {
      origin: `${directory}/action.yml runs`,
      defaultDirectory: undefined,
      actionDirectory: directory,
    }),
    violations: [],
  };
}

// A derived input is probed by changing it: a file is the probe itself and a
// directory gains a new file, which must still be deployable.
function probeFor({ shape, path: inputPath, origin }) {
  if (shape === "depth-three-manifest") return { probe: inputPath };
  const normalized = path.posix.normalize(inputPath).replace(/\/$/, "");
  const target = path.join(repoRoot, ...normalized.split("/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /[*?[\]$]/.test(normalized)
  ) {
    return { violation: `${origin} ${shape} '${inputPath}' is not a repository path` };
  }
  if (!existsSync(target)) return { violation: `${origin} ${shape} '${normalized}' does not exist` };
  return { probe: statSync(target).isDirectory() ? `${normalized}/${DEPLOY_PROBE}` : normalized };
}

function deriveDeployInputs({ dockerfile, workflow, actions }) {
  const docker = dockerfileInputs(dockerfile);
  const derivedActions = actions.map(actionInputs);
  const inputs = [
    ...docker.inputs,
    ...workflowInputs(workflow),
    ...derivedActions.flatMap(({ inputs: found }) => found),
  ];
  const violations = [...docker.violations, ...derivedActions.flatMap(({ violations: found }) => found)];
  const probes = new Map();
  for (const input of inputs) {
    const { probe, violation } = probeFor(input);
    if (violation) violations.push(violation);
    else probes.set(probe, [...(probes.get(probe) ?? []), `${input.shape} at ${input.origin}`]);
  }
  return { inputs, probes, violations };
}

async function classifyProbeChanges(probes) {
  const root = initRepository("staging-executed-bytes-probes-");
  const [base, ...changes] = importCommits(root, [
    { parent: null, files: { "placeholder.txt": "base\n" } },
    ...probes.map((probe) => ({ parent: 0, files: { [probe]: "probe\n" } })),
  ]);
  const results = [];
  for (let start = 0; start < changes.length; start += 8) {
    results.push(
      ...(await Promise.all(
        changes
          .slice(start, start + 8)
          .map((intendedHead) => classifyDeployedRuntime({ worktree: root, intendedHead, deployedHead: base }, runGit)),
      )),
    );
  }
  return results;
}

async function deployInputViolations(files) {
  const { probes, violations } = deriveDeployInputs(files);
  const sorted = [...probes.keys()].sort();
  const results = await classifyProbeChanges(sorted);
  sorted.forEach((probe, index) => {
    const result = results[index];
    if (result.outcome !== "failed" || result.stop !== "deployed-runtime-incompatible" || result.path !== probe) {
      violations.push(`${probe} (${probes.get(probe).join("; ")}) classified ${JSON.stringify(result)}`);
    }
  });
  return violations;
}

describe("treats every image and deploy input as deployable", () => {
  it("derives every build-context, bind-mount, local action, working-directory and node script input", () => {
    const { inputs, probes, violations } = deriveDeployInputs(readDeployFiles());
    expect(violations).toEqual([]);
    const shapes = new Map();
    for (const { shape, path: inputPath } of inputs) shapes.set(shape, [...(shapes.get(shape) ?? []), inputPath]);
    expect([...shapes.keys()].sort()).toEqual([
      "bind-mount-source",
      "copy-source",
      "depth-three-manifest",
      "local-action",
      "node-script",
      "working-directory",
    ]);
    expect(shapes.get("copy-source")).toEqual(
      expect.arrayContaining(["scripts", "infrastructure", "tsconfig.base.json"]),
    );
    expect(shapes.get("local-action")).toContain(".github/actions/setup-pnpm-workspace/action.yml");
    expect(shapes.get("working-directory")).toContain("infrastructure/digitalocean/platform");
    expect(shapes.get("node-script")).toEqual(
      expect.arrayContaining([
        "scripts/resolve-release-commit.mjs",
        "scripts/terraform-plan-inspection.mjs",
        "scripts/ci-image-sources.mjs",
        "scripts/terraform-state-database-urls.mjs",
      ]),
    );
    expect(probes.has(`infrastructure/digitalocean/platform/${DEPLOY_PROBE}`)).toBe(true);
    for (const probe of DEPTH_THREE_MANIFEST_PROBES) expect(probes.has(probe)).toBe(true);
  });

  it("classifies a change to each derived input as deployed-runtime-incompatible", async () => {
    expect(await deployInputViolations(readDeployFiles())).toEqual([]);
  });

  it("is red for a Dockerfile copy that adds COPY docs ./docs or moves COPY . . outside manifests", async () => {
    const files = readDeployFiles();
    const insertAfterStage = (stage, instruction) => {
      const header = new RegExp(`^FROM \\S+ AS ${stage}\\n`, "m");
      expect(files.dockerfile).toMatch(header);
      return { ...files, dockerfile: files.dockerfile.replace(header, (match) => `${match}${instruction}\n`) };
    };

    expect(await deployInputViolations(insertAfterStage("runtime", "COPY --chown=node:node docs ./docs"))).toEqual([
      expect.stringMatching(
        /^docs\/executed-bytes-probe \(copy-source at Dockerfile:\d+\) classified .*"outcome":"ok"/,
      ),
    ]);
    expect(await deployInputViolations(insertAfterStage("build", "COPY . ."))).toEqual([
      expect.stringMatching(/^Dockerfile:\d+ copies the whole build context outside the manifests stage$/),
    ]);
  });
});
