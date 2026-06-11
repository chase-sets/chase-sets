#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";

export function parseReleaseHealthCiMetadataArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_CI_METADATA_OUT", env),
    format: readOption(argv, "--format") ?? "json",
    fetchImpl: globalThis.fetch,
  };
}

export async function collectReleaseHealthCiMetadata(options) {
  if (!options.repository) {
    throw new Error("GitHub repository is required.");
  }
  if (!isCommitSha(options.releaseCommit)) {
    throw new Error("Release commit must be a 40-character Git commit SHA.");
  }
  if (typeof options.fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const url = new URL(`https://api.github.com/repos/${options.repository}/actions/runs`);
  url.searchParams.set("head_sha", options.releaseCommit);
  url.searchParams.set("per_page", "100");

  const response = await options.fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub workflow run lookup failed: ${response.status}`);
  }

  return summarizeWorkflowRuns(await response.json());
}

export function summarizeWorkflowRuns(body) {
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  const jobs = new Map();
  let retryCount = 0;
  let flakyFailureCount = 0;

  for (const run of runs) {
    const attempts = nonNegativeInteger(run.run_attempt);
    const retries = Math.max(0, attempts - 1);
    if (retries === 0) {
      continue;
    }
    const name = typeof run.name === "string" && run.name.trim() ? run.name.trim() : "unknown";
    retryCount += retries;
    if (run.conclusion === "success") {
      flakyFailureCount += retries;
    }
    const previous = jobs.get(name) ?? { name, retryCount: 0, flakyFailureCount: 0 };
    previous.retryCount += retries;
    if (run.conclusion === "success") {
      previous.flakyFailureCount += retries;
    }
    jobs.set(name, previous);
  }

  return {
    retryCount,
    flakyFailureCount,
    topFlakyJobs: [...jobs.values()]
      .sort((a, b) => b.retryCount + b.flakyFailureCount - (a.retryCount + a.flakyFailureCount))
      .slice(0, 5),
  };
}

export async function writeReleaseHealthCiMetadata(options) {
  const metadata = await collectReleaseHealthCiMetadata(options);
  const output =
    options.format === "github-output" ? formatGitHubOutput(metadata) : `${JSON.stringify(metadata, null, 2)}\n`;
  if (options.outPath) {
    await writeFile(options.outPath, output);
  }
  return { metadata, output };
}

function formatGitHubOutput(metadata) {
  return [
    `ci_retry_count=${metadata.retryCount}`,
    `ci_flaky_failure_count=${metadata.flakyFailureCount}`,
    `ci_top_flaky_jobs=${JSON.stringify(metadata.topFlakyJobs)}`,
    "",
  ].join("\n");
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

async function main(argv, env = process.env) {
  try {
    const { output } = await writeReleaseHealthCiMetadata(parseReleaseHealthCiMetadataArgs(argv, env));
    process.stdout.write(output);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
