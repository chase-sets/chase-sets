import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { classifyChanges, listChangedFiles } from "./change-scope.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";

const require = createRequire(import.meta.url);
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const typecheckRoots = new Set(["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"]);
const typeScriptPath = /\.(?:ts|tsx)$/i;
const globalInputPath = /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|package\.json|pnpm-lock\.yaml)$|\.d\.ts$/i;

export class TypecheckChangedError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = "TypecheckChangedError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function parseChangedFilesJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypecheckChangedError("TYPECHECK_CHANGED_CHANGED_FILES_INVALID", "CHANGED_FILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((file) => typeof file !== "string" || !file.trim())) {
    throw new TypecheckChangedError(
      "TYPECHECK_CHANGED_CHANGED_FILES_INVALID",
      "CHANGED_FILES_JSON must be an array of non-empty file paths",
    );
  }
  return parsed.map((file) => file.replaceAll("\\", "/"));
}

export function deriveChangedFiles({ repoRoot = rootDir, env = process.env, execFile = execFileSync } = {}) {
  if (Object.hasOwn(env, "CHANGED_FILES_JSON") && env.CHANGED_FILES_JSON !== undefined) {
    return { source: "CHANGED_FILES_JSON", files: parseChangedFilesJson(env.CHANGED_FILES_JSON) };
  }
  try {
    const files = listChangedFiles("origin/main", "HEAD", {
      cwd: repoRoot,
      execFileSync: execFile,
    });
    return { source: "git merge-base", files };
  } catch (error) {
    throw new TypecheckChangedError(
      "TYPECHECK_CHANGED_DERIVATION_FAILED",
      `could not derive changed files (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function workspaceFiles(workspace, repoRoot) {
  const relative = (file) => path.relative(repoRoot, file).split(path.sep).join("/");
  const testFiles = globSync("**/*.{test,spec}.{ts,tsx}", {
    cwd: workspace.dir,
    nodir: true,
    exclude: ["node_modules/**", "build/**", "coverage/**", "dist/**"],
  }).map((file) => relative(path.join(workspace.dir, file)));
  const ambientFiles = globSync("**/*.d.ts", {
    cwd: workspace.dir,
    nodir: true,
    exclude: ["node_modules/**", "build/**", "coverage/**", "dist/**"],
  }).map((file) => relative(path.join(workspace.dir, file)));
  return { testFiles, ambientFiles };
}

function rootAmbientFiles(repoRoot) {
  const workspaceAmbient = [...typecheckRoots].flatMap((root) =>
    globSync(`${root}/**/*.d.ts`, {
      cwd: repoRoot,
      nodir: true,
      exclude: ["**/node_modules/**", "**/build/**", "**/coverage/**", "**/dist/**"],
    }),
  );
  return ["asset-env.d.ts", "test-env.d.ts", ...workspaceAmbient].filter((file) =>
    existsSync(path.join(repoRoot, file)),
  );
}

function isUnmappedTypeScriptFile(file, workspaces, repoRoot) {
  if (!typeScriptPath.test(file)) return false;
  const topLevel = file.split("/")[0];
  if (!typecheckRoots.has(topLevel)) return false;
  return !workspaces.some((workspace) => {
    const workspacePath = path.relative(repoRoot, workspace.dir).split(path.sep).join("/");
    return file === workspacePath || file.startsWith(`${workspacePath}/`);
  });
}

export function selectChangedTests({ changedFiles, workspaces, repoRoot = rootDir } = {}) {
  const scope = classifyChanges({ changedFiles, workspaces, baseDir: repoRoot });
  for (const file of changedFiles) {
    if (isUnmappedTypeScriptFile(file, workspaces, repoRoot)) {
      throw new TypecheckChangedError(
        "TYPECHECK_CHANGED_UNMAPPED_FILE",
        `TypeScript file is under a testcheck root but no workspace maps it: ${file}`,
      );
    }
  }
  const selectedWorkspaces = workspaces.filter((workspace) => scope.affectedWorkspaces.includes(workspace.name));
  const tests = [];
  const ambient = [...rootAmbientFiles(repoRoot)];
  for (const workspace of selectedWorkspaces) {
    const files = workspaceFiles(workspace, repoRoot);
    tests.push(...files.testFiles);
    ambient.push(...files.ambientFiles);
  }
  return {
    scope,
    workspaces: selectedWorkspaces,
    testFiles: [...new Set(tests)].sort(),
    ambientFiles: [...new Set(ambient)].sort(),
  };
}

function globalInputs(changedFiles) {
  return changedFiles.filter((file) => globalInputPath.test(file));
}

function createTempProgram(repoRoot, files) {
  mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });
  const tempRoot = mkdtempSync(path.join(repoRoot, ".tmp", "typecheck-changed-"));
  const configPath = path.join(tempRoot, "tsconfig.json");
  const extendsPath = path.relative(tempRoot, path.join(repoRoot, "tsconfig.tests.json")).split(path.sep).join("/");
  writeFileSync(
    configPath,
    `${JSON.stringify({ extends: extendsPath, files: files.map((file) => path.resolve(repoRoot, file)), compilerOptions: { noEmit: true } }, null, 2)}\n`,
  );
  return { tempRoot, configPath };
}

function runTsc(configPath, repoRoot) {
  const tscPath = path.join(path.dirname(require.resolve("typescript")), "tsc.js");
  const result = spawnSync(process.execPath, [tscPath, "-p", configPath, "--noEmit"], {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export async function runTypecheckChanged({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = rootDir,
  execFile = execFileSync,
  listWorkspaces = () => listWorkspacePackages({ repoRoot, assertRootCoverage: false }),
  acquireSlot = acquireHeavySlot,
  runCompiler = (configPath) => runTsc(configPath, repoRoot),
  releaseSlot,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  if (argv.length > 0) throw new TypecheckChangedError("TYPECHECK_CHANGED_USAGE", "Usage: pnpm run typecheck:changed");
  const derived = deriveChangedFiles({ repoRoot, env, execFile });
  const workspaces = listWorkspaces();
  const selected = selectChangedTests({ changedFiles: derived.files, workspaces, repoRoot });
  if (selected.workspaces.length === 0) {
    stdout("[TYPECHECK_CHANGED_NO_WORKSPACE] No affected workspace test program.");
    return 0;
  }
  const globals = globalInputs(derived.files);
  if (globals.length > 0) {
    stdout(`[TYPECHECK_CHANGED_GLOBAL_INPUT] ${globals.join(", ")}; hosted Typecheck remains authoritative.`);
  }
  stdout(
    `[TYPECHECK_CHANGED_SCOPED] workspaces=${selected.workspaces.map((workspace) => workspace.name).join(",")} ` +
      `test-files=${selected.testFiles.length}`,
  );
  const admitted = acquireSlot("repository-gate");
  if (admitted === false) {
    stderr("[TYPECHECK_CHANGED_NOT_EXECUTED] heavy admission refused; exit 73");
    return 73;
  }
  let program;
  try {
    program = createTempProgram(repoRoot, [...selected.testFiles, ...selected.ambientFiles]);
    return runCompiler(program.configPath);
  } finally {
    if (program) rmSync(program.tempRoot, { recursive: true, force: true });
    if (releaseSlot) releaseSlot();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runTypecheckChanged()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        error instanceof Error ? `[${error.code ?? "TYPECHECK_CHANGED_FAILED"}] ${error.message}` : String(error),
      );
      process.exitCode = error instanceof TypecheckChangedError ? error.exitCode : 1;
    });
}
