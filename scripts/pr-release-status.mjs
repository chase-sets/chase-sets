#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function parsePrReleaseStatusArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("PR_RELEASE_STATUS_OUT", env),
    prNumber: readOption(argv, "--pr-number") ?? readEnv("PR_NUMBER", env),
    prRequiredResult: readOption(argv, "--pr-required-result") ?? readEnv("PR_REQUIRED_RESULT", env) ?? "unknown",
    deploymentRequired: parseBoolean(
      readOption(argv, "--deployment-required") ?? readEnv("DEPLOYMENT_REQUIRED", env) ?? "false",
    ),
    previewResult: readOption(argv, "--preview-result") ?? readEnv("PREVIEW_RESULT", env) ?? "skipped",
    exposurePostureChanged: parseBoolean(
      readOption(argv, "--exposure-posture-changed") ?? readEnv("EXPOSURE_POSTURE_CHANGED", env) ?? "false",
    ),
    exposurePostureCategories:
      readOption(argv, "--exposure-posture-categories") ?? readEnv("EXPOSURE_POSTURE_CATEGORIES", env) ?? "",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function writePrReleaseStatus(options) {
  const markdown = buildPrReleaseStatus(options);
  if (!options.outPath) {
    throw new Error("PR_RELEASE_STATUS_OUT or --out is required.");
  }
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, markdown);
  return markdown;
}

export function buildPrReleaseStatus(input) {
  const categories = parseCategories(input.exposurePostureCategories);
  const deployLine = input.deploymentRequired
    ? "Deployable change: staging and production promotion will be required after merge queue admission."
    : "Non-deployable change: production promotion is not expected from this PR.";
  const exposureLine = input.exposurePostureChanged
    ? `Exposure posture changed: ${categories.length > 0 ? categories.join(", ") : "category not reported"}.`
    : "Exposure posture unchanged.";
  const queueLine =
    input.prRequiredResult === "success"
      ? "Merge queue readiness: PR Required passed; GitHub merge queue remains the admission gate."
      : `Merge queue readiness: PR Required is ${input.prRequiredResult}; do not queue until required checks are green.`;
  const previewLine = input.previewResult === "skipped" ? "Preview: not required." : `Preview: ${input.previewResult}.`;

  return [
    "<!-- chase-sets-pr-release-status -->",
    "## Release Status",
    "",
    `Checked at: \`${input.checkedAt}\``,
    "",
    `- ${queueLine}`,
    `- ${deployLine}`,
    `- ${previewLine}`,
    `- ${exposureLine}`,
    "- After merge, Platform Production records release-health evidence before advancing the production marker.",
    "",
  ].join("\n");
}

function parseCategories(value) {
  if (!value) {
    return [];
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
}

function parseBoolean(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main(argv, env = process.env) {
  try {
    const markdown = await writePrReleaseStatus(parsePrReleaseStatusArgs(argv, env));
    console.log(markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
