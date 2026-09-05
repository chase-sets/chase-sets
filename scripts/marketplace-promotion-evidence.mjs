#!/usr/bin/env node
// Marketplace public promotion evidence.
//
// v2 makes authority transport explicit. v1 let the operator review record
// *assert* the Public Presence copy audit result as a handful of copied
// booleans, so a green promotion record could exist without a green audit ever
// having run. v2 requires the exact successful launch-mode
// `marketplace-public-presence-copy-audit/v2` record as its own input and
// DERIVES every legal-corpus and counsel-packet field from it. The review may
// still carry `publicPresenceCopyAuditReference` as a human custody pointer,
// but every `publicPresenceCopyAudit*` value, every `counselPacket*` value,
// and the three legacy proof aliases are now unknown keys the recursively
// closed normalizer rejects: a caller cannot graft an authority it does not
// have.
//
// Predecessor records stay parseable only as rejected historical authority. A
// v1 review, a v1 copy audit, a failing audit, or a non-launch audit produces
// exactly one closed v2 record with `passesPromotionGate: false` and bounded
// diagnostics — never a crash, and never an upgrade.
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
  validatePublicPresenceCopyAuditRecord,
} from "./marketplace-public-presence-copy-audit.mjs";
import { COUNSEL_REVIEW_PACKET_VERSION } from "./legal-review-corpus.mjs";
import { validateReleaseCommit } from "./marketplace-release-commit.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MARKETPLACE_PROMOTION_EVIDENCE_VERSION = "marketplace-promotion-evidence/v2";
const MAX_PROMOTION_REVIEW_AGE_DAYS = 30;

/**
 * The operator-attested proofs only. Every Public Presence copy audit proof
 * left this list in v2: those are derived from the audit record, so a review
 * that asserts one is asserting an authority it does not own.
 */
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
  "rollbackOwnerAssigned",
];

const REQUIRED_MARKETPLACE_PROMOTION_REFERENCES = [
  "checkoutLaunchEvidenceReference",
  "publicPresenceReviewReference",
  "publicPresenceCopyAuditReference",
  "policyPagesReviewReference",
  "rollbackOwnerReference",
];

const REQUIRED_MARKETPLACE_PROMOTION_STRINGS = [
  "reviewReference",
  "reviewCompletedAt",
  "environment",
  "releaseCommit",
  "stagingWorkflowRunReference",
  "productionWorkflowRunReference",
  "checkoutLaunchEvidenceCompletedAt",
  "ucpAp2ClaimsReviewReference",
];

const REQUIRED_MARKETPLACE_PROMOTION_BOOLEANS = [
  ...REQUIRED_MARKETPLACE_PROMOTION_PROOFS,
  "publicLaunchClaimsEnabled",
  "certificationApproved",
  "uncertifiedClaimsAbsent",
];

/** The recursively closed review key set. Anything else is rejected. */
const ALLOWED_PROMOTION_REVIEW_FIELDS = [
  ...REQUIRED_MARKETPLACE_PROMOTION_STRINGS,
  ...REQUIRED_MARKETPLACE_PROMOTION_REFERENCES,
  ...REQUIRED_MARKETPLACE_PROMOTION_BOOLEANS,
  "ucpAp2Owner",
  "certificationReference",
];

/**
 * The exact ordered legal-corpus projection promotion derives from the audit
 * record. Named once so the emitted evidence, the launch go/no-go consumer,
 * and the tests all agree on the field set without three hand-kept lists.
 */
export const PROMOTION_AUDIT_DERIVED_FIELDS = [
  ["publicPresenceCopyAuditVersion", (audit) => audit.schemaVersion],
  ["publicPresenceCopyAuditBaseUrl", (audit) => audit.baseUrl],
  ["publicPresenceCopyAuditCompletedAt", (audit) => audit.checkedAt],
  ["publicPresenceCopyAuditMode", (audit) => audit.mode],
  ["publicPresenceCopyAuditRequiredPageCount", (audit) => audit.requiredPageCount],
  ["publicPresenceCopyAuditRequiredPagePaths", (audit) => audit.requiredPagePaths],
  ["publicPresenceCopyAuditLaunchRequiredPolicyCount", (audit) => audit.launchRequiredPolicyCount],
  ["publicPresenceCopyAuditLaunchRequiredPolicyKeys", (audit) => audit.launchRequiredPolicyKeys],
  ["publicPresenceCopyAuditComplianceArticleCount", (audit) => audit.complianceArticleCount],
  ["publicPresenceCopyAuditComplianceArticleSlugs", (audit) => audit.complianceArticleSlugs],
  ["publicPresenceCopyAuditUniqueFetchedPathCount", (audit) => audit.uniqueFetchedPathCount],
  ["publicPresenceCopyAuditLegalCorpusDigest", (audit) => audit.legalCorpusDigest],
  ["counselPacketSchemaVersion", (audit) => audit.counselPacket?.schemaVersion ?? null],
  ["counselPacketSha256", (audit) => audit.counselPacket?.sha256 ?? null],
  ["counselPacketUtf8Bytes", (audit) => audit.counselPacket?.utf8Bytes ?? null],
  ["counselPacketCorpusSha256", (audit) => audit.counselPacket?.corpusSha256 ?? null],
  ["counselPacketVerified", (audit) => audit.counselPacket?.verified ?? false],
  ["publicPresenceCopyAuditPassed", (audit) => audit.passesPublicPresenceCopyAudit],
  ["publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved", (audit) => audit.futureOnlyLaunchCopyRemoved],
  ["publicPresenceCopyAuditPolicyPagesReviewed", (audit) => audit.policyPagesReviewed],
  ["publicPresenceCopyAuditComplianceArticlesReviewed", (audit) => audit.complianceArticlesReviewed],
  ["publicPresenceCopyAuditDmcaRegistrationMarkerAbsent", (audit) => audit.dmcaRegistrationMarkerAbsent],
  ["publicPresenceCopyAuditUncertifiedClaimsAbsent", (audit) => audit.uncertifiedClaimsAbsent],
];

/**
 * The predecessor-compatible unprefixed proof properties. They stay in the
 * emitted record so a v1 consumer keeps parsing, but they are derived from the
 * audit and the review cannot supply them.
 */
export const PROMOTION_AUDIT_DERIVED_LEGACY_PROOFS = [
  ["publicPresenceLaunchCopyReviewed", (audit) => audit.publicPresenceLaunchCopyReviewed],
  ["futureOnlyLaunchCopyRemoved", (audit) => audit.futureOnlyLaunchCopyRemoved],
  ["policyPagesReviewed", (audit) => audit.policyPagesReviewed],
];

export function parsePromotionEvidenceArgs(argv, env = process.env) {
  return {
    reviewPath: readOption(argv, "--review") ?? readEnv("MARKETPLACE_PROMOTION_REVIEW_RECORD", env),
    copyAuditPath:
      readOption(argv, "--public-presence-copy-audit") ?? readEnv("MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_RECORD", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("MARKETPLACE_PROMOTION_OWNER", env) ?? "Platform Operations",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function readPromotionReview(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readPublicPresenceCopyAuditRecord(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildPromotionEvidence(input) {
  const { review, errors: reviewErrors } = normalizePromotionReview(input.review);
  const auditValidation = validatePublicPresenceCopyAuditRecord(input.audit);
  const audit = auditValidation.ok ? auditValidation.record : null;

  const errors = [
    ...validateRequiredInputs(input),
    ...reviewErrors,
    ...auditValidation.errors.map((error) => `Marketplace promotion copy audit input: ${error}`),
    ...validateAuditAuthority(audit),
    ...validatePromotionReview(review, audit, input.checkedAt),
  ];
  const passesPromotionGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
    passesPromotionGate,
    marketplacePromotion: {
      approved: passesPromotionGate,
      reference: input.reference ?? null,
      owner: input.owner ?? null,
      checkedAt: input.checkedAt ?? null,
      reviewReference: review.reviewReference,
      reviewCompletedAt: review.reviewCompletedAt,
      environment: review.environment,
      releaseCommit: review.releaseCommit,
      stagingWorkflowRunReference: review.stagingWorkflowRunReference,
      productionWorkflowRunReference: review.productionWorkflowRunReference,
      ...Object.fromEntries(REQUIRED_MARKETPLACE_PROMOTION_REFERENCES.map((key) => [key, review[key]])),
      checkoutLaunchEvidenceCompletedAt: review.checkoutLaunchEvidenceCompletedAt,
      ...Object.fromEntries(PROMOTION_AUDIT_DERIVED_FIELDS.map(([key, derive]) => [key, derive1(audit, derive)])),
      ...Object.fromEntries(REQUIRED_MARKETPLACE_PROMOTION_PROOFS.map((key) => [key, review[key]])),
      ...Object.fromEntries(
        PROMOTION_AUDIT_DERIVED_LEGACY_PROOFS.map(([key, derive]) => [key, derive1(audit, derive)]),
      ),
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

function derive1(audit, derive) {
  return audit === null ? null : (derive(audit) ?? null);
}

export async function runPromotionEvidence(options) {
  const review = await readPromotionReview(options.reviewPath);
  const audit = await readPublicPresenceCopyAuditRecord(options.copyAuditPath);
  return buildPromotionEvidence({ ...options, review, audit });
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

/**
 * Recursively closed review normalization. Every unknown key — including every
 * retired `publicPresenceCopyAudit*` value, every `counselPacket*` value, and
 * the three legacy proof aliases a v1 review carried — is a rejection, and a
 * missing or wrongly typed value is a diagnostic rather than a throw, so a
 * predecessor record still parses as exactly one rejected v2 result.
 */
export function normalizePromotionReview(candidate) {
  const errors = [];
  const empty = Object.fromEntries(ALLOWED_PROMOTION_REVIEW_FIELDS.map((key) => [key, null]));

  if (!isRecord(candidate)) {
    return {
      review: { ...empty, ucpAp2Owner: null, certificationReference: "" },
      errors: ["Marketplace promotion review record must be a JSON object."],
    };
  }

  for (const key of Object.keys(candidate)) {
    if (!ALLOWED_PROMOTION_REVIEW_FIELDS.includes(key)) {
      errors.push(
        `Marketplace promotion review has an unexpected field '${key}'; ${MARKETPLACE_PROMOTION_EVIDENCE_VERSION} derives every copy-audit and counsel-packet value from the audit record.`,
      );
    }
  }

  const review = { ...empty };
  for (const key of [...REQUIRED_MARKETPLACE_PROMOTION_STRINGS, ...REQUIRED_MARKETPLACE_PROMOTION_REFERENCES]) {
    if (!isNonEmptyString(candidate[key])) {
      errors.push(`Marketplace promotion ${key} must be a non-empty string.`);
      continue;
    }
    review[key] = candidate[key].trim();
  }
  for (const key of REQUIRED_MARKETPLACE_PROMOTION_BOOLEANS) {
    if (typeof candidate[key] !== "boolean") {
      errors.push(`Marketplace promotion ${key} must be a boolean.`);
      continue;
    }
    review[key] = candidate[key];
  }
  review.ucpAp2Owner = isNonEmptyString(candidate.ucpAp2Owner) ? candidate.ucpAp2Owner.trim() : "Checkout and Payments";
  review.certificationReference =
    typeof candidate.certificationReference === "string" ? candidate.certificationReference.trim() : "";

  return { review, errors };
}

export function validatePromotionEvidenceOptions(options) {
  const errors = [];
  if (!options.reviewPath) {
    errors.push("MARKETPLACE_PROMOTION_REVIEW_RECORD or --review is required.");
  }
  if (!options.copyAuditPath) {
    errors.push("MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_RECORD or --public-presence-copy-audit is required.");
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

/**
 * The audit record must be an exact, closed, successful, launch-mode v2 audit
 * with a verified counsel packet whose corpus digest equals the audit's own
 * current corpus digest. Adding v2-looking fields or booleans to a predecessor
 * record cannot reach this bar, because the record shape itself is closed.
 */
function validateAuditAuthority(audit) {
  const errors = [];
  if (audit === null) {
    errors.push(
      `Marketplace promotion evidence requires an exact successful launch-mode ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION} record.`,
    );
    return errors;
  }
  if (audit.mode !== "launch") {
    errors.push("Marketplace promotion review must use a launch-mode Public Presence copy audit.");
  }
  if (audit.passesPublicPresenceCopyAudit !== true) {
    errors.push("Marketplace promotion requires a passing Public Presence copy audit record.");
  }
  for (const [field, value] of [
    ["publicPresenceLaunchCopyReviewed", audit.publicPresenceLaunchCopyReviewed],
    ["futureOnlyLaunchCopyRemoved", audit.futureOnlyLaunchCopyRemoved],
    ["policyPagesReviewed", audit.policyPagesReviewed],
    ["complianceArticlesReviewed", audit.complianceArticlesReviewed],
    ["dmcaRegistrationMarkerAbsent", audit.dmcaRegistrationMarkerAbsent],
    ["uncertifiedClaimsAbsent", audit.uncertifiedClaimsAbsent],
  ]) {
    if (value !== true) {
      errors.push(`Marketplace promotion requires the copy audit to prove ${field}=true.`);
    }
  }
  if (audit.launchRequiredPolicyCount === null || audit.complianceArticleCount === null) {
    errors.push("Marketplace promotion requires a copy audit with both membership authorities validated.");
  }
  if (audit.counselPacket?.verified !== true) {
    errors.push("Marketplace promotion requires a copy audit that verified the retained counsel review packet bytes.");
  }
  if (audit.counselPacket?.schemaVersion !== COUNSEL_REVIEW_PACKET_VERSION) {
    errors.push(`Marketplace promotion requires a retained ${COUNSEL_REVIEW_PACKET_VERSION} counsel review packet.`);
  }
  if (audit.legalCorpusDigest === null || audit.counselPacket?.corpusSha256 !== audit.legalCorpusDigest) {
    errors.push(
      "Marketplace promotion requires the retained counsel packet corpus digest to equal the audited current corpus digest.",
    );
  }
  if (audit.requiredPageCount !== REQUIRED_PUBLIC_PRESENCE_PAGES.length) {
    errors.push(
      `Marketplace promotion requires publicPresenceCopyAuditRequiredPageCount=${REQUIRED_PUBLIC_PRESENCE_PAGES.length}.`,
    );
  }
  validatePublicPresenceBaseUrl("Marketplace promotion publicPresenceCopyAuditBaseUrl", audit.baseUrl, errors);
  return errors;
}

function validatePromotionReview(review, audit, checkedAt) {
  const errors = [];
  for (const key of REQUIRED_MARKETPLACE_PROMOTION_PROOFS) {
    if (review[key] !== true) {
      errors.push(`Marketplace promotion review must prove ${key}=true.`);
    }
  }
  if (typeof review.environment === "string" && review.environment.toLowerCase() !== "production") {
    errors.push("Marketplace promotion review must be production-scoped before marketplace launch.");
  }
  validateCompletedAt("Marketplace promotion reviewCompletedAt", review.reviewCompletedAt, checkedAt, errors);
  validateCompletedAt(
    "Marketplace promotion checkoutLaunchEvidenceCompletedAt",
    review.checkoutLaunchEvidenceCompletedAt,
    checkedAt,
    errors,
  );
  if (audit !== null) {
    validateCompletedAt("Marketplace promotion publicPresenceCopyAuditCompletedAt", audit.checkedAt, checkedAt, errors);
  }
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
