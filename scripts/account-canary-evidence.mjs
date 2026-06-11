#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, normalizeString, readEnv, readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const ACCOUNT_CANARY_EVIDENCE_VERSION = "account-canary-evidence/v1";

export function parseAccountCanaryEvidenceArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("ACCOUNT_CANARY_EVIDENCE_OUT", env),
    policyPath: readOption(argv, "--policy-file") ?? readEnv("ACCOUNT_CANARY_POLICY_FILE", env),
    releaseCommit: readOption(argv, "--release-commit") ?? readEnv("RELEASE_COMMIT", env),
    featureKey: readOption(argv, "--feature-key") ?? readEnv("ACCOUNT_CANARY_FEATURE_KEY", env),
    environment: readOption(argv, "--environment") ?? readEnv("ACCOUNT_CANARY_ENVIRONMENT", env) ?? "production",
    accountSubjects: readRepeatedOptions(argv, "--account").concat(
      parseSubjectList(readEnv("ACCOUNT_CANARY_ACCOUNTS", env)),
    ),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runAccountCanaryEvidence(options) {
  if (!options.policyPath) {
    throw new Error("ACCOUNT_CANARY_POLICY_FILE or --policy-file is required.");
  }
  const policy = JSON.parse(await readFile(options.policyPath, "utf8"));
  const result = buildAccountCanaryEvidence({ ...options, policy });

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result.record);
  }

  return result;
}

export function buildAccountCanaryEvidence(input) {
  const blockers = [];
  const featureKey = normalizeString(input.featureKey) ?? normalizeString(input.policy?.featureKey);
  const environment = normalizeString(input.environment) ?? normalizeString(input.policy?.environment) ?? "production";
  const policy = normalizePolicy(input.policy, environment);
  const accountSubjects = normalizeAccountSubjects(input.accountSubjects);

  if (!isCommitSha(input.releaseCommit)) {
    blockers.push("Account canary release commit must be a 40-character Git commit SHA.");
  }
  if (!featureKey) {
    blockers.push("Account canary feature key is required.");
  }
  if (accountSubjects.length === 0) {
    blockers.push("At least one account subject is required for a deterministic account canary.");
  }
  if (policy.percentage > 0) {
    blockers.push("Percentage rollout must remain 0 until deterministic account canary evidence passes.");
  }
  if (policy.killSwitchActive) {
    blockers.push("Kill switch is active; account canary must abort.");
  }

  const decisions = accountSubjects.map((subject) => evaluateAccountSubject(policy, subject));
  for (const decision of decisions) {
    if (!decision.enabled) {
      blockers.push(`Account canary subject ${decision.subject} is ${decision.reason}.`);
    }
  }

  const promotionDecision = blockers.length === 0 ? "promote" : "abort";
  const record = {
    schemaVersion: ACCOUNT_CANARY_EVIDENCE_VERSION,
    checkedAt: input.checkedAt,
    releaseCommit: input.releaseCommit ?? "",
    featureKey: featureKey ?? "",
    environment,
    cohort: {
      subjectType: "account",
      size: accountSubjects.length,
      subjects: accountSubjects,
    },
    policy: {
      percentage: policy.percentage,
      allowSubjects: policy.allowSubjects,
      optOutSubjects: policy.optOutSubjects,
      killSwitchActive: policy.killSwitchActive,
    },
    decisions,
    promotionDecision,
    releaseHealth: {
      canaryCohortSubjectType: "account",
      canaryCohortSize: accountSubjects.length,
      canaryPromotionDecision: promotionDecision,
    },
    blockers,
  };

  return {
    record,
    passesAccountCanaryGate: blockers.length === 0,
  };
}

function evaluateAccountSubject(policy, subject) {
  if (policy.killSwitchActive) {
    return { subject, enabled: false, reason: "disabled-by-kill-switch" };
  }
  if (policy.optOutSubjects.includes(subject)) {
    return { subject, enabled: false, reason: "opted-out" };
  }
  if (policy.allowSubjects.includes(subject)) {
    return { subject, enabled: true, reason: "allowlisted" };
  }
  return { subject, enabled: false, reason: "not-allowlisted" };
}

function normalizePolicy(policy, environment) {
  const rawPolicy = policy?.policy && typeof policy.policy === "object" ? policy.policy : policy;
  return {
    environment,
    percentage: normalizePercentage(rawPolicy?.percentage),
    allowSubjects: normalizeSubjectList(rawPolicy?.allowSubjects),
    optOutSubjects: normalizeSubjectList(rawPolicy?.optOutSubjects),
    killSwitchActive: Boolean(rawPolicy?.killSwitchActive),
  };
}

function normalizePercentage(value) {
  const percentage = Number(value ?? 0);
  if (!Number.isFinite(percentage) || percentage < 0) {
    return 0;
  }
  return Math.min(100, percentage);
}

function normalizeAccountSubjects(subjects) {
  return normalizeSubjectList(subjects)
    .map((subject) => (subject.startsWith("account:") ? subject : `account:${subject}`))
    .filter((subject, index, list) => list.indexOf(subject) === index)
    .sort();
}

function normalizeSubjectList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .sort();
  }
  return parseSubjectList(value).sort();
}

function parseSubjectList(value) {
  if (!normalizeString(value)) {
    return [];
  }
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function main(argv, env = process.env) {
  try {
    const result = await runAccountCanaryEvidence(parseAccountCanaryEvidenceArgs(argv, env));
    console.log(JSON.stringify(result.record, null, 2));
    return result.passesAccountCanaryGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
