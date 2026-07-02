#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isIsoTimestamp,
  validateEvidenceReference,
  validateEvidenceReferences,
} from "./marketplace-evidence-references.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { NOTIFICATIONS_EMAIL_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";

export const MARKETPLACE_TRANSACTIONAL_EMAIL_EVIDENCE_VERSION = "marketplace-transactional-email-evidence/v1";
const MAX_TRANSACTIONAL_EMAIL_PROOF_AGE_DAYS = 30;
const PRODUCTION_EMAIL_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);
const PRODUCTION_EMAIL_WEBHOOK_PATH = NOTIFICATIONS_EMAIL_WEBHOOK_PATH;

export const REQUIRED_TRANSACTIONAL_EMAIL_PROOFS = [
  "sesDnsVerified",
  "controlledSendProven",
  "outboxDispatchProven",
  "bounceComplaintParsingProven",
  "deliveryMonitoringProven",
  "webhookDestinationConfigured",
  "snsSubscriptionConfirmed",
];

export const REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS = [
  "auth",
  "orders",
  "payments",
  "fulfillment",
  "refunds",
  "support",
  "payouts",
];

export const REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES = [
  "sesIdentityReference",
  "controlledSendMessageReference",
  "outboxDispatchReference",
  "deliveryEventReference",
  "bounceEventReference",
  "complaintEventReference",
  "deliveryMonitoringReference",
  "snsSubscriptionConfirmationReference",
  "templateReviewReference",
];

export const REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS = [
  "controlledSendProviderMessageId",
  "outboxRowId",
  "deliveryProviderEventId",
  "bounceProviderEventId",
  "complaintProviderEventId",
];

export function parseTransactionalEmailEvidenceArgs(argv, env = process.env) {
  return {
    proofPath: readOption(argv, "--proof") ?? readEnv("TRANSACTIONAL_EMAIL_PROOF_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("TRANSACTIONAL_EMAIL_OWNER", env) ?? "Notifications",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readTransactionalEmailProof(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildTransactionalEmailEvidence(input) {
  const proof = normalizeTransactionalEmailProof(input.proof);
  const errors = [...validateRequiredInputs(input), ...validateTransactionalEmailProof(proof, input.checkedAt)];
  const passesTransactionalEmailGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_TRANSACTIONAL_EMAIL_EVIDENCE_VERSION,
    approved: passesTransactionalEmailGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    proofReference: proof.proofReference,
    proofCompletedAt: proof.proofCompletedAt,
    environment: proof.environment,
    releaseCommit: proof.releaseCommit,
    sesConfigurationSetName: proof.sesConfigurationSetName,
    webhookDestination: proof.webhookDestination,
    providerEventRowCount: proof.providerEventRowCount,
    ...Object.fromEntries(REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS.map((key) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES.map((key) => [key, proof[key]])),
    criticalTemplateAreasCovered: proof.criticalTemplateAreasCovered,
    ...Object.fromEntries(REQUIRED_TRANSACTIONAL_EMAIL_PROOFS.map((key) => [key, proof[key]])),
    passesTransactionalEmailGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runTransactionalEmailEvidence(options) {
  const proof = await readTransactionalEmailProof(options.proofPath);
  return buildTransactionalEmailEvidence({
    ...options,
    proof,
  });
}

async function main(argv, env = process.env) {
  const options = parseTransactionalEmailEvidenceArgs(argv, env);
  const optionErrors = validateTransactionalEmailEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runTransactionalEmailEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesTransactionalEmailGate) {
    console.error("Transactional email evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeTransactionalEmailProof(proof) {
  if (!isRecord(proof)) {
    throw new Error("Transactional email proof record must be a JSON object.");
  }

  return {
    proofReference: requireString(proof.proofReference, "Transactional email proofReference"),
    proofCompletedAt: requireString(proof.proofCompletedAt, "Transactional email proofCompletedAt"),
    environment: requireString(proof.environment, "Transactional email environment"),
    releaseCommit: requireString(proof.releaseCommit, "Transactional email releaseCommit"),
    sesConfigurationSetName: requireString(
      proof.sesConfigurationSetName,
      "Transactional email sesConfigurationSetName",
    ),
    webhookDestination: requireString(proof.webhookDestination, "Transactional email webhookDestination"),
    providerEventRowCount: requireNonNegativeInteger(
      proof.providerEventRowCount,
      "Transactional email providerEventRowCount",
    ),
    ...Object.fromEntries(
      REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS.map((key) => [
        key,
        requireString(proof[key], `Transactional email ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES.map((key) => [
        key,
        requireString(proof[key], `Transactional email ${key}`),
      ]),
    ),
    criticalTemplateAreasCovered: requireStringArray(
      proof.criticalTemplateAreasCovered,
      "Transactional email criticalTemplateAreasCovered",
    ).map((entry) => entry.toLowerCase()),
    ...Object.fromEntries(
      REQUIRED_TRANSACTIONAL_EMAIL_PROOFS.map((key) => [key, requireBoolean(proof[key], `Transactional email ${key}`)]),
    ),
  };
}

function validateTransactionalEmailEvidenceOptions(options) {
  const errors = [];
  if (!options.proofPath) {
    errors.push("TRANSACTIONAL_EMAIL_PROOF_RECORD or --proof is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Transactional email evidence requires --reference or PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE.");
  } else {
    validateEvidenceReference("PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Transactional email evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Transactional email evidence requires checkedAt.");
  }
  return errors;
}

function validateTransactionalEmailProof(proof, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_TRANSACTIONAL_EMAIL_PROOFS) {
    if (proof[key] !== true) {
      errors.push(`Transactional email proof must prove ${key}=true.`);
    }
  }
  if (proof.environment.toLowerCase() !== "production") {
    errors.push("Transactional email proof must run against production before marketplace launch.");
  }
  validateProofCompletedAt(proof.proofCompletedAt, checkedAt, errors);
  validateReleaseCommit("Transactional email", proof.releaseCommit, errors);
  validateEvidenceReference("Transactional email proofReference", proof.proofReference, errors);
  validateEvidenceReferences("Transactional email", proof, REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES, errors);
  if (proof.sesConfigurationSetName !== "transactional-production") {
    errors.push("Transactional email proof must use the transactional-production SES configuration set.");
  }
  validateProductionEmailWebhookDestination(proof.webhookDestination, errors);
  if (proof.webhookDestinationConfigured && proof.providerEventRowCount < 3) {
    errors.push("Transactional email proof must include at least three provider event rows.");
  }
  validateTransactionalEmailIdentifiers(proof, errors);
  for (const area of REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS) {
    if (!proof.criticalTemplateAreasCovered.includes(area)) {
      errors.push(`Transactional email proof must include critical template area ${area}.`);
    }
  }
  return errors;
}

function validateTransactionalEmailIdentifiers(proof, errors) {
  validateConcreteIdentifier(
    "Transactional email controlledSendProviderMessageId",
    proof.controlledSendProviderMessageId,
    errors,
  );
  if (!/^[1-9]\d*$/.test(proof.outboxRowId)) {
    errors.push("Transactional email outboxRowId must be a positive notification_outbox row id.");
  }

  validateEmailProviderEventId(
    "Transactional email deliveryProviderEventId",
    proof.deliveryProviderEventId,
    "delivery",
    errors,
  );
  validateEmailProviderEventId(
    "Transactional email bounceProviderEventId",
    proof.bounceProviderEventId,
    "bounce",
    errors,
  );
  validateEmailProviderEventId(
    "Transactional email complaintProviderEventId",
    proof.complaintProviderEventId,
    "complaint",
    errors,
  );

  const providerEventIds = [proof.deliveryProviderEventId, proof.bounceProviderEventId, proof.complaintProviderEventId];
  if (new Set(providerEventIds).size !== providerEventIds.length) {
    errors.push("Transactional email provider event ids must be distinct.");
  }
}

function validateEmailProviderEventId(label, value, expectedKind, errors) {
  const match = /^amazon-ses:([^:]+):(delivery|bounce|complaint):(.+)$/.exec(value);
  if (!match) {
    errors.push(`${label} must use the amazon-ses:<message-id>:${expectedKind}:<occurred-at> format.`);
    return;
  }
  const [, providerMessageId, eventKind, occurredAt] = match;
  validateConcreteIdentifier(`${label} provider message id`, providerMessageId, errors);
  if (eventKind !== expectedKind) {
    errors.push(`${label} must be a ${expectedKind} provider event.`);
  }
  if (!isIsoTimestamp(occurredAt)) {
    errors.push(`${label} occurred-at value must be an ISO timestamp.`);
  }
}

function validateConcreteIdentifier(label, value, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }
  const normalized = value.trim();
  if (/^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record)$/i.test(normalized)) {
    errors.push(`${label} must be a concrete identifier, not a placeholder.`);
  }
}

function validateProofCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Transactional email proofCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Transactional email evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const proofCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (proofCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Transactional email proofCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - proofCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_TRANSACTIONAL_EMAIL_PROOF_AGE_DAYS) {
    errors.push(
      `Transactional email proofCompletedAt cannot be older than ${MAX_TRANSACTIONAL_EMAIL_PROOF_AGE_DAYS} days.`,
    );
  }
}

function validateProductionEmailWebhookDestination(value, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      errors.push("Transactional email proof must use an HTTPS webhook destination.");
    }
    if (!PRODUCTION_EMAIL_WEBHOOK_HOSTS.has(url.hostname) || url.pathname !== PRODUCTION_EMAIL_WEBHOOK_PATH) {
      errors.push(
        "Transactional email proof must use the Notifications email provider webhook path on a production Chase Sets host.",
      );
    }
  } catch {
    errors.push("Transactional email proof webhookDestination must be an absolute HTTPS URL.");
  }
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

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
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
