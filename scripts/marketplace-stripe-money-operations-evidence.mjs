#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import webhookEventRegistry from "../infrastructure/stripe-config/webhook-events.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import {
  isIsoTimestamp,
  validateEvidenceReference,
  validateEvidenceReferences,
} from "./marketplace-evidence-references.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { PAYMENTS_PROVIDER_WEBHOOK_PATH, SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH } from "./provider-webhook-paths.mjs";

export const MARKETPLACE_STRIPE_MONEY_OPERATIONS_EVIDENCE_VERSION = "marketplace-stripe-money-operations-evidence/v1";
const MAX_STRIPE_MONEY_PROOF_AGE_DAYS = 30;

export const REQUIRED_STRIPE_MONEY_OPERATION_PROOFS = [
  "liveCheckoutProven",
  "refundProven",
  "disputeProven",
  "connectDashboardNoneConfigured",
  "connectEmbeddedSetupSessionCreated",
  "connectPayoutSetupPageProven",
  "connectFreshSetupSessionsProven",
  "connectProviderReadinessRefreshProven",
  "connectAccountWebhookRowsProven",
  "connectNoSensitiveProviderDataStored",
  "connectCustomAccountProofProven",
  "connectReleaseHardeningFindingsResolved",
  "stagingCustomConnectSandboxSmokeProven",
  "connectRollbackRehearsalProven",
  "payoutReadinessProven",
  "payoutPreviewAndRequestProven",
  "transferAndConnectedAccountPayoutProven",
  "payoutFailureReversalProven",
  "reconciliationProven",
  "platformBalanceFundingProven",
  "webhookReplayProven",
  "radarRiskPostureApproved",
];

export const REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES = [
  "liveCheckoutReference",
  "refundReference",
  "disputeReference",
  "connectCustomAccountProofReference",
  "connectEmbeddedSetupSessionReference",
  "connectPayoutSetupPageReference",
  "connectFreshSetupSessionsReference",
  "connectProviderReadinessRefreshReference",
  "connectAccountWebhookRowsReference",
  "connectSensitiveDataReviewReference",
  "connectReleaseHardeningReference",
  "stagingCustomConnectSandboxSmokeReference",
  "connectRollbackRehearsalReference",
  "payoutReadinessReference",
  "payoutPreviewAndRequestReference",
  "transferAndConnectedAccountPayoutReference",
  "payoutFailureReversalReference",
  "reconciliationReference",
  "platformBalanceFundingReference",
  "webhookReplayReference",
  "paymentProviderEventQueryReference",
  "connectProviderEventQueryReference",
  "radarRiskPostureReference",
];

export const REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS = [
  { key: "livePaymentIntentId", prefix: "pi_" },
  { key: "liveCheckoutSessionId", prefix: "cs_" },
  { key: "refundId", prefix: "re_" },
  { key: "disputeId", prefix: "dp_" },
  { key: "connectAccountId", prefix: "acct_" },
  { key: "payoutReadinessAccountId", prefix: "acct_" },
  { key: "payoutFailurePayoutId", prefix: "po_" },
  { key: "payoutFailureBalanceTransactionId", prefix: "txn_" },
  { key: "platformFundingBalanceTransactionId", prefix: "txn_" },
];

export const REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS = [
  { key: "paymentProviderEventIds", prefix: "evt_", minimumCount: 5 },
  { key: "connectProviderEventIds", prefix: "evt_", minimumCount: 2 },
];

const PRODUCTION_STRIPE_WEBHOOK_HOSTS = new Set(["chasesets.com", "admin.chasesets.com", "marketplace.chasesets.com"]);

const PRODUCTION_STRIPE_PAYMENT_WEBHOOK_PATH = PAYMENTS_PROVIDER_WEBHOOK_PATH;
const PRODUCTION_STRIPE_CONNECT_WEBHOOK_PATH = SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH;

const PRODUCTION_STRIPE_CONNECT_PAYOUT_SETUP_PATH = "/account/payouts/setup";
const CONNECT_PAYOUT_SETUP_EVIDENCE_KINDS = new Set(["screenshot", "redacted-run-output"]);
const STRIPE_CONNECT_ACCOUNTS_APIS = new Set(["v1", "v2"]);
const STRIPE_ID_PLACEHOLDER_PATTERN = /(?:placeholder|example|sample|test|todo|tbd|none|null)/i;

export function parseStripeMoneyOperationsEvidenceArgs(argv, env = process.env) {
  return {
    proofPath: readOption(argv, "--proof") ?? readEnv("STRIPE_MONEY_OPERATIONS_PROOF_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("STRIPE_MONEY_OPERATIONS_OWNER", env) ?? "Payments and Settlement",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readStripeMoneyOperationsProof(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildStripeMoneyOperationsEvidence(input) {
  const proof = normalizeStripeMoneyOperationsProof(input.proof);
  const errors = [...validateRequiredInputs(input), ...validateStripeMoneyOperationsProof(proof, input.checkedAt)];
  const passesStripeMoneyOperationsGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_STRIPE_MONEY_OPERATIONS_EVIDENCE_VERSION,
    approved: passesStripeMoneyOperationsGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    proofReference: proof.proofReference,
    proofCompletedAt: proof.proofCompletedAt,
    environment: proof.environment,
    releaseCommit: proof.releaseCommit,
    apiVersion: proof.apiVersion,
    paymentWebhookDestination: proof.paymentWebhookDestination,
    connectWebhookDestination: proof.connectWebhookDestination,
    connectAccountsApi: proof.connectAccountsApi,
    connectCustomAccountProofCompletedAt: proof.connectCustomAccountProofCompletedAt,
    connectPayoutSetupPageUrl: proof.connectPayoutSetupPageUrl,
    connectPayoutSetupPageEvidenceKind: proof.connectPayoutSetupPageEvidenceKind,
    connectDashboardAccess: proof.connectDashboardAccess,
    connectControllerFeesPayer: proof.connectControllerFeesPayer,
    connectControllerLossesCollector: proof.connectControllerLossesCollector,
    connectControllerRequirementCollection: proof.connectControllerRequirementCollection,
    connectConnectedAccountCount: proof.connectConnectedAccountCount,
    connectCustomDashboardNoneAccountCount: proof.connectCustomDashboardNoneAccountCount,
    connectEmbeddedSetupSessionCount: proof.connectEmbeddedSetupSessionCount,
    connectReleaseHardeningOpenP0P2FindingCount: proof.connectReleaseHardeningOpenP0P2FindingCount,
    sensitiveProviderDataStoredCount: proof.sensitiveProviderDataStoredCount,
    paymentProviderEventRowCount: proof.paymentProviderEventRowCount,
    connectProviderEventRowCount: proof.connectProviderEventRowCount,
    ...Object.fromEntries(REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS.map(({ key }) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS.map(({ key }) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES.map((key) => [key, proof[key]])),
    ...Object.fromEntries(REQUIRED_STRIPE_MONEY_OPERATION_PROOFS.map((key) => [key, proof[key]])),
    passesStripeMoneyOperationsGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runStripeMoneyOperationsEvidence(options) {
  const proof = await readStripeMoneyOperationsProof(options.proofPath);
  return buildStripeMoneyOperationsEvidence({
    ...options,
    proof,
  });
}

async function main(argv, env = process.env) {
  const options = parseStripeMoneyOperationsEvidenceArgs(argv, env);
  const optionErrors = validateStripeMoneyOperationsEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runStripeMoneyOperationsEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesStripeMoneyOperationsGate) {
    console.error("Stripe money operations evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeStripeMoneyOperationsProof(proof) {
  if (!isRecord(proof)) {
    throw new Error("Stripe money operations proof record must be a JSON object.");
  }

  return {
    proofReference: requireString(proof.proofReference, "Stripe proofReference"),
    proofCompletedAt: requireString(proof.proofCompletedAt, "Stripe proofCompletedAt"),
    environment: requireString(proof.environment, "Stripe proof environment"),
    releaseCommit: requireString(proof.releaseCommit, "Stripe proof releaseCommit"),
    apiVersion: requireString(proof.apiVersion, "Stripe API version"),
    paymentWebhookDestination: requireString(proof.paymentWebhookDestination, "Stripe paymentWebhookDestination"),
    connectWebhookDestination: requireString(proof.connectWebhookDestination, "Stripe connectWebhookDestination"),
    connectAccountsApi: requireString(proof.connectAccountsApi, "Stripe connectAccountsApi"),
    connectCustomAccountProofCompletedAt: requireString(
      proof.connectCustomAccountProofCompletedAt,
      "Stripe connectCustomAccountProofCompletedAt",
    ),
    connectPayoutSetupPageUrl: requireString(proof.connectPayoutSetupPageUrl, "Stripe connectPayoutSetupPageUrl"),
    connectPayoutSetupPageEvidenceKind: requireString(
      proof.connectPayoutSetupPageEvidenceKind,
      "Stripe connectPayoutSetupPageEvidenceKind",
    ),
    connectDashboardAccess: requireString(proof.connectDashboardAccess, "Stripe connectDashboardAccess"),
    connectControllerFeesPayer: requireString(proof.connectControllerFeesPayer, "Stripe connectControllerFeesPayer"),
    connectControllerLossesCollector: requireString(
      proof.connectControllerLossesCollector,
      "Stripe connectControllerLossesCollector",
    ),
    connectControllerRequirementCollection: requireString(
      proof.connectControllerRequirementCollection,
      "Stripe connectControllerRequirementCollection",
    ),
    connectConnectedAccountCount: requireNonNegativeInteger(
      proof.connectConnectedAccountCount,
      "Stripe connectConnectedAccountCount",
    ),
    connectCustomDashboardNoneAccountCount: requireNonNegativeInteger(
      proof.connectCustomDashboardNoneAccountCount,
      "Stripe connectCustomDashboardNoneAccountCount",
    ),
    connectEmbeddedSetupSessionCount: requireNonNegativeInteger(
      proof.connectEmbeddedSetupSessionCount,
      "Stripe connectEmbeddedSetupSessionCount",
    ),
    connectReleaseHardeningOpenP0P2FindingCount: requireNonNegativeInteger(
      proof.connectReleaseHardeningOpenP0P2FindingCount,
      "Stripe connectReleaseHardeningOpenP0P2FindingCount",
    ),
    sensitiveProviderDataStoredCount: requireNonNegativeInteger(
      proof.sensitiveProviderDataStoredCount,
      "Stripe sensitiveProviderDataStoredCount",
    ),
    paymentProviderEventRowCount: requireNonNegativeInteger(
      proof.paymentProviderEventRowCount,
      "Stripe paymentProviderEventRowCount",
    ),
    connectProviderEventRowCount: requireNonNegativeInteger(
      proof.connectProviderEventRowCount,
      "Stripe connectProviderEventRowCount",
    ),
    ...Object.fromEntries(
      REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS.map(({ key }) => [
        key,
        requireString(proof[key], `Stripe money operations ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS.map(({ key }) => [
        key,
        requireStringArray(proof[key], `Stripe money operations ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES.map((key) => [
        key,
        requireString(proof[key], `Stripe money operations ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_STRIPE_MONEY_OPERATION_PROOFS.map((key) => [
        key,
        requireBoolean(proof[key], `Stripe money operations ${key}`),
      ]),
    ),
  };
}

function validateStripeMoneyOperationsEvidenceOptions(options) {
  const errors = [];
  if (!options.proofPath) {
    errors.push("STRIPE_MONEY_OPERATIONS_PROOF_RECORD or --proof is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push(
      "Stripe money operations evidence requires --reference or PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE.",
    );
  } else {
    validateEvidenceReference("PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Stripe money operations evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Stripe money operations evidence requires checkedAt.");
  }
  return errors;
}

function validateStripeMoneyOperationsProof(proof, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_STRIPE_MONEY_OPERATION_PROOFS) {
    if (proof[key] !== true) {
      errors.push(`Stripe money operations proof must prove ${key}=true.`);
    }
  }
  if (proof.environment.toLowerCase() !== "live") {
    errors.push("Stripe money operations proof must use Stripe live mode.");
  }
  validateProofCompletedAt(proof.proofCompletedAt, checkedAt, errors);
  validateCustomConnectProofCompletedAt(proof.connectCustomAccountProofCompletedAt, checkedAt, errors);
  validateReleaseCommit("Stripe money operations", proof.releaseCommit, errors);
  validateEvidenceReference("Stripe money operations proofReference", proof.proofReference, errors);
  if (proof.apiVersion !== webhookEventRegistry.apiVersion) {
    errors.push(`Stripe money operations proof must confirm API version ${webhookEventRegistry.apiVersion}.`);
  }
  if (!isProductionStripeUrl(proof.paymentWebhookDestination, PRODUCTION_STRIPE_PAYMENT_WEBHOOK_PATH)) {
    errors.push(
      "Stripe money operations proof must use the production Chase Sets payment provider webhook destination.",
    );
  }
  if (!isProductionStripeUrl(proof.connectWebhookDestination, PRODUCTION_STRIPE_CONNECT_WEBHOOK_PATH)) {
    errors.push(
      "Stripe money operations proof must use the production Chase Sets Connect money-movement webhook destination.",
    );
  }
  if (!STRIPE_CONNECT_ACCOUNTS_APIS.has(proof.connectAccountsApi)) {
    errors.push("Stripe money operations proof must set connectAccountsApi to v1 or v2.");
  }
  if (!isProductionStripeUrl(proof.connectPayoutSetupPageUrl, PRODUCTION_STRIPE_CONNECT_PAYOUT_SETUP_PATH)) {
    errors.push("Stripe money operations proof must use the production Chase Sets embedded payout setup page.");
  }
  if (!CONNECT_PAYOUT_SETUP_EVIDENCE_KINDS.has(proof.connectPayoutSetupPageEvidenceKind)) {
    errors.push(
      "Stripe money operations proof must include connectPayoutSetupPageEvidenceKind of screenshot or redacted-run-output.",
    );
  }
  if (proof.connectDashboardAccess !== "none") {
    errors.push("Stripe money operations proof must configure dashboard access as none for Custom accounts.");
  }
  if (proof.connectControllerFeesPayer !== "application") {
    errors.push("Stripe money operations proof must configure Connect fees payer as application.");
  }
  if (proof.connectControllerLossesCollector !== "application") {
    errors.push("Stripe money operations proof must configure Connect losses collector as application.");
  }
  if (proof.connectControllerRequirementCollection !== "application") {
    errors.push("Stripe money operations proof must configure Connect requirement collection as application.");
  }
  if (proof.connectConnectedAccountCount <= 0) {
    errors.push("Stripe money operations proof must include at least one live connected account.");
  }
  if (proof.connectCustomDashboardNoneAccountCount <= 0) {
    errors.push("Stripe money operations proof must include at least one live dashboard-none connected account.");
  }
  if (proof.connectEmbeddedSetupSessionCount < 2) {
    errors.push("Stripe money operations proof must include at least two fresh embedded setup sessions.");
  }
  if (proof.connectReleaseHardeningOpenP0P2FindingCount !== 0) {
    errors.push("Stripe money operations proof must resolve all P0-P2 custom Connect hardening findings.");
  }
  if (proof.sensitiveProviderDataStoredCount !== 0) {
    errors.push("Stripe money operations proof must not store raw sensitive provider data in Chase Sets.");
  }
  if (proof.paymentProviderEventRowCount < 5) {
    errors.push("Stripe money operations proof must include at least five Payments provider webhook event rows.");
  }
  if (proof.connectProviderEventRowCount < 2) {
    errors.push(
      "Stripe money operations proof must include at least two Settlement money-movement provider webhook event rows.",
    );
  }
  validateStripeIdentifiers("Stripe money operations", proof, REQUIRED_STRIPE_MONEY_OPERATION_IDENTIFIERS, errors);
  validateStripeEventIdGroups(
    "Stripe money operations",
    proof,
    REQUIRED_STRIPE_MONEY_OPERATION_EVENT_ID_GROUPS,
    errors,
  );
  validateEvidenceReferences("Stripe money operations", proof, REQUIRED_STRIPE_MONEY_OPERATION_REFERENCES, errors);
  return errors;
}

function validateStripeIdentifiers(label, proof, specs, errors) {
  for (const { key, prefix } of specs) {
    if (isNonEmptyString(proof[key]) && !isConcreteStripeId(proof[key], prefix)) {
      errors.push(`${label} ${key} must be a concrete Stripe identifier starting with ${prefix}.`);
    }
  }
}

function validateStripeEventIdGroups(label, proof, specs, errors) {
  for (const { key, prefix, minimumCount } of specs) {
    const values = proof[key];
    if (values.length < minimumCount) {
      errors.push(`${label} ${key} must include at least ${minimumCount} concrete Stripe event IDs.`);
    }
    if (new Set(values).size !== values.length) {
      errors.push(`${label} ${key} must not contain duplicate Stripe event IDs.`);
    }
    if (values.some((value) => !isConcreteStripeId(value, prefix))) {
      errors.push(`${label} ${key} entries must be concrete Stripe identifiers starting with ${prefix}.`);
    }
  }
}

function isConcreteStripeId(value, prefix) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return (
    normalized.startsWith(prefix) &&
    normalized.length >= prefix.length + 6 &&
    /^[A-Za-z0-9_]+$/.test(normalized.slice(prefix.length)) &&
    !STRIPE_ID_PLACEHOLDER_PATTERN.test(normalized)
  );
}

function validateProofCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Stripe money operations proofCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Stripe money operations evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const proofCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (proofCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Stripe money operations proofCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - proofCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_STRIPE_MONEY_PROOF_AGE_DAYS) {
    errors.push(
      `Stripe money operations proofCompletedAt cannot be older than ${MAX_STRIPE_MONEY_PROOF_AGE_DAYS} days.`,
    );
  }
}

function validateCustomConnectProofCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Stripe money operations connectCustomAccountProofCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    return;
  }

  const proofCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (proofCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Stripe money operations connectCustomAccountProofCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - proofCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_STRIPE_MONEY_PROOF_AGE_DAYS) {
    errors.push(
      `Stripe money operations connectCustomAccountProofCompletedAt cannot be older than ${MAX_STRIPE_MONEY_PROOF_AGE_DAYS} days.`,
    );
  }
}

function isProductionStripeUrl(value, expectedPathname) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      PRODUCTION_STRIPE_WEBHOOK_HOSTS.has(url.hostname) &&
      url.pathname === expectedPathname
    );
  } catch {
    return false;
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
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  if (value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`${label} must only contain non-empty strings.`);
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
