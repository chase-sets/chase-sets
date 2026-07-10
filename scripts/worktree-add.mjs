// Sanitized worktree creation. This helper is the supported way to add a
// pooled worktree: it validates the name and branch strictly before any git
// command runs, so a hand-built worktree-add command cannot join a second
// path onto the directory argument and create a corrupted, mangled-name husk
// directory.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const containerDir = resolve(repoRoot, "..");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9/._-]*$/i;

export function validateWorktreeName(name) {
  const value = String(name ?? "").trim();
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `Worktree name '${value}' is invalid: use lowercase letters, digits, and hyphens only (no separators, drives, or spaces).`,
    );
  }
  return value;
}

export function validateBranchName(branch) {
  const value = String(branch ?? "").trim();
  if (!BRANCH_PATTERN.test(value) || value.includes("..") || value.endsWith("/")) {
    throw new Error(`Branch name '${value}' is invalid.`);
  }
  return value;
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, stdio: "inherit", windowsHide: true });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }
}

export function addWorktree(nameInput, branchInput) {
  const name = validateWorktreeName(nameInput);
  const branch = validateBranchName(branchInput ?? `codex/${name}`);
  const target = join(containerDir, name);
  if (existsSync(target)) {
    throw new Error(`Worktree directory '${target}' already exists.`);
  }

  runGit(["fetch", "origin", "main"]);
  runGit(["worktree", "add", target, "-b", branch, "origin/main"]);
  console.log(`Worktree ready: ${target} on ${branch} (from origin/main).`);
  console.log("Install dependencies with: pnpm run deps:install");
}

function main(argv) {
  const [name, branch] = argv;
  if (!name) {
    console.error("Usage: pnpm run ops worktree:add <name> [branch]");
    return 2;
  }
  try {
    addWorktree(name, branch);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("worktree-add.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
