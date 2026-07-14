#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

const execFile = promisify(execFileCallback);

const RELEASE_MODES = new Set(["automatic", "manual", "emergency"]);
const TERMINAL_OUTCOMES = new Set(["promoted", "failed", "rolled-back"]);

export function createLatestOnlyReleaseState() {
  return {
    candidate: null,
    active: null,
    pending: null,
    coalescedCount: 0,
    transitions: [],
  };
}

export function reduceLatestOnlyReleaseState(events, initialState = createLatestOnlyReleaseState()) {
  const state = structuredClone(initialState);
  for (const event of events) {
    applyReleaseEvent(state, event);
  }
  return state;
}

function applyReleaseEvent(state, event) {
  if (!event || typeof event.type !== "string") {
    throw new Error("Release state events require a type.");
  }

  if (event.type === "candidate") {
    const release = normalizeRelease(event);
    if (state.active) {
      if (state.pending) {
        state.coalescedCount += 1;
        state.transitions.push({
          type: "coalesced",
          commit: state.pending.commit,
          supersededByCommit: release.commit,
        });
      }
      state.pending = release;
      state.transitions.push({ type: "pending", ...release });
      return;
    }

    if (state.candidate) {
      state.coalescedCount += 1;
      state.transitions.push({
        type: "coalesced",
        commit: state.candidate.commit,
        supersededByCommit: release.commit,
      });
    }
    state.candidate = release;
    state.transitions.push({ type: "candidate", ...release });
    return;
  }

  if (event.type === "activate") {
    if (state.active) {
      throw new Error("An active release is immutable until it reaches a terminal outcome.");
    }
    if (!state.candidate) {
      throw new Error("A release candidate is required before activation.");
    }
    const imageDigest = requireImageDigest(event.imageDigest);
    if (event.commit && event.commit !== state.candidate.commit) {
      throw new Error("Only the current latest candidate may become active.");
    }
    state.active = { ...state.candidate, imageDigest };
    state.candidate = null;
    state.transitions.push({ type: "active", ...state.active });
    return;
  }

  if (event.type === "terminal") {
    if (!state.active) {
      throw new Error("A terminal outcome requires an active release.");
    }
    if (!TERMINAL_OUTCOMES.has(event.outcome)) {
      throw new Error("Release terminal outcome must be promoted, failed, or rolled-back.");
    }
    if (event.commit && event.commit !== state.active.commit) {
      throw new Error("The terminal release commit must match the immutable active release.");
    }
    if (event.imageDigest && event.imageDigest !== state.active.imageDigest) {
      throw new Error("The terminal image digest must match the immutable active release.");
    }
    state.transitions.push({ type: event.outcome, ...state.active });
    state.active = null;
    state.candidate = state.pending;
    state.pending = null;
    return;
  }

  throw new Error(`Unsupported release state event '${event.type}'.`);
}

function normalizeRelease(event) {
  const commit = requireCommit(event.commit);
  const mode = event.mode ?? "automatic";
  if (!RELEASE_MODES.has(mode)) {
    throw new Error("Release mode must be automatic, manual, or emergency.");
  }
  return { commit, mode };
}

function requireCommit(value) {
  const commit = requireNonEmpty(value, "Release commit is required.");
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("Release commit must be a 40-character Git commit SHA.");
  }
  return commit.toLowerCase();
}

function requireImageDigest(value) {
  const digest = requireNonEmpty(value, "Release image digest is required before activation.");
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new Error("Release image digest must be a sha256 digest.");
  }
  return digest.toLowerCase();
}

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
