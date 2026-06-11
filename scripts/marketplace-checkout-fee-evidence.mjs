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

export const MARKETPLACE_CHECKOUT_FEE_EVIDENCE_VERSION = "marketplace-checkout-fee-evidence/v1";
const MAX_CHECKOUT_FEE_APPROVAL_AGE_DAYS = 30;
export const REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION = "marketplace-checkout-fee-v1";
const LIVE_MARKETPLACE_CHECKOUT_FEE_POLICY_PATH = "/api/marketplace/account/marketplace-checkout-fee-policy";
const LIVE_MARKETPLACE_HOSTS = new Set(["chasesets.com", "marketplace.chasesets.com"]);

export const REQUIRED_CHECKOUT_FEE_PROOFS = [
  "buyerFacingCopyApproved",
  "feeLabelsApproved",
  "refundLanguageApproved",
  "stateDisclosureReviewApproved",
  "stripeLiveFeeConfigurationApproved",
];

const REQUIRED_CHECKOUT_FEE_REFERENCES = [
  "livePolicyEndpointReference",
  "buyerFacingCopyReference",
  "feeLabelsReference",
  "refundLanguageReference",
  "stateDisclosureReviewReference",
  "stripeLiveFeeConfigurationReference",
];

export function parseCheckoutFeeEvidenceArgs(argv, env = process.env) {
  return {
    approvalPath: readOption(argv, "--approval") ?? readEnv("MARKETPLACE_CHECKOUT_FEE_APPROVAL_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("MARKETPLACE_CHECKOUT_FEE_OWNER", env) ?? "Payments",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readCheckoutFeeApproval(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildCheckoutFeeEvidence(input) {
  const approval = normalizeCheckoutFeeApproval(input.approval);
  const errors = [...validateRequiredInputs(input), ...validateCheckoutFeeApproval(approval, input.checkedAt)];
  const passesCheckoutFeeGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_CHECKOUT_FEE_EVIDENCE_VERSION,
    approved: passesCheckoutFeeGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    approvalReference: approval.approvalReference,
    approvalCompletedAt: approval.approvalCompletedAt,
    environment: approval.environment,
    releaseCommit: approval.releaseCommit,
    feePolicyVersion: approval.feePolicyVersion,
    feePolicyEffectiveAt: approval.feePolicyEffectiveAt,
    enabledJurisdictions: approval.enabledJurisdictions,
    basePercentageBps: approval.basePercentageBps,
    baseFixedAmount: approval.baseFixedAmount,
    bankAccountResultingPercentageBps: approval.bankAccountResultingPercentageBps,
    bankAccountResultingFixedAmount: approval.bankAccountResultingFixedAmount,
    platformCreditResultingPercentageBps: approval.platformCreditResultingPercentageBps,
    platformCreditResultingFixedAmount: approval.platformCreditResultingFixedAmount,
    unsupportedMethodsDefault: approval.unsupportedMethodsDefault,
    feeQuoteConfirmationRequired: approval.feeQuoteConfirmationRequired,
    feeQuoteStaleResponseCode: approval.feeQuoteStaleResponseCode,
    feeQuoteStaleResponseError: approval.feeQuoteStaleResponseError,
    stripeMode: approval.stripeMode,
    livePolicyEndpointUrl: approval.livePolicyEndpointUrl,
    livePolicyEndpointStatusCode: approval.livePolicyEndpointStatusCode,
    livePolicyEndpointCheckedAt: approval.livePolicyEndpointCheckedAt,
    ...Object.fromEntries(REQUIRED_CHECKOUT_FEE_REFERENCES.map((key) => [key, approval[key]])),
    ...Object.fromEntries(REQUIRED_CHECKOUT_FEE_PROOFS.map((key) => [key, approval[key]])),
    passesCheckoutFeeGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runCheckoutFeeEvidence(options) {
  const approval = await readCheckoutFeeApproval(options.approvalPath);
  return buildCheckoutFeeEvidence({
    ...options,
    approval,
  });
}

async function main(argv, env = process.env) {
  const options = parseCheckoutFeeEvidenceArgs(argv, env);
  const optionErrors = validateCheckoutFeeEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runCheckoutFeeEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesCheckoutFeeGate) {
    console.error("Marketplace Checkout Fee evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeCheckoutFeeApproval(approval) {
  if (!isRecord(approval)) {
    throw new Error("Marketplace Checkout Fee approval record must be a JSON object.");
  }

  return {
    approvalReference: requireString(approval.approvalReference, "Marketplace Checkout Fee approvalReference"),
    approvalCompletedAt: requireString(approval.approvalCompletedAt, "Marketplace Checkout Fee approvalCompletedAt"),
    environment: requireString(approval.environment, "Marketplace Checkout Fee environment"),
    releaseCommit: requireString(approval.releaseCommit, "Marketplace Checkout Fee releaseCommit"),
    feePolicyVersion: requireString(approval.feePolicyVersion, "Marketplace Checkout Fee feePolicyVersion"),
    feePolicyEffectiveAt: requireString(approval.feePolicyEffectiveAt, "Marketplace Checkout Fee feePolicyEffectiveAt"),
    enabledJurisdictions: requireStringArray(
      approval.enabledJurisdictions,
      "Marketplace Checkout Fee enabledJurisdictions",
    ),
    basePercentageBps: requireNumber(approval.basePercentageBps, "Marketplace Checkout Fee basePercentageBps"),
    baseFixedAmount: requireString(approval.baseFixedAmount, "Marketplace Checkout Fee baseFixedAmount"),
    bankAccountResultingPercentageBps: requireNumber(
      approval.bankAccountResultingPercentageBps,
      "Marketplace Checkout Fee bankAccountResultingPercentageBps",
    ),
    bankAccountResultingFixedAmount: requireString(
      approval.bankAccountResultingFixedAmount,
      "Marketplace Checkout Fee bankAccountResultingFixedAmount",
    ),
    platformCreditResultingPercentageBps: requireNumber(
      approval.platformCreditResultingPercentageBps,
      "Marketplace Checkout Fee platformCreditResultingPercentageBps",
    ),
    platformCreditResultingFixedAmount: requireString(
      approval.platformCreditResultingFixedAmount,
      "Marketplace Checkout Fee platformCreditResultingFixedAmount",
    ),
    unsupportedMethodsDefault: requireString(
      approval.unsupportedMethodsDefault,
      "Marketplace Checkout Fee unsupportedMethodsDefault",
    ),
    feeQuoteConfirmationRequired: requireBoolean(
      approval.feeQuoteConfirmationRequired,
      "Marketplace Checkout Fee feeQuoteConfirmationRequired",
    ),
    feeQuoteStaleResponseCode: requireNumber(
      approval.feeQuoteStaleResponseCode,
      "Marketplace Checkout Fee feeQuoteStaleResponseCode",
    ),
    feeQuoteStaleResponseError: requireString(
      approval.feeQuoteStaleResponseError,
      "Marketplace Checkout Fee feeQuoteStaleResponseError",
    ),
    stripeMode: requireString(approval.stripeMode, "Marketplace Checkout Fee stripeMode"),
    livePolicyEndpointUrl: requireString(
      approval.livePolicyEndpointUrl,
      "Marketplace Checkout Fee livePolicyEndpointUrl",
    ),
    livePolicyEndpointStatusCode: requireNumber(
      approval.livePolicyEndpointStatusCode,
      "Marketplace Checkout Fee livePolicyEndpointStatusCode",
    ),
    livePolicyEndpointCheckedAt: requireString(
      approval.livePolicyEndpointCheckedAt,
      "Marketplace Checkout Fee livePolicyEndpointCheckedAt",
    ),
    ...Object.fromEntries(
      REQUIRED_CHECKOUT_FEE_REFERENCES.map((key) => [
        key,
        requireString(approval[key], `Marketplace Checkout Fee ${key}`),
      ]),
    ),
    ...Object.fromEntries(
      REQUIRED_CHECKOUT_FEE_PROOFS.map((key) => [
        key,
        requireBoolean(approval[key], `Marketplace Checkout Fee ${key}`),
      ]),
    ),
  };
}

function validateCheckoutFeeEvidenceOptions(options) {
  const errors = [];
  if (!options.approvalPath) {
    errors.push("MARKETPLACE_CHECKOUT_FEE_APPROVAL_RECORD or --approval is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push(
      "Marketplace Checkout Fee evidence requires --reference or PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE.",
    );
  } else {
    validateEvidenceReference("PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Marketplace Checkout Fee evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Marketplace Checkout Fee evidence requires checkedAt.");
  }
  return errors;
}

function validateCheckoutFeeApproval(approval, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_CHECKOUT_FEE_PROOFS) {
    if (approval[key] !== true) {
      errors.push(`Marketplace Checkout Fee approval must prove ${key}=true.`);
    }
  }
  if (approval.environment.toLowerCase() !== "production") {
    errors.push("Marketplace Checkout Fee approval must be production-scoped before marketplace launch.");
  }
  if (approval.stripeMode.toLowerCase() !== "live") {
    errors.push("Marketplace Checkout Fee approval must use Stripe live mode.");
  }
  if (approval.feePolicyVersion !== REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION) {
    errors.push(
      `Marketplace Checkout Fee approval must use feePolicyVersion=${REQUIRED_MARKETPLACE_CHECKOUT_FEE_POLICY_VERSION}.`,
    );
  }
  validateFeePolicyEffectiveAt(approval.feePolicyEffectiveAt, errors);
  validateLivePolicyEndpointObservation(approval, checkedAt, errors);
  validatePolicySnapshot(approval, errors);
  validateApprovalCompletedAt(approval.approvalCompletedAt, checkedAt, errors);
  validateReleaseCommit("Marketplace Checkout Fee", approval.releaseCommit, errors);
  validateEvidenceReference("Marketplace Checkout Fee approvalReference", approval.approvalReference, errors);
  validateEvidenceReferences("Marketplace Checkout Fee", approval, REQUIRED_CHECKOUT_FEE_REFERENCES, errors);
  return errors;
}

function validateApprovalCompletedAt(value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Marketplace Checkout Fee approvalCompletedAt must be an ISO timestamp.");
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Marketplace Checkout Fee evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const approvalCompletedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (approvalCompletedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Marketplace Checkout Fee approvalCompletedAt cannot be after checkedAt.");
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - approvalCompletedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_CHECKOUT_FEE_APPROVAL_AGE_DAYS) {
    errors.push(
      `Marketplace Checkout Fee approvalCompletedAt cannot be older than ${MAX_CHECKOUT_FEE_APPROVAL_AGE_DAYS} days.`,
    );
  }
}

function validateFeePolicyEffectiveAt(value, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push("Marketplace Checkout Fee feePolicyEffectiveAt must be an ISO timestamp.");
  }
}

function validateLivePolicyEndpointObservation(approval, checkedAt, errors) {
  try {
    const url = new URL(approval.livePolicyEndpointUrl);
    if (
      url.protocol !== "https:" ||
      !LIVE_MARKETPLACE_HOSTS.has(url.hostname) ||
      url.pathname !== LIVE_MARKETPLACE_CHECKOUT_FEE_POLICY_PATH
    ) {
      errors.push(
        `Marketplace Checkout Fee livePolicyEndpointUrl must use ${LIVE_MARKETPLACE_CHECKOUT_FEE_POLICY_PATH} on a production Chase Sets host.`,
      );
    }
  } catch {
    errors.push("Marketplace Checkout Fee livePolicyEndpointUrl must be an absolute HTTPS URL.");
  }

  if (approval.livePolicyEndpointStatusCode !== 200) {
    errors.push("Marketplace Checkout Fee livePolicyEndpointStatusCode must be 200.");
  }

  if (!isIsoTimestamp(approval.livePolicyEndpointCheckedAt)) {
    errors.push("Marketplace Checkout Fee livePolicyEndpointCheckedAt must be an ISO timestamp.");
    return;
  }
  if (!isIsoTimestamp(checkedAt)) {
    return;
  }

  const endpointCheckedAt = new Date(approval.livePolicyEndpointCheckedAt);
  const evidenceCheckedAt = new Date(checkedAt);
  if (endpointCheckedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push("Marketplace Checkout Fee livePolicyEndpointCheckedAt cannot be after checkedAt.");
  }
}

function validatePolicySnapshot(approval, errors) {
  if (!Array.isArray(approval.enabledJurisdictions) || approval.enabledJurisdictions.join(",") !== "US") {
    errors.push("Marketplace Checkout Fee enabledJurisdictions must match the live policy endpoint: US.");
  }
  if (approval.basePercentageBps !== 290 || approval.baseFixedAmount !== "0.30") {
    errors.push("Marketplace Checkout Fee base policy must match the live card policy: 290 bps plus 0.30.");
  }
  if (approval.bankAccountResultingPercentageBps !== 50 || approval.bankAccountResultingFixedAmount !== "0.00") {
    errors.push("Marketplace Checkout Fee bank-account policy must match the live policy: 50 bps plus 0.00.");
  }
  if (approval.platformCreditResultingPercentageBps !== 0 || approval.platformCreditResultingFixedAmount !== "0.00") {
    errors.push("Marketplace Checkout Fee platform-credit policy must match the live policy: 0 bps plus 0.00.");
  }
  if (approval.unsupportedMethodsDefault !== "no-positive-fee") {
    errors.push("Marketplace Checkout Fee unsupportedMethodsDefault must match the live policy: no-positive-fee.");
  }
  if (approval.feeQuoteConfirmationRequired !== true) {
    errors.push("Marketplace Checkout Fee feeQuoteConfirmationRequired must be true.");
  }
  if (approval.feeQuoteStaleResponseCode !== 409 || approval.feeQuoteStaleResponseError !== "fee_quote_stale") {
    errors.push("Marketplace Checkout Fee stale quote response must match the live policy: 409 fee_quote_stale.");
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

function requireNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
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
