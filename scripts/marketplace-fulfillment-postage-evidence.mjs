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
import { FULFILLMENT_POSTAGE_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";

export const MARKETPLACE_FULFILLMENT_POSTAGE_EVIDENCE_VERSION = "marketplace-fulfillment-postage-evidence/v1";
const MAX_FULFILLMENT_POSTAGE_PROOF_AGE_DAYS = 30;
const PRODUCTION_POSTAGE_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);
const PRODUCTION_POSTAGE_WEBHOOK_PATH = FULFILLMENT_POSTAGE_WEBHOOK_PATH;

export const REQUIRED_FULFILLMENT_POSTAGE_PROOFS = [
  "easyPostProductionModeProven",
  "webhookDestinationConfigured",
  "providerEventRowsProven",
  "parcelLabelPurchaseProven",
  "labelVoidRefundProven",
  "trackingEventProven",
  "deliveryExceptionProven",
  "letterMailpieceHandlingProven",
];

export const REQUIRED_FULFILLMENT_POSTAGE_REFERENCES = [
  "easyPostAccountReference",
  "webhookDestinationReference",
  "providerEventQueryReference",
  "parcelLabelReference",
  "labelVoidRefundReference",
  "trackingEventReference",
  "deliveryExceptionReference",
  "letterMailpieceReference",
];

export const REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS = [
  "controlledParcelShipmentId",
  "parcelProviderShipmentId",
  "parcelProviderLabelId",
  "trackingProviderObjectReference",
  "trackingIdentifier",
  "labelVoidRefundProviderObjectReference",
  "letterMailpieceShipmentId",
];

export const FULFILLMENT_POSTAGE_DELIVERY_EXCEPTION_EVIDENCE_KINDS = ["provider-event", "fulfillment-rehearsal"];

export const REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS = [
  { key: "providerEventIds", minimumCount: 4 },
  { key: "trackingStatusProviderEventIds", minimumCount: 3 },
  { key: "refundStatusProviderEventIds", minimumCount: 1 },
];

export function parseFulfillmentPostageEvidenceArgs(argv, env = process.env) {
  return {
    proofPath: readOption(argv, "--proof") ?? readEnv("FULFILLMENT_POSTAGE_PROOF_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("FULFILLMENT_POSTAGE_OWNER", env) ?? "Fulfillment",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readFulfillmentPostageProof(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildFulfillmentPostageEvidence(input) {
  const proof = normalizeFulfillmentPostageProof(input.proof);
  const errors = [...validateRequiredInputs(input), ...validateFulfillmentPostageProof(proof, input.checkedAt)];
  const passesFulfillmentPostageGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_FULFILLMENT_POSTAGE_EVIDENCE_VERSION,
    approved: passesFulfillmentPostageGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    proofReference: proof.proofReference,
    proofCompletedAt: proof.proofCompletedAt,
    environment: proof.environment,
    releaseCommit: proof.releaseCommit,
    easyPostMode: proof.easyPostMode,
    webhookDestination: proof.webhookDestination,
    providerEventRowCount: proof.providerEventRowCount,
    matchedShipmentProviderEventRowCount: proof.matchedShipmentProviderEventRowCount,
    trackingStatusProviderEventRowCount: proof.trackingStatusProviderEventRowCount,
    refundStatusProviderEventRowCount: proof.refundStatusProviderEventRowCount,
    ...Object.fromEntries(REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS.map((key) => [key, proof[key]])),
    deliveryExceptionEvidenceKind: proof.deliveryExceptionEvidenceKind,
    ...(proof.deliveryExceptionProviderEventId
      ? { deliveryExceptionProviderEventId: proof.deliveryExceptionProviderEventId }
      : {}),
    ...(proof.deliveryExceptionRehearsalShipmentId
      ? { deliveryExceptionRehearsalShipmentId: proof.deliveryExceptionRehearsalShipmentId }
      : {}),
    ...Object.fromEntries(REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS.map(({ key }) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_FULFILLMENT_POSTAGE_REFERENCES.map((key) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_FULFILLMENT_POSTAGE_PROOFS.map((key) => [key, proof[key]])),
    passesFulfillmentPostageGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runFulfillmentPostageEvidence(options) {
  const proof = await readFulfillmentPostageProof(options.proofPath);
  return buildFulfillmentPostageEvidence({
    ...options,
    proof,
  });
}

async function main(argv, env = process.env) {
  const options = parseFulfillmentPostageEvidenceArgs(argv, env);
  const optionErrors = validateFulfillmentPostageEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runFulfillmentPostageEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesFulfillmentPostageGate) {
    console.error("Fulfillment postage evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeFulfillmentPostageProof(proof) {
  if (!isRecord(proof)) {
    throw new Error("Fulfillment postage proof record must be a JSON object.");
  }

  return {
    proofReference: requireString(proof.proofReference, "Fulfillment postage proofReference"),
    proofCompletedAt: requireString(proof.proofCompletedAt, "Fulfillment postage proofCompletedAt"),
    environment: requireString(proof.environment, "Fulfillment postage environment"),
    releaseCommit: requireString(proof.releaseCommit, "Fulfillment postage releaseCommit"),
    easyPostMode: requireString(proof.easyPostMode, "Fulfillment postage easyPostMode"),
    webhookDestination: requireString(proof.webhookDestination, "Fulfillment postage webhookDestination"),
    providerEventRowCount: requireNonNegativeInteger(
      proof.providerEventRowCount,
      "Fulfillment postage providerEventRowCount",
    ),
    matchedShipmentProviderEventRowCount: requireNonNegativeInteger(
      proof.matchedShipmentProviderEventRowCount,
      "Fulfillment postage matchedShipmentProviderEventRowCount",
    ),
    trackingStatusProviderEventRowCount: requireNonNegativeInteger(
      proof.trackingStatusProviderEventRowCount,
      "Fulfillment postage trackingStatusProviderEventRowCount",
    ),
    refundStatusProviderEventRowCount: requireNonNegativeInteger(
      proof.refundStatusProviderEventRowCount,
      "Fulfillment postage refundStatusProviderEventRowCount",
    ),
    ...Object.fromEntries(
      REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS.map((key) => [
        key,
        requireString(proof[key], `Fulfillment postage ${key}`),
      ]),
    ),
    deliveryExceptionEvidenceKind: normalizeDeliveryExceptionEvidenceKind(proof),
    deliveryExceptionProviderEventId: optionalString(proof.deliveryExceptionProviderEventId),
    deliveryExceptionRehearsalShipmentId: optionalString(proof.deliveryExceptionRehearsalShipmentId),
    ...Object.fromEntries(
      REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS.map(({ key }) => [
        key,
        requireStringArray(proof[key], `Fulfillment postage ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_FULFILLMENT_POSTAGE_REFERENCES.map((key) => [
        key,
        requireString(proof[key], `Fulfillment postage ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_FULFILLMENT_POSTAGE_PROOFS.map((key) => [key, requireBoolean(proof[key], `Fulfillment postage ${key}`)]),
    ),
  };
}

function validateFulfillmentPostageEvidenceOptions(options) {
  const errors = [];
  if (!options.proofPath) {
    errors.push("FULFILLMENT_POSTAGE_PROOF_RECORD or --proof is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Fulfillment postage evidence requires --reference or PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE.");
  } else {
    validateEvidenceReference("PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Fulfillment postage evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Fulfillment postage evidence requires checkedAt.");
  }
  return errors;
}

function validateFulfillmentPostageProof(proof, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_FULFILLMENT_POSTAGE_PROOFS) {
    if (proof[key] !== true) {
      errors.push(`Fulfillment postage proof must prove ${key}=true.`);
    }
  }
  if (proof.environment.toLowerCase() !== "production") {
    errors.push("Fulfillment postage proof must run against production before marketplace launch.");
  }
  if (proof.easyPostMode.toLowerCase() !== "production") {
    errors.push("Fulfillment postage proof must use EasyPost production mode.");
  }
  validateProofCompletedAt(proof.proofCompletedAt, checkedAt, errors);
  validateReleaseCommit("Fulfillment postage", proof.releaseCommit, errors);
  validateEvidenceReference("Fulfillment postage proofReference", proof.proofReference, errors);
  validateEvidenceReferences("Fulfillment postage", proof, REQUIRED_FULFILLMENT_POSTAGE_REFERENCES, errors);
  validateProductionPostageWebhookDestination(proof.webhookDestination, errors);
  if (proof.providerEventRowsProven && proof.providerEventRowCount < 4) {
    errors.push("Fulfillment postage proof must include at least four provider event rows.");
  }
  if (proof.matchedShipmentProviderEventRowCount < 4) {
    errors.push("Fulfillment postage proof must include at least four provider event rows matched to shipments.");
  }
  if (proof.trackingStatusProviderEventRowCount < 3) {
    errors.push("Fulfillment postage proof must include at least three tracking-status provider event rows.");
  }
  if (proof.refundStatusProviderEventRowCount < 1) {
    errors.push("Fulfillment postage proof must include at least one refund-status provider event row.");
  }
  validateFulfillmentPostageIdentifiers(proof, errors);
  validateFulfillmentPostageEventIdGroups(proof, errors);
  return errors;
}

function validateFulfillmentPostageIdentifiers(proof, errors) {
  validateConcreteIdentifier(
    "Fulfillment postage controlledParcelShipmentId",
    proof.controlledParcelShipmentId,
    errors,
  );
  validateEasyPostId("Fulfillment postage parcelProviderShipmentId", proof.parcelProviderShipmentId, "shp_", errors);
  validateEasyPostId("Fulfillment postage parcelProviderLabelId", proof.parcelProviderLabelId, "pl_", errors);
  validateEasyPostId(
    "Fulfillment postage trackingProviderObjectReference",
    proof.trackingProviderObjectReference,
    "trk_",
    errors,
  );
  validateConcreteIdentifier("Fulfillment postage trackingIdentifier", proof.trackingIdentifier, errors);
  validateFulfillmentPostageDeliveryExceptionEvidence(proof, errors);
  validateConcreteIdentifier(
    "Fulfillment postage labelVoidRefundProviderObjectReference",
    proof.labelVoidRefundProviderObjectReference,
    errors,
  );
  validateConcreteIdentifier("Fulfillment postage letterMailpieceShipmentId", proof.letterMailpieceShipmentId, errors);
}

function validateFulfillmentPostageDeliveryExceptionEvidence(proof, errors) {
  if (!FULFILLMENT_POSTAGE_DELIVERY_EXCEPTION_EVIDENCE_KINDS.includes(proof.deliveryExceptionEvidenceKind)) {
    errors.push(
      `Fulfillment postage deliveryExceptionEvidenceKind must be one of: ${FULFILLMENT_POSTAGE_DELIVERY_EXCEPTION_EVIDENCE_KINDS.join(
        ", ",
      )}.`,
    );
    return;
  }

  if (proof.deliveryExceptionEvidenceKind === "provider-event") {
    validateEasyPostId(
      "Fulfillment postage deliveryExceptionProviderEventId",
      proof.deliveryExceptionProviderEventId,
      "evt_",
      errors,
    );
    if (proof.deliveryExceptionRehearsalShipmentId) {
      validateConcreteIdentifier(
        "Fulfillment postage deliveryExceptionRehearsalShipmentId",
        proof.deliveryExceptionRehearsalShipmentId,
        errors,
      );
    }
    return;
  }

  validateConcreteIdentifier(
    "Fulfillment postage deliveryExceptionRehearsalShipmentId",
    proof.deliveryExceptionRehearsalShipmentId,
    errors,
  );
  if (proof.deliveryExceptionProviderEventId) {
    validateEasyPostId(
      "Fulfillment postage deliveryExceptionProviderEventId",
      proof.deliveryExceptionProviderEventId,
      "evt_",
      errors,
    );
  }
}

function validateFulfillmentPostageEventIdGroups(proof, errors) {
  for (const { key, minimumCount } of REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS) {
    const values = proof[key];
    if (values.length < minimumCount) {
      errors.push(`Fulfillment postage ${key} must include at least ${minimumCount} concrete EasyPost event IDs.`);
    }
    if (new Set(values).size !== values.length) {
      errors.push(`Fulfillment postage ${key} must not contain duplicate EasyPost event IDs.`);
    }
    if (values.some((value) => !isConcreteEasyPostId(value, "evt_"))) {
      errors.push(`Fulfillment postage ${key} entries must be concrete EasyPost event IDs starting with evt_.`);
    }
  }
}

function validateEasyPostId(label, value, prefix, errors) {
  if (!isConcreteEasyPostId(value, prefix)) {
    errors.push(`${label} must be a concrete EasyPost identifier starting with ${prefix}.`);
  }
}

function isConcreteEasyPostId(value, prefix) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return (
    normalized.startsWith(prefix) &&
    normalized.length >= prefix.length + 6 &&
    /^[A-Za-z0-9_]+$/.test(normalized.slice(prefix.length)) &&
    !isPlaceholderIdentifier(normalized)
  );
}

function validateConcreteIdentifier(label, value, errors) {
  if (!isNonEmptyString(value) || value.trim().length < 6 || isPlaceholderIdentifier(value)) {
    errors.push(`${label} must be a concrete identifier, not a placeholder.`);
  }
}

function isPlaceholderIdentifier(value) {
  return /(?:placeholder|example|sample|test|todo|tbd|none|null|record|ticket)/i.test(value.trim());
}

function validateProofCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Fulfillment postage proofCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Fulfillment postage evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const proofCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (proofCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Fulfillment postage proofCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - proofCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_FULFILLMENT_POSTAGE_PROOF_AGE_DAYS) {
    errors.push(
      `Fulfillment postage proofCompletedAt cannot be older than ${MAX_FULFILLMENT_POSTAGE_PROOF_AGE_DAYS} days.`,
    );
  }
}

function validateProductionPostageWebhookDestination(value, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      errors.push("Fulfillment postage proof must use an HTTPS webhook destination.");
    }
    if (!PRODUCTION_POSTAGE_WEBHOOK_HOSTS.has(url.hostname) || url.pathname !== PRODUCTION_POSTAGE_WEBHOOK_PATH) {
      errors.push(
        "Fulfillment postage proof must use the Fulfillment postage provider webhook path on a production Chase Sets host.",
      );
    }
  } catch {
    errors.push("Fulfillment postage proof webhookDestination must be an absolute HTTPS URL.");
  }
}

function requireString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value) {
  return isNonEmptyString(value) ? value.trim() : null;
}

function normalizeDeliveryExceptionEvidenceKind(proof) {
  if (isNonEmptyString(proof.deliveryExceptionEvidenceKind)) {
    return proof.deliveryExceptionEvidenceKind.trim();
  }
  if (isNonEmptyString(proof.deliveryExceptionProviderEventId)) {
    return "provider-event";
  }
  if (isNonEmptyString(proof.deliveryExceptionRehearsalShipmentId)) {
    return "fulfillment-rehearsal";
  }
  throw new Error("Fulfillment postage deliveryExceptionEvidenceKind must be a non-empty string.");
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
