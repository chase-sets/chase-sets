#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const MERGE_QUEUE_POSTURE_VERSION = "merge-queue-posture/v1";
export const MERGE_QUEUE_RELEASE_POLICY_PATH = new URL("./release-health-merge-queue-policy.json", import.meta.url);

const PARAMETER_LABELS = {
  merge_method: "merge method",
  max_entries_to_build: "maximum pull requests to build",
  min_entries_to_merge: "minimum pull requests to merge",
  max_entries_to_merge: "maximum pull requests to merge",
  min_entries_to_merge_wait_minutes: "minimum wait before merging",
  grouping_strategy: "grouping strategy",
  check_response_timeout_minutes: "check response timeout",
};

export function parseMergeQueuePostureArgs(argv, env = process.env) {
  return {
    repository: readOption(argv, "--repository") ?? readEnv("GITHUB_REPOSITORY", env),
    token: readOption(argv, "--token") ?? readEnv("GH_TOKEN", env) ?? readEnv("GITHUB_TOKEN", env),
    outPath: readOption(argv, "--out") ?? readEnv("MERGE_QUEUE_POSTURE_OUT", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    fetchImpl: globalThis.fetch,
  };
}

export async function readMergeQueueReleasePolicy(path = MERGE_QUEUE_RELEASE_POLICY_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function fetchRuleset({ repository, rulesetId, token, fetchImpl }) {
  if (!repository) {
    throw new Error("GitHub repository is required.");
  }
  if (!Number.isInteger(rulesetId)) {
    throw new Error("Ruleset id is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const response = await fetchImpl(`https://api.github.com/repos/${repository}/rulesets/${rulesetId}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ruleset lookup failed: ${response.status}`);
  }
  return response.json();
}

export function buildMergeQueuePosture({ checkedAt, policy, ruleset }) {
  const mergeQueueRule = ruleset?.rules?.find((rule) => rule?.type === "merge_queue");
  const requiredChecksRule = ruleset?.rules?.find((rule) => rule?.type === "required_status_checks");
  const liveMergeQueue = mergeQueueRule?.parameters ?? {};
  const liveRequiredStatusChecks = (requiredChecksRule?.parameters?.required_status_checks ?? [])
    .map((check) => check?.context)
    .filter((context) => typeof context === "string")
    .sort();
  const policyRequiredStatusChecks = [...policy.requiredStatusChecks].sort();
  const drift = [];

  for (const [parameter, policyValue] of Object.entries(policy.mergeQueue)) {
    const liveValue = liveMergeQueue[parameter] ?? null;
    if (!equalValues(liveValue, policyValue)) {
      drift.push({
        parameter,
        label: PARAMETER_LABELS[parameter] ?? parameter,
        liveValue,
        policyValue,
      });
    }
  }

  if (!equalValues(liveRequiredStatusChecks, policyRequiredStatusChecks)) {
    drift.push({
      parameter: "required_status_checks",
      label: "required status checks",
      liveValue: liveRequiredStatusChecks,
      policyValue: policyRequiredStatusChecks,
    });
  }

  const record = {
    schemaVersion: MERGE_QUEUE_POSTURE_VERSION,
    checkedAt,
    mode: "advisory-read-only",
    repository: policy.repository,
    ruleset: {
      id: policy.rulesetId,
      name: ruleset?.name ?? null,
    },
    policy: {
      requiredStatusChecks: policyRequiredStatusChecks,
      mergeQueue: policy.mergeQueue,
    },
    live: {
      requiredStatusChecks: liveRequiredStatusChecks,
      mergeQueue: Object.fromEntries(Object.keys(policy.mergeQueue).map((key) => [key, liveMergeQueue[key] ?? null])),
    },
    drift,
    result: drift.length > 0 ? "warning" : "success",
  };

  return {
    record,
    passesPostureCheck: drift.length === 0,
    markdown: renderMergeQueuePostureMarkdown(record),
  };
}

export async function runMergeQueuePosture(options) {
  const policy = await readMergeQueueReleasePolicy(options.policyPath);
  if (options.repository && options.repository !== policy.repository) {
    throw new Error(`Merge-queue policy belongs to ${policy.repository}, not ${options.repository}.`);
  }
  const ruleset = await fetchRuleset({
    repository: policy.repository,
    rulesetId: policy.rulesetId,
    token: options.token,
    fetchImpl: options.fetchImpl,
  });
  const result = buildMergeQueuePosture({ checkedAt: options.checkedAt, policy, ruleset });
  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }
  return result;
}

export function renderMergeQueuePostureMarkdown(record) {
  const lines = [
    "## Merge queue posture",
    "",
    `- Result: ${record.result}`,
    `- Mode: ${record.mode}`,
    `- Ruleset: ${record.ruleset.name ?? "unknown"} (${record.ruleset.id})`,
    `- Drifted settings: ${record.drift.length}`,
  ];

  if (record.drift.length === 0) {
    lines.push("", "Clean: live merge-queue settings match the checked-in release policy.");
    return lines.join("\n");
  }

  lines.push("", "| Setting | Live | Policy |", "| --- | --- | --- |");
  for (const finding of record.drift) {
    lines.push(`| ${finding.label} | ${formatValue(finding.liveValue)} | ${formatValue(finding.policyValue)} |`);
  }
  return lines.join("\n");
}

function equalValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value) {
  return `\`${JSON.stringify(value)}\``;
}

async function main(argv, env = process.env) {
  try {
    const result = await runMergeQueuePosture(parseMergeQueuePostureArgs(argv, env));
    console.log(result.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
