import { execFile } from "node:child_process";
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION = "digitalocean-preview-cleanup-sweep/v1";
export const DEFAULT_STATE_BUCKET = "chase-sets-terraform-state";
export const DEFAULT_SPACES_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
export const DEFAULT_PREVIEW_STATE_PREFIX = "platform/previews/";

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
        return;
      }

      resolve(stdout);
    });
  });
}

async function commandJson(command, args, dependencies = {}) {
  const output = await (dependencies.commandOutput ?? commandOutput)(command, args);
  return JSON.parse(output || "{}");
}

export function previewPrNumberFromStateKey(key, prefix = DEFAULT_PREVIEW_STATE_PREFIX) {
  const escapedPrefix = escapeRegExp(trimSlashes(prefix));
  const match = String(key ?? "").match(new RegExp(`^${escapedPrefix}/pr-(\\d+)\\.tfstate$`));
  return match ? Number.parseInt(match[1], 10) : null;
}

export function selectPreviewStateTargets(objects, options = {}) {
  const prefix = trimSlashes(options.prefix ?? DEFAULT_PREVIEW_STATE_PREFIX);
  const targetsByPr = new Map();

  for (const object of objects) {
    const stateKey = object.Key ?? object.key ?? "";
    const prNumber = previewPrNumberFromStateKey(stateKey, prefix);
    if (!prNumber) {
      continue;
    }
    const existing = targetsByPr.get(prNumber);
    if (!existing || stateKey < existing.stateKey) {
      targetsByPr.set(prNumber, { prNumber, stateKey });
    }
  }

  return [...targetsByPr.values()].sort((left, right) => left.prNumber - right.prNumber);
}

export function cleanupMatrixForTargets(targets, options = {}) {
  return {
    include: targets.map((target) => ({
      pr_number: target.prNumber,
      checkout_ref: options.checkoutRef,
      image_sha: options.imageSha,
    })),
  };
}

export async function discoverPreviewCleanupTargets(options, dependencies = {}) {
  const errors = validateOptions(options);
  const baseRecord = {
    schemaVersion: DIGITALOCEAN_PREVIEW_CLEANUP_SWEEP_VERSION,
    checkedAt: options.checkedAt,
    bucket: options.bucket,
    endpointUrl: options.endpointUrl,
    prefix: trimSlashes(options.prefix),
    repository: options.repository,
    checkoutRef: options.checkoutRef,
    imageSha: options.imageSha,
    candidates: [],
    targets: [],
    result: "failure",
    errors,
  };
  if (errors.length > 0) {
    return { record: baseRecord, matrix: { include: [] } };
  }

  const awsJson =
    dependencies.awsJson ??
    ((args) => commandJson("aws", [...args, "--endpoint-url", options.endpointUrl], dependencies));
  const fetchPullRequest =
    dependencies.fetchPullRequest ??
    ((prNumber) =>
      fetchGithubPullRequest({
        repository: options.repository,
        githubToken: options.githubToken,
        prNumber,
      }));

  const record = { ...baseRecord, errors: [] };
  try {
    const listed = await awsJson([
      "s3api",
      "list-objects-v2",
      "--bucket",
      options.bucket,
      "--prefix",
      `${record.prefix}/`,
    ]);
    record.candidates = selectPreviewStateTargets(listed.Contents ?? listed.contents ?? [], {
      prefix: record.prefix,
    });
  } catch (error) {
    record.errors.push("Preview Terraform state listing failed.");
    record.errors.push(describeError(error));
    return { record, matrix: { include: [] } };
  }

  for (const candidate of record.candidates) {
    try {
      const pullRequest = await fetchPullRequest(candidate.prNumber);
      const state = String(pullRequest.state ?? "unknown");
      const target = {
        ...candidate,
        pullRequestState: state,
        merged: Boolean(pullRequest.merged),
        selected: state === "closed",
      };
      if (target.selected) {
        record.targets.push(target);
      }
    } catch (error) {
      record.errors.push(`PR #${candidate.prNumber} lookup failed: ${describeError(error)}`);
    }
  }

  record.result = record.errors.length > 0 ? "failure" : "success";
  return {
    record,
    matrix: cleanupMatrixForTargets(record.targets, {
      checkoutRef: options.checkoutRef,
      imageSha: options.imageSha,
    }),
  };
}

async function fetchGithubPullRequest(input) {
  const response = await fetch(`https://api.github.com/repos/${input.repository}/pulls/${input.prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub pull request lookup returned ${response.status}.`);
  }

  return response.json();
}

function validateOptions(options) {
  const errors = [];
  for (const key of ["bucket", "endpointUrl", "prefix", "repository", "checkoutRef", "imageSha", "checkedAt"]) {
    if (!isNonEmptyString(options[key])) {
      errors.push(`--${kebabCase(key)} is required.`);
    }
  }
  if (!isNonEmptyString(options.githubToken)) {
    errors.push("--github-token is required.");
  }
  return errors;
}

function parseArgs(argv, env = process.env) {
  return {
    command: argv[2] ?? "",
    bucket: readOption(argv, "--bucket", env.TERRAFORM_STATE_BUCKET ?? DEFAULT_STATE_BUCKET),
    endpointUrl: readOption(argv, "--endpoint-url", env.SPACES_ENDPOINT_URL ?? DEFAULT_SPACES_ENDPOINT),
    prefix: readOption(argv, "--prefix", env.PREVIEW_STATE_PREFIX ?? DEFAULT_PREVIEW_STATE_PREFIX),
    repository: readOption(argv, "--repo", env.GITHUB_REPOSITORY ?? ""),
    githubToken: readOption(argv, "--github-token", env.GITHUB_TOKEN ?? ""),
    checkoutRef: readOption(argv, "--checkout-ref", env.PREVIEW_CLEANUP_CHECKOUT_REF ?? ""),
    imageSha: readOption(argv, "--image-sha", env.PREVIEW_CLEANUP_IMAGE_SHA ?? ""),
    checkedAt: readOption(argv, "--checked-at", new Date().toISOString()),
    outPath: readOption(argv, "--out", env.PREVIEW_CLEANUP_SWEEP_OUT),
    githubOutputPath: readOption(argv, "--github-output", env.GITHUB_OUTPUT),
  };
}

function readOption(argv, name, fallback) {
  const inlinePrefix = `${name}=`;
  const inline = argv.find((entry) => entry.startsWith(inlinePrefix));
  if (inline) {
    return inline.slice(inlinePrefix.length);
  }
  const index = argv.indexOf(name);
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }
  return fallback;
}

async function writeGithubOutputs(outputPath, outputs) {
  if (!outputPath) {
    return;
  }
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value)}`);
  }
  await writeFile(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function trimSlashes(value) {
  return String(value ?? "").replace(/^\/+|\/+$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function describeError(error) {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 500) : String(error);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.command !== "discover") {
    throw new Error("Usage: node scripts/digitalocean-preview-cleanup-sweep.mjs discover [options]");
  }

  const result = await discoverPreviewCleanupTargets(options);
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  await writeGithubOutputs(options.githubOutputPath, {
    matrix: JSON.stringify(result.matrix),
    target_count: result.matrix.include.length,
    result: result.record.result,
  });
  if (result.record.result !== "success") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
