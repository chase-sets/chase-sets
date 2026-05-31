#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isIsoTimestamp,
  validateEvidenceIdentifier,
  validateEvidenceReference,
  validateEvidenceReferences,
} from "./marketplace-evidence-references.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";

export const MARKETPLACE_SUPPORT_OPERATIONS_EVIDENCE_VERSION = "marketplace-support-operations-evidence/v1";

const MAX_SUPPORT_REHEARSAL_AGE_DAYS = 30;

export const REQUIRED_SUPPORT_OPERATION_PROOFS = [
  "buyerIssueOpeningProven",
  "sellerIssueOpeningProven",
  "operationsQueueReviewProven",
  "overdueEscalationProven",
  "lifecycleEndpointsProven",
  "refundProducingResolutionProven",
  "settlementHoldCoordinationProven",
  "supportNotificationsProven",
];

export const REQUIRED_SUPPORT_REHEARSAL_REFERENCES = [
  "buyerSupportRequestId",
  "sellerSupportRequestId",
  "operationsQueueReviewReference",
  "overdueEscalationResultReference",
  "lifecycleEndpointResultReference",
  "refundResolutionSupportRequestId",
  "refundEffectId",
  "refundId",
  "refundEffectReference",
  "settlementHoldId",
  "settlementHoldReleaseReference",
  "settlementHoldReference",
  "supportNotificationReference",
];

export const REQUIRED_SUPPORT_REHEARSAL_IDENTIFIER_SPECS = [
  { key: "buyerSupportRequestId", prefix: "sup_" },
  { key: "sellerSupportRequestId", prefix: "sup_" },
  { key: "refundResolutionSupportRequestId", prefix: "sup_" },
  { key: "refundEffectId", prefix: "sre_" },
  { key: "refundId", prefix: "rfd_" },
  { key: "settlementHoldId", prefix: "hold_" },
];

export function parseSupportOperationsEvidenceArgs(argv, env = process.env) {
  return {
    rehearsalPath: readOption(argv, "--rehearsal") ?? readEnv("SUPPORT_OPERATIONS_REHEARSAL_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_SUPPORT_OPERATIONS_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("SUPPORT_OPERATIONS_OWNER", env) ?? "Support",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readSupportOperationsRehearsal(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildSupportOperationsEvidence(input) {
  const rehearsal = normalizeSupportOperationsRehearsal(input.rehearsal);
  const errors = [...validateRequiredInputs(input), ...validateSupportOperationProofs(rehearsal, input.checkedAt)];
  const passesSupportOperationsGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_SUPPORT_OPERATIONS_EVIDENCE_VERSION,
    approved: passesSupportOperationsGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    rehearsalReference: rehearsal.rehearsalReference,
    rehearsalCompletedAt: rehearsal.rehearsalCompletedAt,
    environment: rehearsal.environment,
    releaseCommit: rehearsal.releaseCommit,
    ...Object.fromEntries(REQUIRED_SUPPORT_REHEARSAL_REFERENCES.map((key) => [key, rehearsal[key]])),
    ...Object.fromEntries(REQUIRED_SUPPORT_OPERATION_PROOFS.map((key) => [key, rehearsal[key]])),
    passesSupportOperationsGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runSupportOperationsEvidence(options) {
  const rehearsal = await readSupportOperationsRehearsal(options.rehearsalPath);
  return buildSupportOperationsEvidence({
    ...options,
    rehearsal,
  });
}

async function main(argv, env = process.env) {
  const options = parseSupportOperationsEvidenceArgs(argv, env);
  const optionErrors = validateSupportOperationsEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runSupportOperationsEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesSupportOperationsGate) {
    console.error("Support operations evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeSupportOperationsRehearsal(rehearsal) {
  if (!isRecord(rehearsal)) {
    throw new Error("Support operations rehearsal record must be a JSON object.");
  }

  return {
    rehearsalReference: requireString(rehearsal.rehearsalReference, "Support rehearsalReference"),
    rehearsalCompletedAt: requireString(rehearsal.rehearsalCompletedAt, "Support rehearsalCompletedAt"),
    environment: requireString(rehearsal.environment, "Support rehearsal environment"),
    releaseCommit: requireString(rehearsal.releaseCommit, "Support rehearsal releaseCommit"),
    ...Object.fromEntries(
      REQUIRED_SUPPORT_REHEARSAL_REFERENCES.map((key) => [
        key,
        requireString(rehearsal[key], `Support rehearsal ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_SUPPORT_OPERATION_PROOFS.map((key) => [key, requireBoolean(rehearsal[key], `Support rehearsal ${key}`)]),
    ),
  };
}

function validateSupportOperationsEvidenceOptions(options) {
  const errors = [];
  if (!options.rehearsalPath) {
    errors.push("SUPPORT_OPERATIONS_REHEARSAL_RECORD or --rehearsal is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Support operations evidence requires --reference or PRODUCTION_SUPPORT_OPERATIONS_REFERENCE.");
  } else {
    validateEvidenceReference("PRODUCTION_SUPPORT_OPERATIONS_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Support operations evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Support operations evidence requires checkedAt.");
  }
  return errors;
}

function validateSupportOperationProofs(rehearsal, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_SUPPORT_OPERATION_PROOFS) {
    if (rehearsal[key] !== true) {
      errors.push(`Support operations rehearsal must prove ${key}=true.`);
    }
  }
  if (rehearsal.environment.toLowerCase() !== "staging") {
    errors.push("Support operations rehearsal must run against staging before production marketplace launch.");
  }
  validateRehearsalCompletedAt(rehearsal.rehearsalCompletedAt, checkedAt, errors);
  validateReleaseCommit("Support operations", rehearsal.releaseCommit, errors);
  validateEvidenceReference("Support operations rehearsalReference", rehearsal.rehearsalReference, errors);
  validateEvidenceReferences(
    "Support rehearsal",
    rehearsal,
    [
      "operationsQueueReviewReference",
      "overdueEscalationResultReference",
      "lifecycleEndpointResultReference",
      "refundEffectReference",
      "settlementHoldReference",
      "settlementHoldReleaseReference",
      "supportNotificationReference",
    ],
    errors,
  );
  for (const { key, prefix } of REQUIRED_SUPPORT_REHEARSAL_IDENTIFIER_SPECS) {
    validateEvidenceIdentifier(`Support rehearsal ${key}`, rehearsal[key], errors);
    if (isNonEmptyString(rehearsal[key]) && !rehearsal[key].startsWith(prefix)) {
      errors.push(`Support rehearsal ${key} must start with ${prefix}.`);
    }
  }
  if (rehearsal.buyerSupportRequestId === rehearsal.sellerSupportRequestId) {
    errors.push("Support operations rehearsal must use separate buyer and seller support request ids.");
  }
  if (rehearsal.refundResolutionSupportRequestId !== rehearsal.buyerSupportRequestId) {
    errors.push("Support operations rehearsal refund resolution must be tied to the buyer support request id.");
  }
  if (rehearsal.settlementHoldReleaseReference === rehearsal.settlementHoldReference) {
    errors.push("Support operations rehearsal must include separate hold and hold-release evidence references.");
  }
  return errors;
}

function validateRehearsalCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Support operations rehearsalCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Support operations evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const rehearsalCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (rehearsalCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Support operations rehearsalCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - rehearsalCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_SUPPORT_REHEARSAL_AGE_DAYS) {
    errors.push(`Support operations rehearsalCompletedAt cannot be older than ${MAX_SUPPORT_REHEARSAL_AGE_DAYS} days.`);
  }
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

function requireString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
