#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION = "google-shopping-launch-readiness-evidence/v1";
export const GOOGLE_SHOPPING_REQUIRED_TARGET_COUNTRY = "US";
export const GOOGLE_SHOPPING_REQUIRED_CONTENT_LANGUAGE = "en";
export const GOOGLE_SHOPPING_REQUIRED_FEED_LABEL = "US";
export const GOOGLE_SHOPPING_REQUIRED_PRODUCTION_ORIGIN = "https://marketplace.chasesets.com";
export const GOOGLE_SHOPPING_OPERATIONS_RUNBOOK_PATH = "docs/runbooks/google-shopping-operations.md";

const EXPECTED_MODES = new Set(["disabled", "dry-run", "live"]);
const REQUIRED_MERCHANT_CONFIG_FIELDS = [
  "GOOGLE_MERCHANT_ACCOUNT_ID",
  "GOOGLE_MERCHANT_API_DATA_SOURCE_ID",
  "GOOGLE_MERCHANT_TARGET_COUNTRY",
  "GOOGLE_MERCHANT_CONTENT_LANGUAGE",
  "GOOGLE_MERCHANT_FEED_LABEL",
  "GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME",
];
const REQUIRED_POLICY_REFERENCES = [
  "accountApprovalReference",
  "apiDataSourceReference",
  "policyReviewReference",
  "merchantShippingSettingsReference",
  "merchantReturnsSettingsReference",
  "taxReadinessReference",
];

export function parseGoogleShoppingLaunchReadinessArgs(argv, env = process.env) {
  return {
    readinessReportPath: readOption(argv, "--readiness-report") ?? readEnv("GOOGLE_SHOPPING_READINESS_REPORT", env),
    expectedMode:
      readOption(argv, "--expected-mode") ?? readEnv("GOOGLE_SHOPPING_LAUNCH_EXPECTED_MODE", env) ?? "dry-run",
    reference: readOption(argv, "--reference") ?? readEnv("GOOGLE_SHOPPING_LAUNCH_READINESS_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("GOOGLE_SHOPPING_LAUNCH_READINESS_OWNER", env) ?? "Operations",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    productionSyncApprovalReference:
      readOption(argv, "--production-sync-approval-reference") ??
      readEnv("GOOGLE_SHOPPING_PRODUCTION_SYNC_APPROVAL_REFERENCE", env),
  };
}

export async function readGoogleShoppingReadinessReport(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runGoogleShoppingLaunchReadinessEvidence(options) {
  const readinessReport = await readGoogleShoppingReadinessReport(options.readinessReportPath);
  return buildGoogleShoppingLaunchReadinessEvidence({
    ...options,
    readinessReport,
  });
}

export function buildGoogleShoppingLaunchReadinessEvidence(input) {
  const errors = [];
  const warnings = [];
  const expectedMode = normalizeExpectedMode(input.expectedMode, errors);
  const report = isRecord(input.readinessReport) ? input.readinessReport : {};
  const productionEnvironment = isRecord(report.productionEnvironment) ? report.productionEnvironment : {};
  const syncEnabled = readBooleanValue(productionEnvironment.GOOGLE_MERCHANT_SYNC_ENABLED);
  const dryRun = readBooleanValue(productionEnvironment.GOOGLE_MERCHANT_DRY_RUN);
  const marketplaceIndexing = readBooleanValue(productionEnvironment.CHASE_SETS_MARKETPLACE_INDEXING);
  const configSummary = merchantConfigSummary(productionEnvironment);

  validateCommonEvidenceInputs(input, errors);
  validateModeConfiguration({
    expectedMode,
    productionEnvironment,
    syncEnabled,
    dryRun,
    marketplaceIndexing,
    productionSyncApprovalReference: input.productionSyncApprovalReference,
    errors,
    warnings,
  });

  const shouldValidateReadiness = expectedMode !== "disabled";
  const feed = shouldValidateReadiness
    ? validateFeedQuality(report.feed, errors, warnings)
    : disabledFeedSummary(report.feed);
  const crawl = shouldValidateReadiness
    ? validateCrawlPosture(report.crawlPosture, errors)
    : disabledCrawlSummary(report.crawlPosture);
  const policy = shouldValidateReadiness
    ? validatePolicyReadiness(report.policy, errors)
    : disabledPolicySummary(report.policy);
  const diagnostics = shouldValidateReadiness
    ? validateDiagnostics(report.diagnostics, errors, warnings)
    : disabledDiagnosticsSummary(report.diagnostics);
  const sync = shouldValidateReadiness ? validateSyncState(report.sync, errors) : disabledSyncSummary(report.sync);

  const passesGoogleShoppingLaunchReadinessGate = errors.length === 0;
  const readinessStatus = passesGoogleShoppingLaunchReadinessGate ? expectedMode : "blocked";

  return {
    schemaVersion: GOOGLE_SHOPPING_LAUNCH_READINESS_EVIDENCE_VERSION,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    runbook: {
      path: GOOGLE_SHOPPING_OPERATIONS_RUNBOOK_PATH,
      launchEvidenceSection: "Launch Readiness Evidence",
      operatorSurfaceLinkText: "Google Shopping Operations",
    },
    expectedMode,
    readinessStatus,
    productionEnvironment: {
      googleMerchantSyncEnabled: syncEnabled,
      googleMerchantDryRun: dryRun,
      marketplaceIndexing,
      merchantConfig: configSummary,
    },
    gates: {
      environment: {
        approved: environmentGateApproved(expectedMode, syncEnabled, dryRun, marketplaceIndexing, configSummary),
        productionSyncApprovalReference: input.productionSyncApprovalReference ?? null,
      },
      feedQuality: feed,
      crawlability: crawl,
      policyReadiness: policy,
      diagnostics,
      syncState: sync,
    },
    merchantFeedSubmissionAllowed:
      expectedMode === "live" && passesGoogleShoppingLaunchReadinessGate && syncEnabled === true && dryRun === false,
    passesGoogleShoppingLaunchReadinessGate,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parseGoogleShoppingLaunchReadinessArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runGoogleShoppingLaunchReadinessEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesGoogleShoppingLaunchReadinessGate) {
    console.error("Google Shopping launch readiness evidence failed.");
    return 1;
  }
  return 0;
}

function validateCommonEvidenceInputs(input, errors) {
  if (!isNonEmptyString(input.reference)) {
    errors.push("Google Shopping launch readiness evidence requires --reference.");
  } else {
    validateEvidenceReference("Google Shopping launch readiness reference", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Google Shopping launch readiness evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Google Shopping launch readiness evidence requires checkedAt.");
  } else if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Google Shopping launch readiness checkedAt must be an ISO timestamp.");
  }
}

function validateModeConfiguration(input) {
  if (input.expectedMode === "disabled") {
    if (input.syncEnabled === true && input.dryRun === false) {
      input.errors.push("Google Shopping disabled mode cannot have live Merchant sync enabled.");
    }
    return;
  }

  if (input.syncEnabled !== true) {
    input.errors.push("GOOGLE_MERCHANT_SYNC_ENABLED must be true when Google Shopping readiness is expected.");
  }
  if (input.dryRun === null) {
    input.errors.push("GOOGLE_MERCHANT_DRY_RUN must be present as true or false.");
  }
  if (input.expectedMode === "dry-run" && input.dryRun !== true) {
    input.errors.push("Google Shopping dry-run readiness requires GOOGLE_MERCHANT_DRY_RUN=true.");
  }
  if (input.expectedMode === "live") {
    if (input.dryRun !== false) {
      input.errors.push("Google Shopping live readiness requires GOOGLE_MERCHANT_DRY_RUN=false.");
    }
    if (input.marketplaceIndexing !== true) {
      input.errors.push("Google Shopping live readiness requires CHASE_SETS_MARKETPLACE_INDEXING=true.");
    }
    if (!isNonEmptyString(input.productionSyncApprovalReference)) {
      input.errors.push("Google Shopping live readiness requires productionSyncApprovalReference.");
    } else {
      validateEvidenceReference(
        "Google Shopping production sync approval reference",
        input.productionSyncApprovalReference,
        input.errors,
      );
    }
  }

  for (const field of REQUIRED_MERCHANT_CONFIG_FIELDS) {
    if (!isNonEmptyString(input.productionEnvironment[field])) {
      input.errors.push(`${field} must be present when Google Merchant sync is expected.`);
    }
  }

  if (input.productionEnvironment.GOOGLE_MERCHANT_TARGET_COUNTRY !== GOOGLE_SHOPPING_REQUIRED_TARGET_COUNTRY) {
    input.errors.push(`GOOGLE_MERCHANT_TARGET_COUNTRY must be ${GOOGLE_SHOPPING_REQUIRED_TARGET_COUNTRY}.`);
  }
  if (input.productionEnvironment.GOOGLE_MERCHANT_CONTENT_LANGUAGE !== GOOGLE_SHOPPING_REQUIRED_CONTENT_LANGUAGE) {
    input.errors.push(`GOOGLE_MERCHANT_CONTENT_LANGUAGE must be ${GOOGLE_SHOPPING_REQUIRED_CONTENT_LANGUAGE}.`);
  }
  if (input.productionEnvironment.GOOGLE_MERCHANT_FEED_LABEL !== GOOGLE_SHOPPING_REQUIRED_FEED_LABEL) {
    input.errors.push(`GOOGLE_MERCHANT_FEED_LABEL must be ${GOOGLE_SHOPPING_REQUIRED_FEED_LABEL}.`);
  }

  if (input.expectedMode === "dry-run" && input.marketplaceIndexing !== true) {
    input.warnings.push("Google Shopping dry-run readiness should use production indexing posture before live launch.");
  }
}

function validateFeedQuality(feedValue, errors, warnings) {
  const startingErrorCount = errors.length;
  const feed = isRecord(feedValue) ? feedValue : {};
  if (!isRecord(feedValue)) {
    errors.push("Google Shopping readiness report must include feed evidence.");
  }
  const totalRows = integerValue(feed.totalRows);
  const eligibleRows = integerValue(feed.eligibleRows);
  const excludedRows = integerValue(feed.excludedRows);
  const samplePayloads = Array.isArray(feed.samplePayloads) ? feed.samplePayloads : [];
  const sampleImageChecks = Array.isArray(feed.sampleImageChecks) ? feed.sampleImageChecks : [];
  const blockingIssueCounts = isRecord(feed.blockingIssueCounts) ? feed.blockingIssueCounts : {};

  if (totalRows <= 0) {
    errors.push("Google Shopping feed evidence must include at least one export row.");
  }
  if (eligibleRows <= 0) {
    errors.push("Google Shopping feed evidence must include at least one eligible row.");
  }
  if (eligibleRows + excludedRows !== totalRows) {
    errors.push("Google Shopping eligibleRows plus excludedRows must equal totalRows.");
  }
  for (const [reason, count] of Object.entries(blockingIssueCounts)) {
    if (integerValue(count) > 0) {
      errors.push(`Google Shopping feed has ${count} blocking ${reason} issue(s).`);
    }
  }
  if (eligibleRows > 0 && samplePayloads.length === 0) {
    errors.push("Google Shopping feed evidence must include at least one sample payload.");
  }
  samplePayloads.forEach((payload, index) => validateSamplePayload(payload, index, errors));
  sampleImageChecks.forEach((check, index) => validateSampleImageCheck(check, index, errors));
  if (samplePayloads.length < Math.min(3, eligibleRows)) {
    warnings.push("Google Shopping feed evidence should sample at least three eligible payloads when available.");
  }

  return {
    approved: errors.length === startingErrorCount,
    totalRows,
    eligibleRows,
    excludedRows,
    exclusionReasonCounts: isRecord(feed.exclusionReasonCounts) ? feed.exclusionReasonCounts : {},
    imageEligibilityCounts: isRecord(feed.imageEligibilityCounts) ? feed.imageEligibilityCounts : {},
    blockingIssueCounts,
    samplePayloadCount: samplePayloads.length,
    sampleImageCheckCount: sampleImageChecks.length,
  };
}

function validateSamplePayload(payloadValue, index, errors) {
  const label = `Google Shopping sample payload ${index + 1}`;
  if (!isRecord(payloadValue)) {
    errors.push(`${label} must be a JSON object.`);
    return;
  }
  const requiredStrings = [
    "offerId",
    "title",
    "description",
    "link",
    "imageLink",
    "priceAmount",
    "currencyCode",
    "availability",
    "condition",
    "externalSellerId",
    "targetCountry",
    "contentLanguage",
    "feedLabel",
  ];
  for (const field of requiredStrings) {
    if (!isNonEmptyString(payloadValue[field])) {
      errors.push(`${label} must include ${field}.`);
    }
  }
  if (isNonEmptyString(payloadValue.offerId) && !payloadValue.offerId.startsWith("cs-listing-")) {
    errors.push(`${label} offerId must use the cs-listing- prefix.`);
  }
  if (isNonEmptyString(payloadValue.externalSellerId) && !payloadValue.externalSellerId.startsWith("cs-account-")) {
    errors.push(`${label} externalSellerId must use the cs-account- prefix.`);
  }
  validateProductionUrl(`${label} link`, payloadValue.link, errors, {
    requiredOrigin: GOOGLE_SHOPPING_REQUIRED_PRODUCTION_ORIGIN,
  });
  validateProductionUrl(`${label} imageLink`, payloadValue.imageLink, errors);
  if (!isPositiveMoneyAmount(payloadValue.priceAmount)) {
    errors.push(`${label} priceAmount must be positive.`);
  }
  if (!["in stock", "out of stock"].includes(payloadValue.availability)) {
    errors.push(`${label} availability must be in stock or out of stock.`);
  }
  if (!["new", "used"].includes(payloadValue.condition)) {
    errors.push(`${label} condition must be new or used.`);
  }
  if (payloadValue.targetCountry !== GOOGLE_SHOPPING_REQUIRED_TARGET_COUNTRY) {
    errors.push(`${label} targetCountry must be ${GOOGLE_SHOPPING_REQUIRED_TARGET_COUNTRY}.`);
  }
  if (payloadValue.contentLanguage !== GOOGLE_SHOPPING_REQUIRED_CONTENT_LANGUAGE) {
    errors.push(`${label} contentLanguage must be ${GOOGLE_SHOPPING_REQUIRED_CONTENT_LANGUAGE}.`);
  }
  if (payloadValue.feedLabel !== GOOGLE_SHOPPING_REQUIRED_FEED_LABEL) {
    errors.push(`${label} feedLabel must be ${GOOGLE_SHOPPING_REQUIRED_FEED_LABEL}.`);
  }
}

function validateSampleImageCheck(checkValue, index, errors) {
  const label = `Google Shopping sample image check ${index + 1}`;
  if (!isRecord(checkValue)) {
    errors.push(`${label} must be a JSON object.`);
    return;
  }
  validateProductionUrl(`${label} url`, checkValue.url, errors);
  if (integerValue(checkValue.status) !== 200) {
    errors.push(`${label} must return HTTP 200.`);
  }
}

function validateCrawlPosture(crawlValue, errors) {
  const startingErrorCount = errors.length;
  const crawl = isRecord(crawlValue) ? crawlValue : {};
  if (!isRecord(crawlValue)) {
    errors.push("Google Shopping readiness report must include crawl posture evidence.");
  }
  if (crawl.schemaVersion !== "google-shopping-crawl-posture-evidence/v1") {
    errors.push("Google Shopping crawl posture evidence must use google-shopping-crawl-posture-evidence/v1.");
  }
  if (crawl.baseUrl !== GOOGLE_SHOPPING_REQUIRED_PRODUCTION_ORIGIN) {
    errors.push(`Google Shopping crawl posture baseUrl must be ${GOOGLE_SHOPPING_REQUIRED_PRODUCTION_ORIGIN}.`);
  }
  if (crawl.passesGoogleShoppingCrawlPostureGate !== true) {
    errors.push("Google Shopping crawl posture gate must pass.");
  }
  if (crawl.merchantFeedSubmissionAllowed !== true) {
    errors.push("Google Shopping crawl posture must allow Merchant feed submission.");
  }

  return {
    approved: errors.length === startingErrorCount,
    baseUrl: crawl.baseUrl ?? null,
    sampledFeedLinkCount: Array.isArray(crawl.sitemap?.sampledFeedLinks) ? crawl.sitemap.sampledFeedLinks.length : 0,
  };
}

function validatePolicyReadiness(policyValue, errors) {
  const startingErrorCount = errors.length;
  const policy = isRecord(policyValue) ? policyValue : {};
  if (!isRecord(policyValue)) {
    errors.push("Google Shopping readiness report must include policy evidence.");
  }
  for (const field of REQUIRED_POLICY_REFERENCES) {
    if (!isNonEmptyString(policy[field])) {
      errors.push(`Google Shopping policy evidence requires ${field}.`);
    } else {
      validateEvidenceReference(`Google Shopping policy ${field}`, policy[field], errors);
    }
  }
  validateProductionUrl("Google Shopping publicShippingPolicyUrl", policy.publicShippingPolicyUrl, errors);
  validateProductionUrl("Google Shopping publicReturnsPolicyUrl", policy.publicReturnsPolicyUrl, errors);
  if (!isNonEmptyString(policy.returnPolicyLabel)) {
    errors.push("Google Shopping policy evidence requires returnPolicyLabel.");
  }

  return {
    approved: errors.length === startingErrorCount,
    accountApprovalReference: policy.accountApprovalReference ?? null,
    apiDataSourceReference: policy.apiDataSourceReference ?? null,
    merchantShippingSettingsReference: policy.merchantShippingSettingsReference ?? null,
    merchantReturnsSettingsReference: policy.merchantReturnsSettingsReference ?? null,
    taxReadinessReference: policy.taxReadinessReference ?? null,
  };
}

function validateDiagnostics(diagnosticsValue, errors, warnings) {
  const startingErrorCount = errors.length;
  const diagnostics = isRecord(diagnosticsValue) ? diagnosticsValue : {};
  if (!isRecord(diagnosticsValue)) {
    errors.push("Google Shopping readiness report must include diagnostics evidence.");
  }
  const totals = isRecord(diagnostics.totals) ? diagnostics.totals : {};
  const launchImpact = isRecord(diagnostics.launchImpact) ? diagnostics.launchImpact : {};
  const disapproved = integerValue(totals.disapproved);
  const pending = integerValue(totals.pending);
  const approvedWithIssues = integerValue(totals.approvedWithIssues);
  const unknownIssueCodeCount = integerValue(diagnostics.unknownIssueCodeCount);

  if (launchImpact.p0 === true || disapproved > 0) {
    errors.push("Google Shopping diagnostics must have zero disapproved submitted rows.");
  }
  if (unknownIssueCodeCount > 0 || launchImpact.p1 === true) {
    warnings.push("Google Shopping diagnostics include P1 provider issues that require operator review.");
  }
  if (pending > 0) {
    warnings.push("Google Shopping diagnostics include pending rows; review before live launch.");
  }

  return {
    approved: errors.length === startingErrorCount,
    totals: {
      rows: integerValue(totals.rows),
      approved: integerValue(totals.approved),
      disapproved,
      pending,
      approvedWithIssues,
      unknown: integerValue(totals.unknown),
    },
    unknownIssueCodeCount,
    launchImpact: {
      p0: launchImpact.p0 === true,
      p1: launchImpact.p1 === true,
      reasons: Array.isArray(launchImpact.reasons) ? launchImpact.reasons : [],
    },
  };
}

function validateSyncState(syncValue, errors) {
  const startingErrorCount = errors.length;
  const sync = isRecord(syncValue) ? syncValue : {};
  if (!isRecord(syncValue)) {
    errors.push("Google Shopping readiness report must include dry-run sync evidence.");
  }
  if (sync.mode !== "dry-run") {
    errors.push("Google Shopping sync evidence must come from a dry-run sync.");
  }
  if (!["completed", "succeeded", "success"].includes(sync.status)) {
    errors.push("Google Shopping dry-run sync status must be completed.");
  }
  if (integerValue(sync.failed) > 0) {
    errors.push("Google Shopping dry-run sync must have zero failed rows.");
  }
  if (integerValue(sync.total) <= 0) {
    errors.push("Google Shopping dry-run sync must process at least one row.");
  }
  if (!isNonEmptyString(sync.jobReference)) {
    errors.push("Google Shopping sync evidence requires jobReference.");
  } else {
    validateEvidenceReference("Google Shopping dry-run sync jobReference", sync.jobReference, errors);
  }
  if (!isIsoTimestamp(sync.completedAt)) {
    errors.push("Google Shopping dry-run sync completedAt must be an ISO timestamp.");
  }

  return {
    approved: errors.length === startingErrorCount,
    mode: sync.mode ?? null,
    status: sync.status ?? null,
    total: integerValue(sync.total),
    submitted: integerValue(sync.submitted),
    skipped: integerValue(sync.skipped),
    deleted: integerValue(sync.deleted),
    failed: integerValue(sync.failed),
    excluded: integerValue(sync.excluded),
    jobReference: sync.jobReference ?? null,
    completedAt: sync.completedAt ?? null,
  };
}

function disabledFeedSummary(feedValue) {
  const feed = isRecord(feedValue) ? feedValue : {};
  return {
    approved: true,
    totalRows: integerValue(feed.totalRows),
    eligibleRows: integerValue(feed.eligibleRows),
    excludedRows: integerValue(feed.excludedRows),
  };
}

function disabledCrawlSummary(crawlValue) {
  const crawl = isRecord(crawlValue) ? crawlValue : {};
  return {
    approved: true,
    baseUrl: crawl.baseUrl ?? null,
    merchantFeedSubmissionAllowed: crawl.merchantFeedSubmissionAllowed === true,
  };
}

function disabledPolicySummary(policyValue) {
  const policy = isRecord(policyValue) ? policyValue : {};
  return {
    approved: true,
    accountApprovalReference: policy.accountApprovalReference ?? null,
  };
}

function disabledDiagnosticsSummary(diagnosticsValue) {
  const diagnostics = isRecord(diagnosticsValue) ? diagnosticsValue : {};
  const totals = isRecord(diagnostics.totals) ? diagnostics.totals : {};
  return {
    approved: true,
    totals: {
      rows: integerValue(totals.rows),
      disapproved: integerValue(totals.disapproved),
    },
  };
}

function disabledSyncSummary(syncValue) {
  const sync = isRecord(syncValue) ? syncValue : {};
  return {
    approved: true,
    mode: sync.mode ?? null,
    status: sync.status ?? null,
  };
}

function environmentGateApproved(expectedMode, syncEnabled, dryRun, marketplaceIndexing, configSummary) {
  if (expectedMode === "disabled") {
    return syncEnabled !== true || dryRun !== false;
  }
  if (expectedMode === "dry-run") {
    return syncEnabled === true && dryRun === true && configSummary.allRequiredPresent;
  }
  return syncEnabled === true && dryRun === false && marketplaceIndexing === true && configSummary.allRequiredPresent;
}

function merchantConfigSummary(env) {
  const presentFields = REQUIRED_MERCHANT_CONFIG_FIELDS.filter((field) => isNonEmptyString(env[field]));
  return {
    requiredFields: REQUIRED_MERCHANT_CONFIG_FIELDS,
    presentFields,
    missingFields: REQUIRED_MERCHANT_CONFIG_FIELDS.filter((field) => !presentFields.includes(field)),
    allRequiredPresent: presentFields.length === REQUIRED_MERCHANT_CONFIG_FIELDS.length,
    targetCountry: env.GOOGLE_MERCHANT_TARGET_COUNTRY ?? null,
    contentLanguage: env.GOOGLE_MERCHANT_CONTENT_LANGUAGE ?? null,
    feedLabel: env.GOOGLE_MERCHANT_FEED_LABEL ?? null,
  };
}

function validateProductionUrl(label, value, errors, options = {}) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      errors.push(`${label} must use HTTPS.`);
    }
    if (options.requiredOrigin && url.origin !== options.requiredOrigin) {
      errors.push(`${label} must use ${options.requiredOrigin}.`);
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".local")) {
      errors.push(`${label} must not use a local host.`);
    }
  } catch {
    errors.push(`${label} must be an absolute URL.`);
  }
}

function normalizeExpectedMode(value, errors) {
  const mode = String(value ?? "dry-run").trim();
  if (!EXPECTED_MODES.has(mode)) {
    errors.push("Google Shopping expected mode must be disabled, dry-run, or live.");
    return "dry-run";
  }
  return mode;
}

function validateOptions(options) {
  const errors = [];
  if (!options.readinessReportPath) {
    errors.push("GOOGLE_SHOPPING_READINESS_REPORT or --readiness-report is required.");
  }
  return errors;
}

function readBooleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (!isNonEmptyString(value)) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
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

function isPositiveMoneyAmount(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function integerValue(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
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
