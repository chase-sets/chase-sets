#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isIsoTimestamp,
  validateEvidenceReference,
  validateEvidenceReferences,
} from "./marketplace-evidence-references.mjs";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGES,
} from "./marketplace-public-presence-copy-audit.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MARKETPLACE_PROMOTION_EVIDENCE_VERSION = "marketplace-promotion-evidence/v1";
const MAX_PROMOTION_REVIEW_AGE_DAYS = 30;

export const REQUIRED_MARKETPLACE_PROMOTION_PROOFS = [
  "finalLaunchReviewApproved",
  "checkoutLaunchEvidenceApproved",
  "checkoutLaunchBuyNowBuyCartSellListReviewed",
  "checkoutLaunchGuestAndSignedInReviewed",
  "checkoutLaunchDesktopMobileAccessibilityReviewed",
  "checkoutLaunchNoPreConfirmationSideEffects",
  "checkoutLaunchObservabilitySupportSecurityHandoffsReviewed",
  "checkoutLaunchFulfillmentAssignmentBeforeSessionReviewed",
  "checkoutLaunchFreshStateCleanupReviewed",
  "checkoutLaunchNoLegacyCompatibilityPaths",
  "publicPresenceLaunchCopyReviewed",
  "futureOnlyLaunchCopyRemoved",
  "policyPagesReviewed",
  "rollbackOwnerAssigned",
];

const REQUIRED_MARKETPLACE_PROMOTION_REFERENCES = [
  "checkoutLaunchEvidenceReference",
  "publicPresenceReviewReference",
  "publicPresenceCopyAuditReference",
  "policyPagesReviewReference",
  "rollbackOwnerReference",
];

export function parsePromotionEvidenceArgs(argv, env = process.env) {
  return {
    reviewPath: readOption(argv, "--review") ?? readEnv("MARKETPLACE_PROMOTION_REVIEW_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("MARKETPLACE_PROMOTION_OWNER", env) ?? "Platform Operations",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readPromotionReview(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildPromotionEvidence(input) {
  const review = normalizePromotionReview(input.review);
  const errors = [...validateRequiredInputs(input), ...validatePromotionReview(review, input.checkedAt)];
  const passesPromotionGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
    passesPromotionGate,
    marketplacePromotion: {
      approved: passesPromotionGate,
      reference: input.reference,
      owner: input.owner,
      checkedAt: input.checkedAt,
      reviewReference: review.reviewReference,
      reviewCompletedAt: review.reviewCompletedAt,
      environment: review.environment,
      releaseCommit: review.releaseCommit,
      stagingWorkflowRunReference: review.stagingWorkflowRunReference,
      productionWorkflowRunReference: review.productionWorkflowRunReference,
      ...Object.fromEntries(REQUIRED_MARKETPLACE_PROMOTION_REFERENCES.map((key) => [key, review[key]])),
      checkoutLaunchEvidenceCompletedAt: review.checkoutLaunchEvidenceCompletedAt,
      publicPresenceCopyAuditVersion: review.publicPresenceCopyAuditVersion,
      publicPresenceCopyAuditBaseUrl: review.publicPresenceCopyAuditBaseUrl,
      publicPresenceCopyAuditCompletedAt: review.publicPresenceCopyAuditCompletedAt,
      publicPresenceCopyAuditMode: review.publicPresenceCopyAuditMode,
      publicPresenceCopyAuditRequiredPageCount: review.publicPresenceCopyAuditRequiredPageCount,
      publicPresenceCopyAuditPassed: review.publicPresenceCopyAuditPassed,
      publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: review.publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved,
      publicPresenceCopyAuditPolicyPagesReviewed: review.publicPresenceCopyAuditPolicyPagesReviewed,
      publicPresenceCopyAuditUncertifiedClaimsAbsent: review.publicPresenceCopyAuditUncertifiedClaimsAbsent,
      ...Object.fromEntries(REQUIRED_MARKETPLACE_PROMOTION_PROOFS.map((key) => [key, review[key]])),
    },
    ucpAp2Marketing: {
      owner: review.ucpAp2Owner,
      publicLaunchClaimsEnabled: review.publicLaunchClaimsEnabled,
      certificationApproved: review.certificationApproved,
      certificationReference: review.certificationReference,
      claimsReviewReference: review.ucpAp2ClaimsReviewReference,
      uncertifiedClaimsAbsent: review.uncertifiedClaimsAbsent,
    },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runPromotionEvidence(options) {
  const review = await readPromotionReview(options.reviewPath);
  return buildPromotionEvidence({
    ...options,
    review,
  });
}

async function main(argv, env = process.env) {
  const options = parsePromotionEvidenceArgs(argv, env);
  const optionErrors = validatePromotionEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runPromotionEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesPromotionGate) {
    console.error("Marketplace promotion evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizePromotionReview(review) {
  if (!isRecord(review)) {
    throw new Error("Marketplace promotion review record must be a JSON object.");
  }

  return {
    reviewReference: requireString(review.reviewReference, "Marketplace promotion reviewReference"),
    reviewCompletedAt: requireString(review.reviewCompletedAt, "Marketplace promotion reviewCompletedAt"),
    environment: requireString(review.environment, "Marketplace promotion environment"),
    releaseCommit: requireString(review.releaseCommit, "Marketplace promotion releaseCommit"),
    stagingWorkflowRunReference: requireString(
      review.stagingWorkflowRunReference,
      "Marketplace promotion stagingWorkflowRunReference",
    ),
    productionWorkflowRunReference: requireString(
      review.productionWorkflowRunReference,
      "Marketplace promotion productionWorkflowRunReference",
    ),
    ...Object.fromEntries(
      REQUIRED_MARKETPLACE_PROMOTION_REFERENCES.map((key) => [
        key,
        requireString(review[key], `Marketplace promotion ${key}`),
      ]),
    ),
    checkoutLaunchEvidenceCompletedAt: requireString(
      review.checkoutLaunchEvidenceCompletedAt,
      "Marketplace promotion checkoutLaunchEvidenceCompletedAt",
    ),
    publicPresenceCopyAuditMode: requireString(
      review.publicPresenceCopyAuditMode,
      "Marketplace promotion publicPresenceCopyAuditMode",
    ),
    publicPresenceCopyAuditVersion: requireString(
      review.publicPresenceCopyAuditVersion,
      "Marketplace promotion publicPresenceCopyAuditVersion",
    ),
    publicPresenceCopyAuditBaseUrl: requireString(
      review.publicPresenceCopyAuditBaseUrl,
      "Marketplace promotion publicPresenceCopyAuditBaseUrl",
    ),
    publicPresenceCopyAuditCompletedAt: requireString(
      review.publicPresenceCopyAuditCompletedAt,
      "Marketplace promotion publicPresenceCopyAuditCompletedAt",
    ),
    publicPresenceCopyAuditRequiredPageCount: requireNumber(
      review.publicPresenceCopyAuditRequiredPageCount,
      "Marketplace promotion publicPresenceCopyAuditRequiredPageCount",
    ),
    publicPresenceCopyAuditPassed: requireBoolean(
      review.publicPresenceCopyAuditPassed,
      "Marketplace promotion publicPresenceCopyAuditPassed",
    ),
    publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved: requireBoolean(
      review.publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved,
      "Marketplace promotion publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved",
    ),
    publicPresenceCopyAuditPolicyPagesReviewed: requireBoolean(
      review.publicPresenceCopyAuditPolicyPagesReviewed,
      "Marketplace promotion publicPresenceCopyAuditPolicyPagesReviewed",
    ),
    publicPresenceCopyAuditUncertifiedClaimsAbsent: requireBoolean(
      review.publicPresenceCopyAuditUncertifiedClaimsAbsent,
      "Marketplace promotion publicPresenceCopyAuditUncertifiedClaimsAbsent",
    ),
    ...Object.fromEntries(
      REQUIRED_MARKETPLACE_PROMOTION_PROOFS.map((key) => [
        key,
        requireBoolean(review[key], `Marketplace promotion ${key}`),
      ]),
    ),
    ucpAp2Owner: requireString(review.ucpAp2Owner ?? "Checkout and Payments", "UCP/AP2 owner"),
    publicLaunchClaimsEnabled: requireBoolean(review.publicLaunchClaimsEnabled, "UCP/AP2 publicLaunchClaimsEnabled"),
    certificationApproved: requireBoolean(review.certificationApproved, "UCP/AP2 certificationApproved"),
    certificationReference:
      typeof review.certificationReference === "string" ? review.certificationReference.trim() : "",
    ucpAp2ClaimsReviewReference: requireString(review.ucpAp2ClaimsReviewReference, "UCP/AP2 claimsReviewReference"),
    uncertifiedClaimsAbsent: requireBoolean(review.uncertifiedClaimsAbsent, "UCP/AP2 uncertifiedClaimsAbsent"),
  };
}

function validatePromotionEvidenceOptions(options) {
  const errors = [];
  if (!options.reviewPath) {
    errors.push("MARKETPLACE_PROMOTION_REVIEW_RECORD or --review is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Marketplace promotion evidence requires --reference or PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE.");
  } else {
    validateEvidenceReference("PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Marketplace promotion evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Marketplace promotion evidence requires checkedAt.");
  }
  return errors;
}

function validatePromotionReview(review, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_MARKETPLACE_PROMOTION_PROOFS) {
    if (review[key] !== true) {
      errors.push(`Marketplace promotion review must prove ${key}=true.`);
    }
  }
  if (review.environment.toLowerCase() !== "production") {
    errors.push("Marketplace promotion review must be production-scoped before marketplace launch.");
  }
  validateCompletedAt("Marketplace promotion reviewCompletedAt", review.reviewCompletedAt, checkedAt, errors);
  validateCompletedAt(
    "Marketplace promotion checkoutLaunchEvidenceCompletedAt",
    review.checkoutLaunchEvidenceCompletedAt,
    checkedAt,
    errors,
  );
  validateCompletedAt(
    "Marketplace promotion publicPresenceCopyAuditCompletedAt",
    review.publicPresenceCopyAuditCompletedAt,
    checkedAt,
    errors,
  );
  validateReleaseCommit("Marketplace promotion", review.releaseCommit, errors);
  validateEvidenceReference("Marketplace promotion reviewReference", review.reviewReference, errors);
  validateEvidenceReference(
    "Marketplace promotion stagingWorkflowRunReference",
    review.stagingWorkflowRunReference,
    errors,
  );
  validateEvidenceReference(
    "Marketplace promotion productionWorkflowRunReference",
    review.productionWorkflowRunReference,
    errors,
  );
  validateEvidenceReferences("Marketplace promotion", review, REQUIRED_MARKETPLACE_PROMOTION_REFERENCES, errors);
  validateEvidenceReference("UCP/AP2 claimsReviewReference", review.ucpAp2ClaimsReviewReference, errors);
  if (review.publicPresenceCopyAuditMode !== "launch") {
    errors.push("Marketplace promotion review must use a launch-mode Public Presence copy audit.");
  }
  if (review.publicPresenceCopyAuditVersion !== MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION) {
    errors.push(`Marketplace promotion review must use ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}.`);
  }
  validatePublicPresenceBaseUrl(
    "Marketplace promotion publicPresenceCopyAuditBaseUrl",
    review.publicPresenceCopyAuditBaseUrl,
    errors,
  );
  if (review.publicPresenceCopyAuditRequiredPageCount !== REQUIRED_PUBLIC_PRESENCE_PAGES.length) {
    errors.push(
      `Marketplace promotion review must include publicPresenceCopyAuditRequiredPageCount=${REQUIRED_PUBLIC_PRESENCE_PAGES.length}.`,
    );
  }
  if (review.publicPresenceCopyAuditPassed !== true) {
    errors.push("Marketplace promotion review must prove publicPresenceCopyAuditPassed=true.");
  }
  if (review.publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved !== true) {
    errors.push("Marketplace promotion review must prove publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved=true.");
  }
  if (review.publicPresenceCopyAuditPolicyPagesReviewed !== true) {
    errors.push("Marketplace promotion review must prove publicPresenceCopyAuditPolicyPagesReviewed=true.");
  }
  if (review.publicPresenceCopyAuditUncertifiedClaimsAbsent !== true) {
    errors.push("Marketplace promotion review must prove publicPresenceCopyAuditUncertifiedClaimsAbsent=true.");
  }
  if (review.publicLaunchClaimsEnabled) {
    if (review.certificationApproved !== true) {
      errors.push("UCP/AP2 public launch claims require certificationApproved=true.");
    }
    if (!isNonEmptyString(review.certificationReference)) {
      errors.push("UCP/AP2 public launch claims require a certificationReference.");
    } else {
      validateEvidenceReference("UCP/AP2 certificationReference", review.certificationReference, errors);
    }
  }
  if (
    !review.publicLaunchClaimsEnabled &&
    review.certificationApproved &&
    !isNonEmptyString(review.certificationReference)
  ) {
    errors.push("UCP/AP2 certification approval requires a certificationReference.");
  }
  if (
    !review.publicLaunchClaimsEnabled &&
    review.certificationApproved &&
    isNonEmptyString(review.certificationReference)
  ) {
    validateEvidenceReference("UCP/AP2 certificationReference", review.certificationReference, errors);
  }
  if (!review.certificationApproved && isNonEmptyString(review.certificationReference)) {
    validateEvidenceReference("UCP/AP2 certificationReference", review.certificationReference, errors);
  }
  if (review.publicLaunchClaimsEnabled === false && review.uncertifiedClaimsAbsent !== true) {
    errors.push("UCP/AP2 launch restraint requires uncertifiedClaimsAbsent=true when public claims are disabled.");
  }
  return errors;
}

function validateCompletedAt(label, value, checkedAt, errors) {
  if (!isIsoTimestamp(value)) {
    errors.push(`${label} must be an ISO timestamp.`);
    return;
  }

  if (!isIsoTimestamp(checkedAt)) {
    errors.push("Marketplace promotion evidence checkedAt must be an ISO timestamp.");
    return;
  }

  const completedAt = new Date(value);
  const evidenceCheckedAt = new Date(checkedAt);
  if (completedAt.getTime() > evidenceCheckedAt.getTime() + 60_000) {
    errors.push(`${label} cannot be after checkedAt.`);
    return;
  }

  const ageDays = (evidenceCheckedAt.getTime() - completedAt.getTime()) / 86_400_000;
  if (ageDays > MAX_PROMOTION_REVIEW_AGE_DAYS) {
    errors.push(`${label} cannot be older than ${MAX_PROMOTION_REVIEW_AGE_DAYS} days.`);
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

function validatePublicPresenceBaseUrl(label, value, errors) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chasesets.com") {
      errors.push(`${label} must use https://chasesets.com.`);
    }
  } catch {
    errors.push(`${label} must be an absolute HTTPS URL.`);
  }
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
