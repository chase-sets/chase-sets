#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

const execFile = promisify(execFileCallback);

export function parseResolveReleaseCommitArgs(argv, env = process.env) {
  return {
    eventName: readOption(argv, "--event-name") ?? readEnv("GITHUB_EVENT_NAME", env),
    pushCommit: readOption(argv, "--push-commit") ?? readEnv("GITHUB_SHA", env),
    releaseRef: readOption(argv, "--release-ref") ?? readEnv("RELEASE_REF", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    githubEnvPath: readOption(argv, "--github-env") ?? readEnv("GITHUB_ENV", env),
    checkout: parseBoolean(readOption(argv, "--checkout") ?? readEnv("RESOLVE_RELEASE_CHECKOUT", env) ?? "false"),
    gitPath: readOption(argv, "--git") ?? readEnv("GIT_PATH", env) ?? "git",
  };
}

export async function resolveReleaseCommit(options, dependencies = {}) {
  const exec = dependencies.execFile ?? execFile;
  const append = dependencies.appendFile ?? appendFile;
  const log = dependencies.log ?? console.log;
  const gitPath = options.gitPath ?? "git";

  await git(exec, gitPath, ["fetch", "origin", "main"]);
  const releaseCommit =
    options.eventName === "push"
      ? requireNonEmpty(options.pushCommit, "GITHUB_SHA is required for push-triggered releases.")
      : await resolveReleaseRef(exec, gitPath, requireNonEmpty(options.releaseRef, "release_ref is required."));

  await git(exec, gitPath, ["merge-base", "--is-ancestor", releaseCommit, "origin/main"]);

  if (options.checkout) {
    await git(exec, gitPath, ["checkout", "--detach", releaseCommit]);
  }
  if (options.githubOutputPath) {
    await append(options.githubOutputPath, `release_commit=${releaseCommit}\n`);
  }
  if (options.githubEnvPath) {
    await append(options.githubEnvPath, `release_commit=${releaseCommit}\n`);
  }

  log(`Resolved release commit ${releaseCommit}.`);
  return { releaseCommit };
}

async function resolveReleaseRef(exec, gitPath, releaseRef) {
  await git(exec, gitPath, ["fetch", "origin", releaseRef], { ignoreFailure: true });

  if (await gitRefExists(exec, gitPath, `${releaseRef}^{commit}`)) {
    const { stdout } = await git(exec, gitPath, ["rev-parse", `${releaseRef}^{commit}`]);
    return stdout.trim();
  }
  if (await gitRefExists(exec, gitPath, `origin/${releaseRef}^{commit}`)) {
    const { stdout } = await git(exec, gitPath, ["rev-parse", `origin/${releaseRef}^{commit}`]);
    return stdout.trim();
  }

  throw new Error(`Release ref '${releaseRef}' does not resolve to a commit.`);
}

async function gitRefExists(exec, gitPath, ref) {
  const result = await git(exec, gitPath, ["rev-parse", "--verify", "--quiet", ref], { ignoreFailure: true });
  return result.exitCode === 0;
}

async function git(exec, gitPath, args, options = {}) {
  try {
    const result = await exec(gitPath, args);
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (options.ignoreFailure) {
      return {
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? "",
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
    throw error;
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
  throw new Error("RESOLVE_RELEASE_CHECKOUT must be true or false.");
}

async function main(argv, env = process.env) {
  try {
    await resolveReleaseCommit(parseResolveReleaseCommitArgs(argv, env));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
