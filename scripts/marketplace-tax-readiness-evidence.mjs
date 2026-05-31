#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isIsoTimestamp, validateEvidenceReference } from "./marketplace-evidence-references.mjs";

export const MARKETPLACE_TAX_READINESS_EVIDENCE_VERSION = "marketplace-tax-readiness-evidence/v1";
const TAX_NEXUS_MEASUREMENT_QUERY_VERSION = "tax-nexus-measurement-query/v1";
const TAX_NEXUS_JURISDICTION_COUNT = 52;

export function parseTaxReadinessEvidenceArgs(argv, env = process.env) {
  return {
    nexusReportPath: readOption(argv, "--nexus-report") ?? readEnv("TAX_NEXUS_READINESS_REPORT", env),
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_TAX_READINESS_REFERENCE", env),
    owner: readOption(argv, "--owner") ?? readEnv("TAX_READINESS_OWNER", env) ?? "Tax",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    counselAccountingApprovalReference:
      readOption(argv, "--counsel-accounting-approval-reference") ??
      readEnv("TAX_COUNSEL_ACCOUNTING_APPROVAL_REFERENCE", env),
    stateByStateNexusReference:
      readOption(argv, "--state-by-state-nexus-reference") ?? readEnv("TAX_STATE_BY_STATE_NEXUS_REFERENCE", env),
    providerDecisionReference:
      readOption(argv, "--provider-decision-reference") ?? readEnv("TAX_PROVIDER_DECISION_REFERENCE", env),
    thresholdPolicyReference:
      readOption(argv, "--threshold-policy-reference") ?? readEnv("TAX_THRESHOLD_POLICY_REFERENCE", env),
    nexusMonitoringReference:
      readOption(argv, "--nexus-monitoring-reference") ?? readEnv("TAX_NEXUS_MONITORING_REFERENCE", env),
    providerBackedResolverReference:
      readOption(argv, "--provider-backed-resolver-reference") ??
      readEnv("TAX_PROVIDER_BACKED_RESOLVER_REFERENCE", env),
    providerBackedResolverComposed:
      readBooleanOption(argv, "--provider-backed-resolver-composed") ??
      readBooleanEnv("TAX_PROVIDER_BACKED_RESOLVER_COMPOSED", env) ??
      false,
  };
}

export async function readTaxNexusReadinessReport(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildTaxReadinessEvidence(input) {
  const report = normalizeTaxNexusReport(input.nexusReport);
  const taxProviderBackedQuotesRequired = report.providerBackedQuotesRequired;
  const posture = taxProviderBackedQuotesRequired ? "provider_backed_quotes_required" : "no_collection_required";
  const providerBackedResolverComposed = Boolean(input.providerBackedResolverComposed);
  const errors = [
    ...validateRequiredInputs(input),
    ...validateTaxNexusReportForLaunch(
      report,
      providerBackedResolverComposed,
      input.providerBackedResolverReference,
      input.now ?? new Date(),
    ),
  ];
  const passesTaxReadinessGate = errors.length === 0;

  return {
    schemaVersion: MARKETPLACE_TAX_READINESS_EVIDENCE_VERSION,
    approved: passesTaxReadinessGate,
    reference: input.reference,
    owner: input.owner,
    checkedAt: input.checkedAt,
    posture,
    collectionRequiredJurisdictions: report.collectionRequiredJurisdictions,
    taxProviderBackedQuotesRequired,
    providerBackedResolverComposed,
    ...(isNonEmptyString(input.providerBackedResolverReference)
      ? { providerBackedResolverReference: input.providerBackedResolverReference }
      : {}),
    counselAccountingApprovalReference: input.counselAccountingApprovalReference,
    stateByStateNexusReference: input.stateByStateNexusReference,
    providerDecisionReference: input.providerDecisionReference,
    thresholdPolicyReference: input.thresholdPolicyReference,
    nexusMonitoringReference: input.nexusMonitoringReference,
    nexusReportAsOf: report.asOf,
    sourceMeasurementReference: report.sourceMeasurementReference,
    sourceMeasurementEnvironment: report.sourceMeasurementEnvironment,
    sourceMeasurementQueryVersion: report.sourceMeasurementQueryVersion,
    sourceMeasurementCheckedAt: report.sourceMeasurementCheckedAt,
    sourceMeasurementProjectionFreshnessReference: report.sourceMeasurementProjectionFreshnessReference,
    sourceMeasurementQueryWindow: report.sourceMeasurementQueryWindow,
    sourceMeasurementJurisdictionCount: report.sourceMeasurementJurisdictionCount,
    sourceMeasurementMissingJurisdictionOrderCount: report.sourceMeasurementMissingJurisdictionOrderCount,
    sourceMeasurementUnknownJurisdictionOrderCount: report.sourceMeasurementUnknownJurisdictionOrderCount,
    sourceMeasurementRequiresManualReview: report.sourceMeasurementRequiresManualReview,
    sourceMeasurementPasses: report.sourceMeasurementPasses,
    stateByStateJurisdictionReviewCount: report.stateByStateJurisdictionReviewCount,
    providerBackedQuotesMissing: report.providerBackedQuotesMissing,
    registrationRequiredJurisdictions: report.registrationRequiredJurisdictions,
    preparationJurisdictions: report.preparationJurisdictions,
    manualReviewJurisdictions: report.manualReviewJurisdictions,
    passesTaxReadinessGate,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function runTaxReadinessEvidence(options) {
  const nexusReport = await readTaxNexusReadinessReport(options.nexusReportPath);
  return buildTaxReadinessEvidence({
    ...options,
    nexusReport,
  });
}

async function main(argv, env = process.env) {
  const options = parseTaxReadinessEvidenceArgs(argv, env);
  const optionErrors = validateTaxReadinessEvidenceOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  const evidence = await runTaxReadinessEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesTaxReadinessGate) {
    console.error("Tax readiness evidence does not satisfy the production marketplace gate.");
    return 1;
  }

  return 0;
}

function normalizeTaxNexusReport(report) {
  if (!isRecord(report)) {
    throw new Error("Tax nexus readiness report must be a JSON object.");
  }

  return {
    asOf: requireString(report.asOf, "Tax nexus readiness report asOf"),
    sourceMeasurementReference: requireString(
      report.sourceMeasurementReference,
      "Tax nexus readiness report sourceMeasurementReference",
    ),
    sourceMeasurementEnvironment: requireString(
      report.sourceMeasurementEnvironment,
      "Tax nexus readiness report sourceMeasurementEnvironment",
    ),
    sourceMeasurementQueryVersion: requireString(
      report.sourceMeasurementQueryVersion,
      "Tax nexus readiness report sourceMeasurementQueryVersion",
    ),
    sourceMeasurementCheckedAt: requireString(
      report.sourceMeasurementCheckedAt,
      "Tax nexus readiness report sourceMeasurementCheckedAt",
    ),
    sourceMeasurementProjectionFreshnessReference: requireString(
      report.sourceMeasurementProjectionFreshnessReference,
      "Tax nexus readiness report sourceMeasurementProjectionFreshnessReference",
    ),
    sourceMeasurementQueryWindow: normalizeSourceMeasurementQueryWindow(report.sourceMeasurementQueryWindow),
    sourceMeasurementJurisdictionCount: requireNonNegativeInteger(
      report.sourceMeasurementJurisdictionCount,
      "Tax nexus readiness report sourceMeasurementJurisdictionCount",
    ),
    sourceMeasurementMissingJurisdictionOrderCount: requireNonNegativeInteger(
      report.sourceMeasurementMissingJurisdictionOrderCount,
      "Tax nexus readiness report sourceMeasurementMissingJurisdictionOrderCount",
    ),
    sourceMeasurementUnknownJurisdictionOrderCount: requireNonNegativeInteger(
      report.sourceMeasurementUnknownJurisdictionOrderCount,
      "Tax nexus readiness report sourceMeasurementUnknownJurisdictionOrderCount",
    ),
    sourceMeasurementRequiresManualReview: requireBoolean(
      report.sourceMeasurementRequiresManualReview,
      "Tax nexus readiness report sourceMeasurementRequiresManualReview",
    ),
    sourceMeasurementPasses: requireBoolean(
      report.sourceMeasurementPasses,
      "Tax nexus readiness report sourceMeasurementPasses",
    ),
    stateByStateJurisdictionReviewCount: requireNonNegativeInteger(
      report.stateByStateJurisdictionReviewCount,
      "Tax nexus readiness report stateByStateJurisdictionReviewCount",
    ),
    providerBackedQuotesRequired: requireBoolean(
      report.providerBackedQuotesRequired,
      "Tax nexus readiness report providerBackedQuotesRequired",
    ),
    providerBackedQuotesMissing: requireBoolean(
      report.providerBackedQuotesMissing,
      "Tax nexus readiness report providerBackedQuotesMissing",
    ),
    collectionRequiredJurisdictions: requireStringArray(
      report.collectionRequiredJurisdictions,
      "Tax nexus readiness report collectionRequiredJurisdictions",
    ),
    registrationRequiredJurisdictions: optionalStringArray(report.registrationRequiredJurisdictions),
    preparationJurisdictions: optionalStringArray(report.preparationJurisdictions),
    manualReviewJurisdictions: optionalStringArray(report.manualReviewJurisdictions),
  };
}

function validateTaxReadinessEvidenceOptions(options) {
  const errors = [];
  if (!options.nexusReportPath) {
    errors.push("TAX_NEXUS_READINESS_REPORT or --nexus-report is required.");
  }
  return errors;
}

function validateRequiredInputs(input) {
  const errors = [];
  if (!isNonEmptyString(input.reference)) {
    errors.push("Tax readiness evidence requires --reference or PRODUCTION_TAX_READINESS_REFERENCE.");
  } else {
    validateEvidenceReference("PRODUCTION_TAX_READINESS_REFERENCE", input.reference, errors);
  }
  if (!isNonEmptyString(input.owner)) {
    errors.push("Tax readiness evidence requires an owner.");
  }
  if (!isNonEmptyString(input.checkedAt)) {
    errors.push("Tax readiness evidence requires checkedAt.");
  } else if (!isIsoTimestamp(input.checkedAt)) {
    errors.push("Tax readiness evidence checkedAt must be an ISO timestamp.");
  }
  if (!isNonEmptyString(input.counselAccountingApprovalReference)) {
    errors.push("Tax readiness evidence requires counselAccountingApprovalReference.");
  } else {
    validateEvidenceReference(
      "Tax readiness counselAccountingApprovalReference",
      input.counselAccountingApprovalReference,
      errors,
    );
  }
  if (!isNonEmptyString(input.stateByStateNexusReference)) {
    errors.push("Tax readiness evidence requires stateByStateNexusReference.");
  } else {
    validateEvidenceReference("Tax readiness stateByStateNexusReference", input.stateByStateNexusReference, errors);
  }
  if (!isNonEmptyString(input.providerDecisionReference)) {
    errors.push("Tax readiness evidence requires providerDecisionReference.");
  } else {
    validateEvidenceReference("Tax readiness providerDecisionReference", input.providerDecisionReference, errors);
  }
  if (!isNonEmptyString(input.thresholdPolicyReference)) {
    errors.push("Tax readiness evidence requires thresholdPolicyReference.");
  } else {
    validateEvidenceReference("Tax readiness thresholdPolicyReference", input.thresholdPolicyReference, errors);
  }
  if (!isNonEmptyString(input.nexusMonitoringReference)) {
    errors.push("Tax readiness evidence requires nexusMonitoringReference.");
  } else {
    validateEvidenceReference("Tax readiness nexusMonitoringReference", input.nexusMonitoringReference, errors);
  }
  return errors;
}

function validateTaxNexusReportForLaunch(report, providerBackedResolverComposed, providerBackedResolverReference, now) {
  const errors = [];
  const collectionRequiredCount = report.collectionRequiredJurisdictions.length;

  if (!isIsoTimestamp(report.asOf)) {
    errors.push("Tax nexus readiness report asOf must be an ISO timestamp.");
  } else {
    const asOf = new Date(report.asOf);
    if (asOf.getTime() > now.getTime() + 60_000) {
      errors.push("Tax nexus readiness report asOf cannot be in the future.");
    }

    const ageDays = (now.getTime() - asOf.getTime()) / 86_400_000;
    if (ageDays > 30) {
      errors.push("Tax nexus readiness report asOf cannot be older than 30 days.");
    }
  }

  if (!report.providerBackedQuotesRequired && collectionRequiredCount > 0) {
    errors.push("Tax readiness cannot use no_collection_required while collectionRequiredJurisdictions is non-empty.");
  }
  validateEvidenceReference(
    "Tax nexus readiness report sourceMeasurementReference",
    report.sourceMeasurementReference,
    errors,
  );
  validateEvidenceReference(
    "Tax nexus readiness report sourceMeasurementProjectionFreshnessReference",
    report.sourceMeasurementProjectionFreshnessReference,
    errors,
  );
  if (report.sourceMeasurementReference === TAX_NEXUS_MEASUREMENT_QUERY_VERSION) {
    errors.push(
      "Tax nexus readiness report sourceMeasurementReference must point to the production source measurement record.",
    );
  }

  if (report.sourceMeasurementEnvironment !== "production") {
    errors.push("Tax nexus readiness report sourceMeasurementEnvironment must be production.");
  }

  if (report.sourceMeasurementQueryVersion !== TAX_NEXUS_MEASUREMENT_QUERY_VERSION) {
    errors.push(
      `Tax nexus readiness report sourceMeasurementQueryVersion must be ${TAX_NEXUS_MEASUREMENT_QUERY_VERSION}.`,
    );
  }

  validateSourceMeasurementDetails(report, errors);

  if (report.providerBackedQuotesRequired && collectionRequiredCount === 0) {
    errors.push("Tax readiness provider-backed posture must list collectionRequiredJurisdictions.");
  }

  if (report.providerBackedQuotesRequired && report.providerBackedQuotesMissing) {
    errors.push("Tax readiness provider-backed posture cannot have providerBackedQuotesMissing=true.");
  }

  if (report.providerBackedQuotesRequired && !providerBackedResolverComposed) {
    errors.push("Tax readiness provider-backed posture requires providerBackedResolverComposed=true.");
  }

  if (report.providerBackedQuotesRequired) {
    if (!isNonEmptyString(providerBackedResolverReference)) {
      errors.push("Tax readiness provider-backed posture requires providerBackedResolverReference.");
    } else {
      validateEvidenceReference(
        "Tax readiness providerBackedResolverReference",
        providerBackedResolverReference,
        errors,
      );
    }
  } else if (isNonEmptyString(providerBackedResolverReference)) {
    validateEvidenceReference("Tax readiness providerBackedResolverReference", providerBackedResolverReference, errors);
  }

  return errors;
}

function validateSourceMeasurementDetails(report, errors) {
  if (!isIsoTimestamp(report.sourceMeasurementCheckedAt)) {
    errors.push("Tax nexus readiness report sourceMeasurementCheckedAt must be an ISO timestamp.");
  } else if (isIsoTimestamp(report.asOf)) {
    const sourceCheckedAt = new Date(report.sourceMeasurementCheckedAt);
    const asOf = new Date(report.asOf);
    if (sourceCheckedAt.getTime() > asOf.getTime() + 60_000) {
      errors.push("Tax nexus readiness report sourceMeasurementCheckedAt cannot be after asOf.");
    }
  }

  for (const [field, value] of Object.entries(report.sourceMeasurementQueryWindow)) {
    if (!isIsoTimestamp(value)) {
      errors.push(`Tax nexus readiness report sourceMeasurementQueryWindow.${field} must be an ISO timestamp.`);
    }
  }

  const { previousYearStart, currentYearStart, nextYearStart } = report.sourceMeasurementQueryWindow;
  if (isIsoTimestamp(previousYearStart) && isIsoTimestamp(currentYearStart)) {
    if (new Date(previousYearStart) >= new Date(currentYearStart)) {
      errors.push(
        "Tax nexus readiness report sourceMeasurementQueryWindow.previousYearStart must be before currentYearStart.",
      );
    }
  }
  if (isIsoTimestamp(currentYearStart) && isIsoTimestamp(nextYearStart)) {
    if (new Date(currentYearStart) >= new Date(nextYearStart)) {
      errors.push(
        "Tax nexus readiness report sourceMeasurementQueryWindow.currentYearStart must be before nextYearStart.",
      );
    }
  }

  if (report.sourceMeasurementJurisdictionCount !== TAX_NEXUS_JURISDICTION_COUNT) {
    errors.push(
      `Tax nexus readiness report sourceMeasurementJurisdictionCount must be ${TAX_NEXUS_JURISDICTION_COUNT}.`,
    );
  }
  if (report.sourceMeasurementMissingJurisdictionOrderCount !== 0) {
    errors.push("Tax nexus readiness report sourceMeasurementMissingJurisdictionOrderCount must be 0.");
  }
  if (report.sourceMeasurementUnknownJurisdictionOrderCount !== 0) {
    errors.push("Tax nexus readiness report sourceMeasurementUnknownJurisdictionOrderCount must be 0.");
  }
  if (report.sourceMeasurementRequiresManualReview !== false) {
    errors.push("Tax nexus readiness report sourceMeasurementRequiresManualReview must be false.");
  }
  if (report.sourceMeasurementPasses !== true) {
    errors.push("Tax nexus readiness report sourceMeasurementPasses must be true.");
  }
  if (report.stateByStateJurisdictionReviewCount < TAX_NEXUS_JURISDICTION_COUNT) {
    errors.push(
      `Tax nexus readiness report stateByStateJurisdictionReviewCount must be at least ${TAX_NEXUS_JURISDICTION_COUNT}.`,
    );
  }
}

function normalizeSourceMeasurementQueryWindow(value) {
  if (!isRecord(value)) {
    throw new Error("Tax nexus readiness report sourceMeasurementQueryWindow must be a JSON object.");
  }
  return {
    previousYearStart: requireString(
      value.previousYearStart,
      "Tax nexus readiness report sourceMeasurementQueryWindow.previousYearStart",
    ),
    currentYearStart: requireString(
      value.currentYearStart,
      "Tax nexus readiness report sourceMeasurementQueryWindow.currentYearStart",
    ),
    nextYearStart: requireString(
      value.nextYearStart,
      "Tax nexus readiness report sourceMeasurementQueryWindow.nextYearStart",
    ),
  };
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readBooleanEnv(name, env) {
  const value = readEnv(name, env);
  return parseBoolean(value);
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function readBooleanOption(argv, name) {
  const value = readOption(argv, name);
  return parseBoolean(value);
}

function parseBoolean(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`Expected boolean true or false, received ${value}.`);
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

function optionalStringArray(value) {
  if (value === undefined) {
    return [];
  }
  return requireStringArray(value, "Tax nexus readiness report optional jurisdiction list");
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
