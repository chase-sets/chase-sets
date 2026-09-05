#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";
import { MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION } from "./marketplace-production-launch-readiness.mjs";
import { MARKETPLACE_PROMOTION_EVIDENCE_VERSION } from "./marketplace-promotion-evidence.mjs";
import {
  MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION,
  REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS,
} from "./marketplace-public-presence-copy-audit.mjs";
import { COUNSEL_REVIEW_PACKET_VERSION, loadLegalReviewMembership } from "./legal-review-corpus.mjs";
import { GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION } from "./google-shopping-launch-readiness-evidence.mjs";
import { RELEASE_HEALTH_REPORT_VERSION } from "./release-health-report.mjs";
import { evaluateRollbackReadiness } from "./rollback-readiness.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { repoRoot as defaultRepoRoot } from "./lib/repo.mjs";

// Terminal go/no-go gate for the launch chain: m101 -> m97 -> DOKS m103 ->
// here. This does not re-derive evidence -- it composes the individual
// readiness evidence gates (each already checked into scripts/) into one
// aggregate record, plus a human-recorded go/no-go decision with rollback
// criteria. A row can only be automated when it is derived from repository
// content; every row that depends on live production behavior stays
// operator-attested, matching the other terminal/checklist gates in this
// directory.

export const LAUNCH_GO_NO_GO_GATE_VERSION = "launch-go-no-go-gate/v1";

// Version string a not-yet-merged sibling gate is expected to report once it
// lands. Pinned as a literal (not imported) because the module does not exist
// on this branch yet; once it merges, keep this string in lockstep with the
// script's own exported version constant.
const CAMPAIGN_START_GATE_EXPECTED_VERSION = "campaign-start-gate/v1";
const CAMPAIGN_START_GATE_SCRIPT_PATH = "scripts/campaign-start-gate.mjs";

// The money-operations production promotion approval matrix: the pinned set
// of approval categories platform-production.yml's production job enforces
// (each with a paired _APPROVED/_REFERENCE GitHub Environment variable)
// before TF_VAR_production_marketplace_public_enabled is allowed to reach
// production. Update this list and the workflow together -- drift here means
// either a category silently stopped being enforced, or a new one was added
// to the workflow without this terminal gate knowing to require it.
export const REQUIRED_PRODUCTION_APPROVAL_CATEGORIES = [
  "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED",
  "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED",
  "PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED",
  "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED",
  "PRODUCTION_SUPPORT_OPERATIONS_APPROVED",
  "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED",
  "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED",
  "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED",
  "PRODUCTION_TAX_READINESS_APPROVED",
];

export const PLATFORM_PRODUCTION_WORKFLOW_PATH = ".github/workflows/platform-production.yml";

// Ratified wave-1 admission bar values (mirrored from
// bounded-contexts/public-presence/features/waitlist/read-model/campaign-admission-bar-policy.ts,
// a TypeScript read-model module this plain-JS script cannot import
// directly). Keep both in lockstep by hand; the code-in-sync row below fails
// loudly if the source of truth drifts from these numbers.
export const WAVE_ONE_ADMISSION_BAR_POLICY_PATH =
  "bounded-contexts/public-presence/features/waitlist/read-model/campaign-admission-bar-policy.ts";
export const WAVE_ONE_ADMISSION_BAR = Object.freeze({
  minQualifiedSellers: 50,
  minQualifiedSellersPerGame: 5,
  minTotalSignups: 500,
});
export const WAITLIST_GAMES_DOMAIN_PATH = "bounded-contexts/public-presence/features/waitlist/domain/common.ts";
export const WAITLIST_GAMES = ["pokemon", "magic-the-gathering", "yu-gi-oh", "disney-lorcana", "one-piece-card-game"];

export const SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES = [
  "bounded-contexts/platform-operations/features/support-requests/domain/domain.ts",
  "bounded-contexts/platform-operations/features/support-requests/domain/return-flow-policy.ts",
  "bounded-contexts/platform-operations/features/support-requests/domain/support-deadline-policy.ts",
  "bounded-contexts/platform-operations/features/support-requests/domain/flow-catalog.ts",
  "bounded-contexts/platform-operations/features/support-requests/read-model/queries.ts",
  "bounded-contexts/platform-operations/features/support-requests/ui/support-request-list-page.tsx",
  "bounded-contexts/platform-operations/features/support-requests/ui/support-operations-page.tsx",
];

const INCIDENT_BACKLOG_MILESTONE_NUMBER = 100;
const VALID_DECISIONS = ["go", "no-go", "hold"];
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const MARKETPLACE_PROMOTION_EVIDENCE_COMMAND =
  "pnpm run ops marketplace:promotion-evidence -- --review <review.json> --public-presence-copy-audit <audit-v2.json> --reference <reference>";

/**
 * The canonical legal-corpus membership, derived once from the registry and
 * the source-owned compliance manifest. The promotion-evidence row revalidates
 * the promotion record's derived projection against THIS rather than trusting
 * `passesPromotionGate`, so a promotion record carrying a stale or shortened
 * member list fails here even if its own producer said it passed.
 *
 * Resolution failure is a bounded row diagnostic, never an import crash: this
 * terminal gate must still emit a record when the corpus cannot be read.
 */
export async function resolveCanonicalLegalCorpusMembership() {
  try {
    const membership = await loadLegalReviewMembership();
    if (!membership.policy.ok || !membership.compliance.ok) {
      return { ok: false, errors: [...membership.policy.errors, ...membership.compliance.errors] };
    }
    const uniquePaths = new Set([
      ...REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS,
      ...membership.policy.launchRequiredPolicyPaths,
      ...membership.compliance.complianceArticlePaths,
    ]);
    return {
      ok: true,
      errors: [],
      launchRequiredPolicyKeys: membership.policy.launchRequiredPolicyKeys,
      complianceArticleSlugs: membership.compliance.complianceArticleSlugs,
      uniqueFetchedPathCount: uniquePaths.size,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        `canonical legal corpus membership could not be resolved (${error instanceof Error ? error.constructor.name : "UnknownError"}).`,
      ],
    };
  }
}

const CANONICAL_LEGAL_CORPUS_MEMBERSHIP = await resolveCanonicalLegalCorpusMembership();

export function parseLaunchGoNoGoGateArgs(argv, env = process.env) {
  return {
    repoRoot: readOption(argv, "--repo-root") ?? readEnv("LAUNCH_GO_NO_GO_GATE_REPO_ROOT", env) ?? defaultRepoRoot,
    operatorEvidencePath:
      readOption(argv, "--operator-evidence") ?? readEnv("LAUNCH_GO_NO_GO_GATE_OPERATOR_EVIDENCE", env),
    reference: readOption(argv, "--reference") ?? readEnv("LAUNCH_GO_NO_GO_GATE_REFERENCE", env),
    decision: readOption(argv, "--decision") ?? readEnv("LAUNCH_GO_NO_GO_DECISION", env),
    decisionOwner: readOption(argv, "--decision-owner") ?? readEnv("LAUNCH_GO_NO_GO_DECISION_OWNER", env),
    decisionRationale: readOption(argv, "--decision-rationale") ?? readEnv("LAUNCH_GO_NO_GO_DECISION_RATIONALE", env),
    rollbackCriteriaReference:
      readOption(argv, "--rollback-criteria-reference") ?? readEnv("LAUNCH_GO_NO_GO_ROLLBACK_CRITERIA_REFERENCE", env),
    first24hMonitoringPlanReference:
      readOption(argv, "--first-24h-monitoring-plan-reference") ??
      readEnv("LAUNCH_GO_NO_GO_FIRST_24H_MONITORING_PLAN_REFERENCE", env),
    outPath: readOption(argv, "--out") ?? readEnv("LAUNCH_GO_NO_GO_GATE_OUT", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runLaunchGoNoGoGate(options) {
  const operatorEvidence = options.operatorEvidencePath ? await readJsonInput(options.operatorEvidencePath) : null;
  const result = buildLaunchGoNoGoGate({ ...options, operatorEvidence });

  if (options.outPath) {
    await writeJsonRecord(options.outPath, result);
  }

  return result;
}

export function buildLaunchGoNoGoGate(input) {
  const repoRootPath = input.repoRoot ?? defaultRepoRoot;
  const operatorEvidence = isRecord(input.operatorEvidence) ? input.operatorEvidence : {};
  const errors = [];

  if (!isNonEmptyString(input.reference)) {
    errors.push("Launch go/no-go gate requires a reference.");
  } else {
    validateEvidenceReference("Launch go/no-go gate reference", input.reference, errors);
  }
  if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Launch go/no-go gate checkedAt must be an ISO timestamp.");
  }

  const legalCorpusMembership = input.legalCorpusMembership ?? CANONICAL_LEGAL_CORPUS_MEMBERSHIP;
  const rows = [
    buildMoneyOperationsApprovalMatrixRow(repoRootPath),
    buildMarketplaceProductionLaunchReadinessRow(operatorEvidence.marketplaceProductionLaunchReadiness),
    buildMarketplacePromotionEvidenceRow(operatorEvidence.marketplacePromotionEvidence, legalCorpusMembership),
    buildGoogleShoppingLaunchReadinessRow(operatorEvidence.googleShoppingLaunchReadiness),
    buildCampaignStartGateRow(repoRootPath, operatorEvidence.campaignStartGate),
    buildLagSloRegressionGateRow(operatorEvidence.lagSloRegressionGate),
    buildIncidentBacklogRow(operatorEvidence.incidentBacklog),
    buildSupportDisputeSurfacesRow(repoRootPath),
    buildWaveOneAdmissionBarCodeInSyncRow(repoRootPath),
    buildWaveOneAdmissionBarMetRow(operatorEvidence.waveOneAdmissionBar),
    buildRollbackReadinessRow(operatorEvidence.rollbackReadiness),
  ];

  for (const row of rows) {
    if (row.status !== "pass") {
      errors.push(`${row.key}: ${row.note}`);
    }
  }

  const passesLaunchGoNoGoGate = rows.every((row) => row.status === "pass") && errors.length === 0;
  const decisionResult = buildDecisionRecord(input, passesLaunchGoNoGoGate, errors);

  return {
    schemaVersion: LAUNCH_GO_NO_GO_GATE_VERSION,
    reference: input.reference ?? null,
    checkedAt: input.checkedAt,
    rows,
    passesLaunchGoNoGoGate,
    decision: decisionResult.decision,
    operatorSetup: buildOperatorSetup(rows),
    ...(errors.length > 0 || decisionResult.errors.length > 0 ? { errors: [...errors, ...decisionResult.errors] } : {}),
  };
}

function buildDecisionRecord(input, passesLaunchGoNoGoGate, gateErrors) {
  const errors = [];

  if (!isNonEmptyString(input.decision)) {
    errors.push("Launch go/no-go gate requires an explicit --decision (go, no-go, or hold).");
  } else if (!VALID_DECISIONS.includes(input.decision)) {
    errors.push(`Launch go/no-go decision must be one of: ${VALID_DECISIONS.join(", ")}.`);
  }
  if (!isNonEmptyString(input.decisionOwner)) {
    errors.push("Launch go/no-go gate requires a decision owner.");
  }
  if (!isNonEmptyString(input.decisionRationale)) {
    errors.push("Launch go/no-go gate requires a decision rationale.");
  }
  validateEvidenceReference("Launch go/no-go rollbackCriteriaReference", input.rollbackCriteriaReference, errors);
  validateEvidenceReference(
    "Launch go/no-go first24hMonitoringPlanReference",
    input.first24hMonitoringPlanReference,
    errors,
  );

  if (input.decision === "go" && (!passesLaunchGoNoGoGate || gateErrors.length > 0)) {
    errors.push(
      "Launch go/no-go decision cannot be recorded as go while evidence rows are not all green; record no-go or hold instead.",
    );
  }

  return {
    decision: {
      value: input.decision ?? null,
      owner: input.decisionOwner ?? null,
      rationale: input.decisionRationale ?? null,
      rollbackCriteriaReference: input.rollbackCriteriaReference ?? null,
      first24hMonitoringPlanReference: input.first24hMonitoringPlanReference ?? null,
      recordedAt: input.checkedAt,
    },
    errors,
  };
}

function buildMoneyOperationsApprovalMatrixRow(repoRootPath) {
  const fullPath = path.join(repoRootPath, PLATFORM_PRODUCTION_WORKFLOW_PATH);
  const exists = existsSync(fullPath);
  const content = exists ? readFileSync(fullPath, "utf8") : "";
  const missingApproved = REQUIRED_PRODUCTION_APPROVAL_CATEGORIES.filter((name) => !content.includes(`vars.${name}`));
  const missingReference = REQUIRED_PRODUCTION_APPROVAL_CATEGORIES.filter((name) => {
    const referenceName = name.replace(/_APPROVED$/, "_REFERENCE");
    return !content.includes(`vars.${referenceName}`);
  });
  const status = exists && missingApproved.length === 0 && missingReference.length === 0 ? "pass" : "fail";
  return {
    key: "money-operations-approval-matrix",
    label: "Production promotion money-operations approval matrix present in platform-production.yml",
    automated: true,
    status,
    evidence: {
      path: PLATFORM_PRODUCTION_WORKFLOW_PATH,
      exists,
      requiredCategories: REQUIRED_PRODUCTION_APPROVAL_CATEGORIES,
      missingApproved,
      missingReference,
    },
    note:
      status === "pass"
        ? "platform-production.yml enforces every pinned production approval category and its reference."
        : `platform-production.yml is missing approval variable(s) [${missingApproved.join(", ")}] or reference variable(s) [${missingReference.join(", ")}].`,
  };
}

function buildMarketplaceProductionLaunchReadinessRow(evidence) {
  return buildImportedGateRow({
    key: "marketplace-production-launch-readiness",
    label: "Marketplace production launch readiness gate (env variables/secrets) green",
    expectedVersion: MARKETPLACE_PRODUCTION_LAUNCH_READINESS_VERSION,
    passField: "passesProductionLaunchReadinessGate",
    evidence,
    extraCheck: (record, rowErrors) => {
      if (record.environmentName !== "production") {
        rowErrors.push("environmentName must be production.");
      }
    },
    command: "pnpm run ops marketplace:production-launch-readiness -- --variables <vars.json> --secrets <secrets.json>",
  });
}

function buildMarketplacePromotionEvidenceRow(evidence, membership) {
  return buildImportedGateRow({
    key: "marketplace-promotion-evidence",
    label: "Marketplace public promotion / checkout launch evidence review green",
    expectedVersion: MARKETPLACE_PROMOTION_EVIDENCE_VERSION,
    passField: "passesPromotionGate",
    evidence,
    extraCheck: (record, rowErrors) => validatePromotionLegalCorpusProjection(record, membership, rowErrors),
    command: MARKETPLACE_PROMOTION_EVIDENCE_COMMAND,
  });
}

/**
 * Revalidates the promotion record's derived legal-corpus projection directly
 * — exact audit/packet schema versions, exact ordered membership and counts,
 * exact digest agreement, and every audit-derived boolean true — rather than
 * accepting one aggregate `passesPromotionGate` claim.
 */
export function validatePromotionLegalCorpusProjection(record, membership, rowErrors) {
  const promotion = isRecord(record.marketplacePromotion) ? record.marketplacePromotion : null;
  if (!promotion) {
    rowErrors.push("marketplacePromotion must be an object carrying the derived legal-corpus projection.");
    return;
  }
  if (!membership.ok) {
    rowErrors.push(
      `the canonical legal corpus membership could not be resolved, so the derived projection cannot be revalidated: ${membership.errors.join(" ")}`,
    );
    return;
  }

  if (promotion.publicPresenceCopyAuditVersion !== MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION) {
    rowErrors.push(`publicPresenceCopyAuditVersion must be ${MARKETPLACE_PUBLIC_PRESENCE_COPY_AUDIT_VERSION}.`);
  }
  if (promotion.publicPresenceCopyAuditMode !== "launch") {
    rowErrors.push("publicPresenceCopyAuditMode must be launch.");
  }
  if (promotion.publicPresenceCopyAuditRequiredPageCount !== REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS.length) {
    rowErrors.push(`publicPresenceCopyAuditRequiredPageCount must be ${REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS.length}.`);
  }
  if (!isExactArray(promotion.publicPresenceCopyAuditRequiredPagePaths, REQUIRED_PUBLIC_PRESENCE_PAGE_PATHS)) {
    rowErrors.push("publicPresenceCopyAuditRequiredPagePaths must be the canonical required-page paths in order.");
  }
  if (!isExactArray(promotion.publicPresenceCopyAuditLaunchRequiredPolicyKeys, membership.launchRequiredPolicyKeys)) {
    rowErrors.push(
      "publicPresenceCopyAuditLaunchRequiredPolicyKeys must be the canonical launch-required policy keys in registry order.",
    );
  }
  if (promotion.publicPresenceCopyAuditLaunchRequiredPolicyCount !== membership.launchRequiredPolicyKeys.length) {
    rowErrors.push(
      `publicPresenceCopyAuditLaunchRequiredPolicyCount must be ${membership.launchRequiredPolicyKeys.length}.`,
    );
  }
  if (!isExactArray(promotion.publicPresenceCopyAuditComplianceArticleSlugs, membership.complianceArticleSlugs)) {
    rowErrors.push(
      "publicPresenceCopyAuditComplianceArticleSlugs must be the canonical compliance article slugs in manifest order.",
    );
  }
  if (promotion.publicPresenceCopyAuditComplianceArticleCount !== membership.complianceArticleSlugs.length) {
    rowErrors.push(
      `publicPresenceCopyAuditComplianceArticleCount must be ${membership.complianceArticleSlugs.length}.`,
    );
  }
  if (promotion.publicPresenceCopyAuditUniqueFetchedPathCount !== membership.uniqueFetchedPathCount) {
    rowErrors.push(`publicPresenceCopyAuditUniqueFetchedPathCount must be ${membership.uniqueFetchedPathCount}.`);
  }
  if (promotion.counselPacketSchemaVersion !== COUNSEL_REVIEW_PACKET_VERSION) {
    rowErrors.push(`counselPacketSchemaVersion must be ${COUNSEL_REVIEW_PACKET_VERSION}.`);
  }
  if (typeof promotion.counselPacketSha256 !== "string" || !SHA256_PATTERN.test(promotion.counselPacketSha256)) {
    rowErrors.push("counselPacketSha256 must be a lowercase sha256 digest of the retained packet bytes.");
  }
  if (!Number.isInteger(promotion.counselPacketUtf8Bytes) || promotion.counselPacketUtf8Bytes <= 0) {
    rowErrors.push("counselPacketUtf8Bytes must be a positive integer.");
  }
  if (
    typeof promotion.publicPresenceCopyAuditLegalCorpusDigest !== "string" ||
    !SHA256_PATTERN.test(promotion.publicPresenceCopyAuditLegalCorpusDigest) ||
    promotion.counselPacketCorpusSha256 !== promotion.publicPresenceCopyAuditLegalCorpusDigest
  ) {
    rowErrors.push(
      "counselPacketCorpusSha256 must equal the audited current publicPresenceCopyAuditLegalCorpusDigest.",
    );
  }
  for (const field of [
    "counselPacketVerified",
    "publicPresenceCopyAuditPassed",
    "publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved",
    "publicPresenceCopyAuditPolicyPagesReviewed",
    "publicPresenceCopyAuditComplianceArticlesReviewed",
    "publicPresenceCopyAuditDmcaRegistrationMarkerAbsent",
    "publicPresenceCopyAuditUncertifiedClaimsAbsent",
    "publicPresenceLaunchCopyReviewed",
    "futureOnlyLaunchCopyRemoved",
    "policyPagesReviewed",
  ]) {
    if (promotion[field] !== true) {
      rowErrors.push(`${field} must be true.`);
    }
  }
}

function isExactArray(value, expected) {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function buildGoogleShoppingLaunchReadinessRow(evidence) {
  return buildImportedGateRow({
    key: "google-shopping-launch-readiness",
    label: "Google Shopping launch readiness evidence gate green",
    expectedVersion: GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION,
    passField: "passesGoogleShoppingLaunchReadinessGate",
    evidence,
    command: "pnpm run ops google-shopping:launch-readiness-evidence -- --expected-mode live ...",
  });
}

function buildImportedGateRow({ key, label, expectedVersion, passField, evidence, command, extraCheck }) {
  const record = isRecord(evidence) ? evidence : null;
  const rowErrors = [];

  if (!record) {
    rowErrors.push(`requires operator evidence recording a real run of \`${command}\` against production.`);
  } else {
    if (record.schemaVersion !== expectedVersion) {
      rowErrors.push(`schemaVersion must be ${expectedVersion}.`);
    }
    if (record[passField] !== true) {
      rowErrors.push(`${passField} must be true.`);
    }
    if (extraCheck) {
      extraCheck(record, rowErrors);
    }
  }

  const status = rowErrors.length === 0 ? "pass" : "pending";
  return {
    key,
    label,
    automated: false,
    status,
    evidence: record,
    note: status === "pass" ? `${label}: operator evidence confirms the gate is green.` : rowErrors.join(" "),
  };
}

function buildCampaignStartGateRow(repoRootPath, evidence) {
  const scriptExists = existsSync(path.join(repoRootPath, CAMPAIGN_START_GATE_SCRIPT_PATH));
  if (!scriptExists) {
    return {
      key: "campaign-start-gate",
      label: "Campaign-start checklist gate green",
      automated: false,
      status: "not-yet-integrated",
      evidence: { scriptPath: CAMPAIGN_START_GATE_SCRIPT_PATH, scriptExists },
      note: "The campaign-start-gate.mjs sibling gate has not landed on this branch yet (see PR #5110); this row blocks go/no-go until it merges and reports pass.",
    };
  }

  const row = buildImportedGateRow({
    key: "campaign-start-gate",
    label: "Campaign-start checklist gate green",
    expectedVersion: CAMPAIGN_START_GATE_EXPECTED_VERSION,
    passField: "passesCampaignStartGate",
    evidence,
    command: "pnpm run ops campaign:start-gate -- --reference <reference> --owner <owner>",
  });
  return row;
}

function buildLagSloRegressionGateRow(evidence) {
  const record = isRecord(evidence) ? evidence : null;
  const rowErrors = [];

  if (!record) {
    rowErrors.push(
      "requires operator evidence recording a green segment-level projection lag SLO regression gate run (release-health:report --gate).",
    );
  } else {
    if (record.schemaVersion !== RELEASE_HEALTH_REPORT_VERSION) {
      rowErrors.push(`schemaVersion must be ${RELEASE_HEALTH_REPORT_VERSION}.`);
    }
    if (record.gateEnabled !== true) {
      rowErrors.push("gateEnabled must be true (the run must have used --gate).");
    }
    if (record.gatePassed !== true) {
      rowErrors.push("gatePassed must be true.");
    }
    validateEvidenceReference("lagSloRegressionGate workflowRunReference", record.workflowRunReference, rowErrors);
  }

  const status = rowErrors.length === 0 ? "pass" : "pending";
  return {
    key: "lag-slo-regression-gate",
    label: "Segment-level projection lag SLO regression gate green",
    automated: false,
    status,
    evidence: record,
    note:
      status === "pass"
        ? "Operator evidence confirms a green release-health:report --gate run against a live traffic window."
        : rowErrors.join(" "),
  };
}

function buildIncidentBacklogRow(evidence) {
  const record = isRecord(evidence) ? evidence : null;
  const rowErrors = [];

  if (!record) {
    rowErrors.push(
      `requires operator evidence confirming the Incidents milestone (#${INCIDENT_BACKLOG_MILESTONE_NUMBER}) is zero-or-triaged.`,
    );
  } else {
    if (record.milestoneNumber !== INCIDENT_BACKLOG_MILESTONE_NUMBER) {
      rowErrors.push(`milestoneNumber must be ${INCIDENT_BACKLOG_MILESTONE_NUMBER}.`);
    }
    if (!Number.isInteger(record.openIncidentCount) || record.openIncidentCount < 0) {
      rowErrors.push("openIncidentCount must be a non-negative integer.");
    }
    if (!Number.isInteger(record.untriagedIncidentCount) || record.untriagedIncidentCount < 0) {
      rowErrors.push("untriagedIncidentCount must be a non-negative integer.");
    }
    if (Number.isInteger(record.untriagedIncidentCount) && record.untriagedIncidentCount > 0) {
      rowErrors.push("untriagedIncidentCount must be zero (backlog must be zero-or-triaged).");
    }
    if (!isIsoTimestamp(record.verifiedAt)) {
      rowErrors.push("verifiedAt must be an ISO timestamp.");
    }
    validateEvidenceReference("incidentBacklog evidenceReference", record.evidenceReference, rowErrors);
  }

  const status = rowErrors.length === 0 ? "pass" : "pending";
  return {
    key: "incident-backlog-zero-or-triaged",
    label: "Incident backlog is zero-or-triaged",
    automated: false,
    status,
    evidence: record,
    note:
      status === "pass"
        ? "Operator evidence confirms the incident backlog has no untriaged issues."
        : rowErrors.join(" "),
  };
}

function buildSupportDisputeSurfacesRow(repoRootPath) {
  const missingFiles = SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES.filter(
    (relativePath) => !existsSync(path.join(repoRootPath, relativePath)),
  );
  const status = missingFiles.length === 0 ? "pass" : "fail";
  return {
    key: "support-dispute-surfaces-ready",
    label: "Dispute and return resolution self-service core surfaces present",
    automated: true,
    status,
    evidence: { checkedFiles: SUPPORT_DISPUTE_SELF_SERVICE_SURFACE_FILES, missingFiles },
    note:
      status === "pass"
        ? "The self-service structured-offer/contested-case/deadline-automation core surfaces are present. Later dispute-experience polish (case detail page, evidence upload, admin workbench) remains tracked separately and is not required by this row."
        : `Missing dispute/return self-service surface file(s): ${missingFiles.join(", ")}.`,
  };
}

function buildWaveOneAdmissionBarCodeInSyncRow(repoRootPath) {
  const policyPath = path.join(repoRootPath, WAVE_ONE_ADMISSION_BAR_POLICY_PATH);
  const policyExists = existsSync(policyPath);
  const policyContent = policyExists ? readFileSync(policyPath, "utf8") : "";
  const hasMinQualifiedSellers = policyContent.includes(
    `minQualifiedSellers: ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellers}`,
  );
  const hasMinQualifiedSellersPerGame = policyContent.includes(
    `minQualifiedSellersPerGame: ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame}`,
  );
  const hasMinTotalSignups = policyContent.includes(`minTotalSignups: ${WAVE_ONE_ADMISSION_BAR.minTotalSignups}`);

  const domainPath = path.join(repoRootPath, WAITLIST_GAMES_DOMAIN_PATH);
  const domainExists = existsSync(domainPath);
  const domainContent = domainExists ? readFileSync(domainPath, "utf8") : "";
  const missingGames = WAITLIST_GAMES.filter((game) => !domainContent.includes(`"${game}"`));

  const status =
    policyExists &&
    domainExists &&
    hasMinQualifiedSellers &&
    hasMinQualifiedSellersPerGame &&
    hasMinTotalSignups &&
    missingGames.length === 0
      ? "pass"
      : "fail";

  return {
    key: "wave-one-admission-bar-code-in-sync",
    label: "Wave-1 admission bar code matches the ratified launch facts",
    automated: true,
    status,
    evidence: {
      policyPath: WAVE_ONE_ADMISSION_BAR_POLICY_PATH,
      policyExists,
      ratifiedBar: WAVE_ONE_ADMISSION_BAR,
      hasMinQualifiedSellers,
      hasMinQualifiedSellersPerGame,
      hasMinTotalSignups,
      domainPath: WAITLIST_GAMES_DOMAIN_PATH,
      domainExists,
      requiredGames: WAITLIST_GAMES,
      missingGames,
    },
    note:
      status === "pass"
        ? "campaign-admission-bar-policy.ts carries the ratified >=50 sellers / >=5-per-game / >=500-signup bar across all five games."
        : "The wave-1 admission bar policy module is missing or has drifted from the ratified launch facts (>=50 qualified sellers, >=5 per game across 5 games, >=500 total signups).",
  };
}

function buildWaveOneAdmissionBarMetRow(evidence) {
  const record = isRecord(evidence) ? evidence : null;
  const rowErrors = [];
  let status;

  if (!record) {
    rowErrors.push("requires operator evidence recording real wave-1 signup/seller counts from production.");
    status = "pending";
  } else {
    if (!Number.isInteger(record.totalSignups) || record.totalSignups < 0) {
      rowErrors.push("totalSignups must be a non-negative integer.");
    }
    if (!Number.isInteger(record.qualifiedSellerCount) || record.qualifiedSellerCount < 0) {
      rowErrors.push("qualifiedSellerCount must be a non-negative integer.");
    }
    if (!isRecord(record.qualifiedSellersByGame)) {
      rowErrors.push("qualifiedSellersByGame must be an object keyed by game.");
    }
    if (!isIsoTimestamp(record.verifiedAt)) {
      rowErrors.push("verifiedAt must be an ISO timestamp.");
    }
    validateEvidenceReference("waveOneAdmissionBar evidenceReference", record.evidenceReference, rowErrors);

    if (rowErrors.length === 0) {
      const admission = evaluateWaveOneAdmissionBar(record);
      if (!admission.admitted) {
        rowErrors.push(`Wave-1 admission bar not met: ${describeAdmissionGap(admission)}.`);
      }
      status = admission.admitted ? "pass" : "fail";
    } else {
      status = "fail";
    }
  }

  return {
    key: "wave-one-admission-bar-met",
    label: "Wave-1 admission bar met (>=50 qualified sellers, 5 games >=5 each, >=500 signups)",
    automated: false,
    status,
    evidence: record,
    note:
      status === "pass"
        ? "Operator evidence confirms wave-1 clears every admission-bar condition."
        : rowErrors.join(" "),
  };
}

// Mirrors evaluateWaveOneAdmissionBar in
// bounded-contexts/public-presence/features/waitlist/read-model/campaign-admission-bar-policy.ts
// -- duplicated here (not imported) because this script runs as plain Node,
// not through the TypeScript-aware runtime the bounded context uses. Keep
// this in lockstep with that module; the code-in-sync row above only checks
// the threshold constants, not this evaluation logic.
function evaluateWaveOneAdmissionBar(input) {
  const gameCoverage = WAITLIST_GAMES.map((game) => {
    const qualifiedSellerCount = Number(input.qualifiedSellersByGame?.[game] ?? 0);
    return {
      game,
      qualifiedSellerCount,
      covered: qualifiedSellerCount >= WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame,
    };
  });
  const allGamesCovered = gameCoverage.every((entry) => entry.covered);
  const totalSignupsMet = input.totalSignups >= WAVE_ONE_ADMISSION_BAR.minTotalSignups;
  const qualifiedSellersMet = input.qualifiedSellerCount >= WAVE_ONE_ADMISSION_BAR.minQualifiedSellers;

  return {
    totalSignupsMet,
    qualifiedSellersMet,
    gameCoverage,
    allGamesCovered,
    admitted: totalSignupsMet && qualifiedSellersMet && allGamesCovered,
  };
}

function describeAdmissionGap(admission) {
  const gaps = [];
  if (!admission.totalSignupsMet) {
    gaps.push(`total signups below ${WAVE_ONE_ADMISSION_BAR.minTotalSignups}`);
  }
  if (!admission.qualifiedSellersMet) {
    gaps.push(`qualified sellers below ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellers}`);
  }
  const uncoveredGames = admission.gameCoverage.filter((entry) => !entry.covered).map((entry) => entry.game);
  if (uncoveredGames.length > 0) {
    gaps.push(
      `game(s) below ${WAVE_ONE_ADMISSION_BAR.minQualifiedSellersPerGame} qualified sellers: ${uncoveredGames.join(", ")}`,
    );
  }
  return gaps.join("; ");
}

function buildRollbackReadinessRow(evidence) {
  const record = isRecord(evidence) ? evidence : null;
  if (!record) {
    return {
      key: "rollback-readiness",
      label: "Wave-1 rollback readiness recorded",
      automated: false,
      status: "pending",
      evidence: null,
      note: "requires operator evidence recording rollback-readiness inputs (target commit, image, smoke verification, emergency reference).",
    };
  }

  const { passesRollbackReadinessGate, record: readinessRecord } = evaluateRollbackReadiness(record);
  return {
    key: "rollback-readiness",
    label: "Wave-1 rollback readiness recorded",
    automated: false,
    status: passesRollbackReadinessGate ? "pass" : "fail",
    evidence: readinessRecord,
    note: passesRollbackReadinessGate
      ? "Rollback readiness evaluates clean for the recorded target."
      : `Rollback readiness blockers: ${readinessRecord.blockers.join(" ")}`,
  };
}

function buildOperatorSetup(rows) {
  const pendingRows = rows.filter((row) => row.status !== "pass");
  return {
    pendingKeys: pendingRows.map((row) => row.key),
    operatorEvidenceCommand:
      "pnpm run ops launch:go-no-go-gate -- --operator-evidence <evidence.json> --reference <reference> --decision <go|no-go|hold> --decision-owner <name> --decision-rationale <text> --rollback-criteria-reference <reference> --first-24h-monitoring-plan-reference <reference>",
    notes: [
      "Automated rows are derived from repository content only; they do not prove production behavior.",
      "Every operator-attested row requires a real run of its underlying ops command against production, recorded in the operator evidence file.",
      "A `go` decision is refused unless every row reports pass; record `no-go` or `hold` with a rationale otherwise.",
      "Re-run this gate after supplying operator evidence and a decision; the gate only records `go` once every row, including production evidence, reports pass.",
    ],
  };
}

async function main(argv, env = process.env) {
  const options = parseLaunchGoNoGoGateArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const result = await runLaunchGoNoGoGate(options);
  console.log(JSON.stringify(result, null, 2));

  if (result.errors) {
    console.error("Launch go/no-go gate did not record a go decision.");
    return 1;
  }
  if (result.decision.value !== "go") {
    console.error(
      `Launch go/no-go decision recorded as "${result.decision.value}"; production promotion stays blocked.`,
    );
    return 1;
  }
  return 0;
}

function validateOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.reference)) {
    errors.push("LAUNCH_GO_NO_GO_GATE_REFERENCE or --reference is required.");
  }
  return errors;
}

export async function readJsonInput(inputPath, readStdinImpl = readStdin) {
  if (inputPath === "-") {
    return JSON.parse(await readStdinImpl());
  }
  return JSON.parse(await readFile(inputPath, "utf8"));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
