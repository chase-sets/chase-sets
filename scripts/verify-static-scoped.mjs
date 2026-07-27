import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyChanges } from "./change-scope.mjs";
import { listWorkspacePackages, repoRoot as defaultRepoRoot } from "./lib/repo.mjs";
import { ALWAYS_RUN, MAY_NARROW, VERIFY_STATIC_SURFACES, linkSurfaceMatches } from "./verify-static-surfaces.mjs";

export class StaticScopeDerivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StaticScopeDerivationError";
    this.code = code;
  }
}

function defaultExecGit(args, repoRoot) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeChangedPath(filePath, repoRoot) {
  const absolutePath = path.resolve(repoRoot, filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_CHANGED_FILES_INVALID",
      `changed path is outside the repository: ${filePath}`,
    );
  }
  return relativePath.replaceAll("\\", "/");
}

function parseChangedFilesJson(value, repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StaticScopeDerivationError("STATIC_SCOPE_CHANGED_FILES_INVALID", "CHANGED_FILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_CHANGED_FILES_INVALID",
      "CHANGED_FILES_JSON must be an array of non-empty paths",
    );
  }
  return [...new Set(parsed.map((filePath) => normalizeChangedPath(filePath, repoRoot)))];
}

export function parseNameStatusZ(output) {
  const tokens = String(output).split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (/^[RC]\d*$/.test(status)) {
      if (index + 1 >= tokens.length) {
        throw new StaticScopeDerivationError(
          "STATIC_SCOPE_DIFF_INVALID",
          `git diff returned an incomplete ${status} record`,
        );
      }
      files.push(tokens[index++], tokens[index++]);
      continue;
    }
    if (!/^[AMDTUXB]$/.test(status) || index >= tokens.length) {
      throw new StaticScopeDerivationError(
        "STATIC_SCOPE_DIFF_INVALID",
        `git diff returned an invalid name-status record near ${status}`,
      );
    }
    files.push(tokens[index++]);
  }
  return [...new Set(files)];
}

export function deriveStaticChangedFiles({
  repoRoot = defaultRepoRoot,
  env = process.env,
  execGit = (args) => defaultExecGit(args, repoRoot),
} = {}) {
  if (Object.hasOwn(env, "CHANGED_FILES_JSON") && env.CHANGED_FILES_JSON !== undefined) {
    return {
      source: "CHANGED_FILES_JSON",
      files: parseChangedFilesJson(env.CHANGED_FILES_JSON, repoRoot),
    };
  }

  let insideWorkTree;
  try {
    insideWorkTree = execGit(["rev-parse", "--is-inside-work-tree"]).trim();
  } catch {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_NOT_GIT_REPOSITORY",
      "could not confirm that verify:static:scoped is running inside a Git worktree",
    );
  }
  if (insideWorkTree !== "true") {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_NOT_GIT_REPOSITORY",
      "verify:static:scoped is not running inside a Git worktree",
    );
  }

  let mergeBase;
  try {
    mergeBase = execGit(["merge-base", "refs/remotes/origin/main", "HEAD"]).trim();
  } catch {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_MERGE_BASE_FAILED",
      "could not derive the merge-base for refs/remotes/origin/main and HEAD",
    );
  }
  if (!mergeBase) {
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_MERGE_BASE_FAILED",
      "the merge-base for refs/remotes/origin/main and HEAD was empty",
    );
  }

  try {
    return {
      source: "git merge-base",
      files: parseNameStatusZ(
        execGit(["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACMRTD", `${mergeBase}...HEAD`, "--"]),
      ),
    };
  } catch (error) {
    if (error instanceof StaticScopeDerivationError) throw error;
    throw new StaticScopeDerivationError(
      "STATIC_SCOPE_DIFF_FAILED",
      "could not derive changed paths from the merge-base",
    );
  }
}

export function parseVerifyStaticChain(packageJson) {
  const chain = packageJson?.scripts?.["verify:static"];
  if (typeof chain !== "string" || chain.trim() === "") {
    throw new Error("package.json scripts.verify:static must be a non-empty command chain");
  }
  return chain.split(/\s*&&\s*/).map((command) => {
    const match = /^pnpm run ([^\s]+)(?:\s+(.*))?$/.exec(command.trim());
    if (!match) throw new Error(`Unsupported verify:static link: ${command}`);
    return { name: match[1], command: command.trim(), forwarded: match[2] ?? "" };
  });
}

export function verifyStaticSurfaceMapCompleteness(chain, surfaces = VERIFY_STATIC_SURFACES) {
  const chainNames = new Set(chain.map((link) => link.name));
  return {
    missing: [...chainNames].filter((name) => !Object.hasOwn(surfaces, name)),
    extra: Object.keys(surfaces).filter((name) => !chainNames.has(name)),
    invalidMayNarrow: [...chainNames].filter((name) => {
      const entry = surfaces[name];
      return entry?.classification === MAY_NARROW && (!Array.isArray(entry.include) || entry.include.length === 0);
    }),
  };
}

function allWorkspacesAffected(changedFiles, repoRoot, dependencies) {
  const workspaces = dependencies.listWorkspacePackages({ repoRoot });
  if (workspaces.length === 0) return false;
  const scope = dependencies.classifyChanges({
    changedFiles,
    workspaces,
    baseDir: repoRoot,
  });
  return scope.affectedWorkspaces.length === workspaces.length;
}

export function selectVerifyStaticLinks({
  chain,
  changedFiles,
  repoRoot = defaultRepoRoot,
  surfaces = VERIFY_STATIC_SURFACES,
  forceFull = false,
  dependencies = { classifyChanges, listWorkspacePackages },
} = {}) {
  if (changedFiles.length === 0 && !forceFull) {
    return { selected: [], skipped: chain.map((link) => ({ link, rule: "empty derived diff" })), fullReason: null };
  }

  const scriptsChanged = changedFiles.some((filePath) =>
    linkSurfaceMatches({ include: [{ kind: "prefix", value: "scripts" }] }, [filePath]),
  );
  const fullReason = forceFull
    ? "changed-file derivation failed closed"
    : scriptsChanged
      ? "scripts/** changed (guard and tooling changes require the full static chain)"
      : allWorkspacesAffected(changedFiles, repoRoot, dependencies)
        ? "classifyChanges affected every workspace (derived root-runtime fanout)"
        : null;
  if (fullReason) return { selected: chain, skipped: [], fullReason };

  const selected = [];
  const skipped = [];
  for (const link of chain) {
    const entry = surfaces[link.name];
    if (!entry) {
      selected.push(link);
      continue;
    }
    if (
      entry.classification === ALWAYS_RUN ||
      entry.classification !== MAY_NARROW ||
      !Array.isArray(entry.include) ||
      entry.include.length === 0 ||
      linkSurfaceMatches(entry, changedFiles)
    ) {
      selected.push(link);
    } else {
      skipped.push({ link, rule: entry.rule });
    }
  }
  return { selected, skipped, fullReason: null };
}

export function resolvePnpmInvocation({ env = process.env, platform = process.platform } = {}) {
  if (typeof env.npm_execpath === "string" && env.npm_execpath.length > 0) {
    if (/\.(?:c|m)?js$/i.test(env.npm_execpath)) {
      return { executable: process.execPath, argumentPrefix: [env.npm_execpath], shell: false };
    }
    return { executable: env.npm_execpath, argumentPrefix: [], shell: false };
  }
  return { executable: "pnpm", argumentPrefix: [], shell: platform === "win32" };
}

function defaultRunLink(link, repoRoot) {
  const invocation = resolvePnpmInvocation();
  const args = ["run", link.name];
  if (link.forwarded) args.push(...link.forwarded.split(/\s+/));
  const result = spawnSync(invocation.executable, [...invocation.argumentPrefix, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function runVerifyStaticScoped({
  repoRoot = defaultRepoRoot,
  env = process.env,
  execGit,
  readPackageJson = () => JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")),
  runLink = (link) => defaultRunLink(link, repoRoot),
  stdout = console.log,
  stderr = console.warn,
  surfaces = VERIFY_STATIC_SURFACES,
  dependencies = { classifyChanges, listWorkspacePackages },
} = {}) {
  const chain = parseVerifyStaticChain(readPackageJson());
  let derived;
  let forceFull = false;
  try {
    derived = deriveStaticChangedFiles({ repoRoot, env, execGit });
  } catch (error) {
    const code = error instanceof StaticScopeDerivationError ? error.code : "STATIC_SCOPE_DERIVATION_FAILED";
    stderr(`[${code}] ${error.message}. Running the full verify:static chain.`);
    derived = { source: "fail-closed fallback", files: [] };
    forceFull = true;
  }

  let plan;
  try {
    plan = selectVerifyStaticLinks({
      chain,
      changedFiles: derived.files,
      repoRoot,
      surfaces,
      forceFull,
      dependencies,
    });
  } catch (error) {
    stderr(`[STATIC_SCOPE_CLASSIFICATION_FAILED] ${error.message}. Running the full verify:static chain.`);
    plan = selectVerifyStaticLinks({
      chain,
      changedFiles: [],
      repoRoot,
      surfaces,
      forceFull: true,
      dependencies,
    });
  }
  if (plan.fullReason) stdout(`[VERIFY_STATIC_FULL] ${plan.fullReason}.`);
  for (const { link, rule } of plan.skipped) {
    stdout(`[SKIPPED-BY-SCOPE] ${link.name}: ${rule}`);
  }
  stdout(
    `[VERIFY_STATIC_SCOPE] scanned=${plan.selected.length}/${chain.length}; skipped=${plan.skipped.length}; ` +
      `changed=${derived.files.length}; source=${derived.source}.`,
  );

  for (const link of plan.selected) {
    stdout(`[VERIFY_STATIC_RUN] ${link.name}`);
    const status = await runLink(link);
    if (status !== 0) return status;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runVerifyStaticScoped()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
