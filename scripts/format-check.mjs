import { execFileSync, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFileInfo } from "prettier";

export const FORMAT_CHECK_SCOPE_ENV = "FORMAT_CHECK_SCOPE";
export const FULL_TREE_SCOPE = "full";
export const MAX_PRETTIER_ARGUMENT_CHARS = 8_000;

const prettierCliPath = fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs"));

export class ChangedFilesDerivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChangedFilesDerivationError";
    this.code = code;
  }
}

function parseChangedFilesJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_CHANGED_FILES_INVALID",
      "CHANGED_FILES_JSON must be valid JSON",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_CHANGED_FILES_INVALID",
      "CHANGED_FILES_JSON must be an array of non-empty file paths",
    );
  }
  return parsed;
}

function defaultExecGit(args, repoRoot) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseNullSeparatedPaths(output) {
  return String(output).split("\0").filter(Boolean);
}

export function deriveChangedFiles({
  repoRoot,
  env = process.env,
  execGit = (args) => defaultExecGit(args, repoRoot),
} = {}) {
  if (Object.hasOwn(env, "CHANGED_FILES_JSON") && env.CHANGED_FILES_JSON !== undefined) {
    return {
      source: "CHANGED_FILES_JSON",
      files: parseChangedFilesJson(env.CHANGED_FILES_JSON),
    };
  }

  let insideWorkTree;
  try {
    insideWorkTree = execGit(["rev-parse", "--is-inside-work-tree"]).trim();
  } catch {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_NOT_GIT_REPOSITORY",
      "could not confirm that the format check is running inside a Git worktree",
    );
  }
  if (insideWorkTree !== "true") {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_NOT_GIT_REPOSITORY",
      "the format check is not running inside a Git worktree",
    );
  }

  let mergeBase;
  try {
    mergeBase = execGit(["merge-base", "origin/main", "HEAD"]).trim();
  } catch {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_MERGE_BASE_FAILED",
      "could not derive the merge-base for origin/main and HEAD",
    );
  }
  if (!mergeBase) {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_MERGE_BASE_FAILED",
      "the merge-base for origin/main and HEAD was empty",
    );
  }

  let changedFiles;
  try {
    changedFiles = parseNullSeparatedPaths(
      execGit(["diff", "--name-only", "-z", "--diff-filter=ACMRTD", `${mergeBase}...HEAD`, "--"]),
    );
  } catch {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_DIFF_FAILED",
      "could not derive changed files from the merge-base",
    );
  }
  return { source: "git merge-base", files: changedFiles };
}

function normalizeRepoPath(repoRoot, file) {
  const absolutePath = path.resolve(repoRoot, file);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new ChangedFilesDerivationError(
      "FORMAT_CHECK_CHANGED_PATH_INVALID",
      `changed path is outside the repository: ${file}`,
    );
  }
  return {
    absolutePath,
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

export async function filterCheckableFiles({ repoRoot, files, getFileInfoImpl = getFileInfo, statImpl = stat } = {}) {
  const uniqueFiles = [];
  const seen = new Set();
  for (const file of files) {
    const normalized = normalizeRepoPath(repoRoot, file);
    if (!seen.has(normalized.relativePath)) {
      seen.add(normalized.relativePath);
      uniqueFiles.push(normalized);
    }
  }

  const results = await Promise.all(
    uniqueFiles.map(async (file) => {
      try {
        const fileStat = await statImpl(file.absolutePath);
        if (!fileStat.isFile()) return { file, reason: "deleted" };
      } catch (error) {
        if (error?.code === "ENOENT") return { file, reason: "deleted" };
        throw error;
      }
      const info = await getFileInfoImpl(file.absolutePath, {
        ignorePath: path.join(repoRoot, ".prettierignore"),
      });
      return { file, reason: info.ignored ? "ignored" : "checkable" };
    }),
  );

  return {
    files: results.filter((result) => result.reason === "checkable").map((result) => result.file.relativePath),
    deletedCount: results.filter((result) => result.reason === "deleted").length,
    ignoredCount: results.filter((result) => result.reason === "ignored").length,
  };
}

export function chunkPrettierPaths(files, maxArgumentChars = MAX_PRETTIER_ARGUMENT_CHARS) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const file of files) {
    const addedLength = file.length + 1;
    if (current.length > 0 && currentLength + addedLength > maxArgumentChars) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(file);
    currentLength += addedLength;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function defaultRunPrettier(args, repoRoot) {
  const result = spawnSync(process.execPath, [prettierCliPath, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function fullTreeArgs() {
  return [".", "--check", "--ignore-unknown"];
}

function scopedArgs(files) {
  return ["--check", "--ignore-unknown", "--", ...files];
}

export function changesFormattingControls(files) {
  return files.some((file) => {
    const normalized = file.replaceAll("\\", "/");
    const basename = path.posix.basename(normalized);
    return (
      basename === ".editorconfig" ||
      basename === ".gitignore" ||
      basename === ".prettierignore" ||
      basename === "package.json" ||
      basename === "pnpm-lock.yaml" ||
      basename.startsWith(".prettierrc") ||
      basename.startsWith("prettier.config.")
    );
  });
}

function parseMode(argv) {
  const forwardedArgs = argv[0] === "--" ? argv.slice(1) : argv;
  if (forwardedArgs.length === 0) return "full";
  if (forwardedArgs.length === 1 && forwardedArgs[0] === "--changed") return "changed";
  throw new Error("Usage: node ./scripts/format-check.mjs [--changed]");
}

export async function runFormatCheck({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = process.cwd(),
  execGit,
  getFileInfoImpl,
  statImpl,
  runPrettier = (args) => defaultRunPrettier(args, repoRoot),
  stdout = console.log,
  stderr = console.warn,
} = {}) {
  const requestedMode = parseMode(argv);
  if (requestedMode === "full" || env[FORMAT_CHECK_SCOPE_ENV] === FULL_TREE_SCOPE) {
    const reason = requestedMode === "full" ? "default" : `${FORMAT_CHECK_SCOPE_ENV}=${FULL_TREE_SCOPE}`;
    stdout(`[FORMAT_CHECK_FULL_TREE] Running the full-tree format check (${reason}).`);
    return runPrettier(fullTreeArgs());
  }

  let derived;
  try {
    derived = deriveChangedFiles({ repoRoot, env, execGit });
  } catch (error) {
    const code = error instanceof ChangedFilesDerivationError ? error.code : "FORMAT_CHECK_DERIVATION_FAILED";
    stderr(`[${code}] ${error.message}. Running the full-tree format check.`);
    return runPrettier(fullTreeArgs());
  }

  if (changesFormattingControls(derived.files)) {
    stdout(
      `[FORMAT_CHECK_CONTROL_FILE_CHANGED] ${derived.source} includes a formatter control file; ` +
        "running the full-tree format check.",
    );
    return runPrettier(fullTreeArgs());
  }

  let filtered;
  try {
    filtered = await filterCheckableFiles({
      repoRoot,
      files: derived.files,
      getFileInfoImpl,
      statImpl,
    });
  } catch (error) {
    const code = error instanceof ChangedFilesDerivationError ? error.code : "FORMAT_CHECK_FILE_FILTER_FAILED";
    stderr(`[${code}] ${error.message}. Running the full-tree format check.`);
    return runPrettier(fullTreeArgs());
  }

  if (derived.files.length === 0) {
    stdout(`[FORMAT_CHECK_EMPTY_DIFF] No changed files were derived from ${derived.source}; nothing to check.`);
    return 0;
  }
  if (filtered.files.length === 0) {
    stdout(
      `[FORMAT_CHECK_NO_CHECKABLE_FILES] ${derived.files.length} changed file(s) from ${derived.source}; ` +
        `deleted=${filtered.deletedCount}, ignored=${filtered.ignoredCount}.`,
    );
    return 0;
  }

  const chunks = chunkPrettierPaths(filtered.files);
  stdout(
    `[FORMAT_CHECK_SCOPED] Checking ${filtered.files.length}/${derived.files.length} changed file(s) from ` +
      `${derived.source} in ${chunks.length} chunk(s); deleted=${filtered.deletedCount}, ignored=${filtered.ignoredCount}.`,
  );
  for (const chunk of chunks) {
    const status = runPrettier(scopedArgs(chunk));
    if (status !== 0) return status;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFormatCheck()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
