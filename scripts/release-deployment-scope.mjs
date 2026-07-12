#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { listWorkspacePackages, repoRoot } from "./lib/repo.mjs";

const forceDeployOutput = {
  deploy: "true",
  exposure_posture_changed: "false",
  exposure_posture_categories: "",
  exposure_posture_categories_json: "[]",
  changed_files_json: "[]",
};

export function parseReleaseDeploymentScopeArgs(argv, env = process.env) {
  return {
    eventName: readOption(argv, "--event-name") ?? readEnv("GITHUB_EVENT_NAME", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    forceDeploy: parseBoolean(readOption(argv, "--force-deploy") ?? readEnv("FORCE_DEPLOY", env) ?? "false"),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    gitPath: readOption(argv, "--git") ?? readEnv("GIT_PATH", env) ?? "git",
  };
}

export function resolveReleaseDeploymentScope(options, dependencies = {}) {
  const exec = dependencies.execFileSync ?? execFileSync;
  const append = dependencies.appendFileSync ?? appendFileSync;
  const log = dependencies.log ?? console.log;
  const cwd = dependencies.cwd ?? repoRoot;
  const gitPath = options.gitPath ?? "git";
  const eventName = requireNonEmpty(options.eventName, "event name is required.");
  const releaseCommit = requireNonEmpty(options.releaseCommit, "release commit is required.");

  git(exec, gitPath, ["fetch", "origin", "production"], { cwd, ignoreFailure: true });

  if (eventName === "workflow_dispatch" && options.forceDeploy === true) {
    writeOutputs(append, options.githubOutputPath, forceDeployOutput);
    log(`Manual force deployment requested for ${releaseCommit}.`);
    return { deploy: true, reason: "manual-force", baseCommit: null, latestMain: null, output: forceDeployOutput };
  }

  const baseCommit = resolveReleaseDiffBase({ exec, gitPath, cwd, releaseCommit });
  if (!baseCommit) {
    writeOutputs(append, options.githubOutputPath, forceDeployOutput);
    log(`No base commit was available for ${releaseCommit}; deployment is required.`);
    return { deploy: true, reason: "missing-base", baseCommit: null, latestMain: null, output: forceDeployOutput };
  }

  const changedFiles = (dependencies.listChangedFiles ?? listChangedFiles)(baseCommit, releaseCommit, {
    cwd,
    execFileSync: exec,
  });
  const scope = (dependencies.classifyChanges ?? classifyChanges)({
    changedFiles,
    workspaces: dependencies.workspaces ?? listWorkspacePackages({ repoRoot: cwd }),
    baseDir: cwd,
  });
  const output = toOutputMap(scope);
  writeOutputs(append, options.githubOutputPath, output);
  log(JSON.stringify(output, null, 2));
  return { deploy: scope.deployRequired, reason: "scoped", baseCommit, latestMain: null, output, scope };
}

export function resolveReleaseDiffBase({ exec = execFileSync, gitPath = "git", cwd = repoRoot, releaseCommit }) {
  if (remoteRefExists(exec, gitPath, "refs/remotes/origin/production", cwd)) {
    const productionCommit = revParse(exec, gitPath, "origin/production", cwd);
    return productionCommit;
  }

  return revParse(exec, gitPath, `${releaseCommit}^`, cwd, { ignoreFailure: true });
}

function remoteRefExists(exec, gitPath, ref, cwd) {
  return git(exec, gitPath, ["show-ref", "--verify", "--quiet", ref], { cwd, ignoreFailure: true }).status === 0;
}

function revParse(exec, gitPath, ref, cwd, options = {}) {
  const result = git(exec, gitPath, ["rev-parse", ref], { cwd, ignoreFailure: options.ignoreFailure });
  return result.status === 0 ? result.stdout.trim() : "";
}

function git(exec, gitPath, args, options = {}) {
  try {
    const stdout = exec(gitPath, args, { cwd: options.cwd, encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    if (options.ignoreFailure) {
      return {
        status: typeof error?.status === "number" ? error.status : 1,
        stdout: error?.stdout ?? "",
      };
    }
    throw error;
  }
}

function writeOutputs(append, outputPath, output) {
  const content = Object.entries(output)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (outputPath) {
    append(outputPath, `${content}\n`, "utf8");
  }
}

function requireNonEmpty(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function parseBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error("FORCE_DEPLOY must be true or false.");
}

function main(argv) {
  try {
    resolveReleaseDeploymentScope(parseReleaseDeploymentScopeArgs(argv));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
